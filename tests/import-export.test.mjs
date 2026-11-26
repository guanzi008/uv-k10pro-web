// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoWorkspace } from '../src/demo.mjs';
import { PROFILE } from '../src/core/profile.mjs';
import { MemoryWorkspace } from '../src/core/workspace.mjs';
import { patchChannelInImage, readChannel } from '../src/core/channel-codec.mjs';
import { exportProject, importProject, importNor, exportNor, parseCsv, stringifyCsv,
  exportChannelsCsv, importChannelsCsv, exportRadioCsv, importRadioCsv, exportCpsCsv, importCpsCsv, overlayConfiguration } from '../src/core/import-export.mjs';

test('project roundtrip preserves baseline, edits and sparse coverage without live authority', async () => {
  const ws = createDemoWorkspace(); ws.apply(patchChannelInImage(ws.data, 0, { name: '修改名', rx_frequency_hz: 145512500 }));
  const text = await exportProject(ws), imported = await importProject(text);
  assert.deepEqual(imported.data, ws.data); assert.deepEqual(imported.baseline, ws.baseline);
  assert.deepEqual(imported.coverage, ws.coverage); assert.equal(imported.mode, 'offline'); assert.equal(imported.sessionId, null);
  assert.equal(imported.dirtyBytes(), ws.dirtyBytes()); assert.throws(() => exportNor(imported), /伪造/);
});
test('project parser rejects changed hashes, wrong product and overlapping intervals', async () => {
  const project = JSON.parse(await exportProject(createDemoWorkspace()));
  const badHash = structuredClone(project); badHash.segments[0].sha256 = '0'.repeat(64);
  await assert.rejects(importProject(JSON.stringify(badHash)), /SHA-256/);
  const badModel = structuredClone(project); badModel.profile = 'K82';
  await assert.rejects(importProject(JSON.stringify(badModel)), /其他机型/);
  const badOverlap = structuredClone(project); badOverlap.segments[1].address = 1;
  await assert.rejects(importProject(JSON.stringify(badOverlap)), /address/);
});
test('raw imports distinguish 4 MiB capacity, partial 2 MiB and MCU firmware', () => {
  assert.equal(importNor(new Uint8Array(0x200000)).complete, false);
  const data = new Uint8Array(PROFILE.capacity), view = new DataView(data.buffer);
  assert.equal(importNor(data).complete, true); assert.equal(exportNor(importNor(data)).length, PROFILE.capacity);
  view.setUint32(0, 0x20004000, true); view.setUint32(4, 0x08002501, true);
  assert.throws(() => importNor(data), /MCU/);
  assert.throws(() => importNor(new Uint8Array(118974)), /固件更新包/);
});
test('CSV reader handles BOM, CRLF, quoted commas and embedded newlines; rejects malformed syntax', () => {
  const rows = [['a', 'b'], ['hello,"x"', 'line1\nline2']];
  assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
  assert.throws(() => parseCsv('a,b\n"x"oops,y'), /多余字符/);
  assert.throws(() => parseCsv('a,b\n"x,y'), /未闭合/);
  assert.throws(() => parseCsv('a,b\nx,y,z'), /列/);
});
test('lossless channel CSV preserves all 64 bytes and attributes, not merely visible columns', () => {
  const ws = createDemoWorkspace(); ws.data[0x23] = 0xa7;
  const exported = exportChannelsCsv(ws), result = importChannelsCsv(ws, exported);
  assert.equal(result.count, 999); assert.deepEqual(result.data, ws.data);
  const rows = parseCsv(exported); rows[1][4] = 'other';
  assert.throws(() => importChannelsCsv(ws, stringifyCsv(rows)), /不一致/);
  rows[1][0] = 'K82/v1'; assert.throws(() => importChannelsCsv(ws, stringifyCsv(rows)), /机型/);
});
test('radio CSV includes VFO, all four Si4732 banks, and does not mix BK1080 with AM banks', () => {
  const ws = createDemoWorkspace();
  const si = exportRadioCsv(ws, 'si4732'), bk = exportRadioCsv(ws, 'bk1080');
  assert.equal(parseCsv(si).length, 1 + 33 * 3 + 129); assert.equal(parseCsv(bk).length, 34);
  assert.deepEqual(importRadioCsv(ws, si).data, ws.data); assert.deepEqual(importRadioCsv(ws, bk).data, ws.data);
  const rows = parseCsv(si); rows[34][1] = 'bk1080';
  assert.throws(() => importRadioCsv(ws, stringifyCsv(rows)), /组合无效/);
});
test('CPS 22-column semantic roundtrip handles 0-based scan lists and octal DCS', () => {
  const ws = createDemoWorkspace(); ws.apply(patchChannelInImage(ws.data, 0, { rx_tone: { kind: 3, value: 0o555 }, scan_list: 31 }));
  const csv = exportCpsCsv(ws), rows = parseCsv(csv);
  assert.equal(rows[1][7], '555'); assert.equal(rows[1][11], '32'); assert.equal(rows[1][21], 'Current Channel');
  const result = importCpsCsv(ws, csv), channel = readChannel(result.data, 0);
  assert.equal(channel.rx_tone.value, 0o555); assert.equal(channel.scan_list, 31);
  assert.deepEqual(result.data, ws.data);
});
test('CPS refuses legacy 20-column, sparse/reordered rows and the SSB/CW mismatch', () => {
  const ws = createDemoWorkspace(), rows = parseCsv(exportCpsCsv(ws));
  const wrongColumns = structuredClone(rows); [wrongColumns[0][2], wrongColumns[0][3]] = [wrongColumns[0][3], wrongColumns[0][2]];
  assert.throws(() => importCpsCsv(ws, stringifyCsv(wrongColumns)), /不能重排/);
  assert.throws(() => importCpsCsv(ws, stringifyCsv(rows.slice(0, 3))), /999/);
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.throws(() => importCpsCsv(ws, stringifyCsv(rows)), /行位置/);
  assert.throws(() => importCpsCsv(ws, stringifyCsv([Array(20).fill('x')])), /20 列/);
  for (const modulation of [2, 3]) {
    ws.apply(patchChannelInImage(ws.data, 0, { modulation }));
    assert.throws(() => exportCpsCsv(ws), /SSB\/CW/);
  }
});
test('overlay restores only known writable ranges and keeps live original baseline intact', () => {
  const source = createDemoWorkspace(), target = createDemoWorkspace();
  source.data[0] ^= 1; source.data[0x17000] = 55; source.data[0x19000] = 33; source.data[0x1c008] = 66;
  source.data[0x1c100] = 77; source.data[0x45006] = 88;
  const result = overlayConfiguration(target, source);
  assert.equal(result.data[0], source.data[0]); assert.equal(result.data[0x17000], target.data[0x17000]);
  assert.equal(result.data[0x19000], target.data[0x19000]); assert.equal(result.data[0x1c008], 66);
  assert.equal(result.data[0x1c100], target.data[0x1c100]); assert.equal(result.data[0x45006], target.data[0x45006]);
  assert.notEqual(target.baseline[0], result.data[0]);
});
