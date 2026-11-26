// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, READ_REGIONS } from '../src/core/profile.mjs';
import { MemoryWorkspace } from '../src/core/workspace.mjs';
import { patchChannelInImage, readChannel } from '../src/core/channel-codec.mjs';
import { exportProject, importProject, overlayConfiguration } from '../src/core/import-export.mjs';
import { CPS_DAT_SIZE, CPS_DAT_REGIONS, importCpsDat, exportCpsDat,
  inspectCpsDatExport, restoreCpsDatEnvelope } from '../src/core/cps-project.mjs';

function syntheticDat() {
  const data = new Uint8Array(CPS_DAT_SIZE);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13 + (i >> 8) + 37) & 255;
  // A generated arbitrary fixture, never a vendor image or real user backup.
  data.fill(255, 0, 8);
  data[0x90000] = 0xa7;
  return data;
}

test('native CPS DAT requires explicit model source confirmation and exact current size', async () => {
  const input = syntheticDat();
  await assert.rejects(importCpsDat(input), /确认/);
  await assert.rejects(importCpsDat(input, 'wrong model', { modelConfirmed: 'K82' }), /确认/);
  for (const size of [CPS_DAT_SIZE - 1, CPS_DAT_SIZE + 1, 0x200000, 0x400000])
    await assert.rejects(importCpsDat(new Uint8Array(size), 'bad', { modelConfirmed: true }), /880640/);
  const view = new DataView(input.buffer);
  view.setUint32(0, 0x20004000, true); view.setUint32(4, 0x08002501, true);
  await assert.rejects(importCpsDat(input, 'MCU', { modelConfirmed: true }), /MCU/);
});

test('native DAT roundtrips exactly while exposing only configuration coverage and no live authority', async () => {
  const input = syntheticDat();
  const ws = await importCpsDat(input, 'synthetic.dat', { modelConfirmed: true });
  assert.equal(ws.mode, 'offline'); assert.equal(ws.sessionId, null); assert.equal(ws.complete, false);
  assert.equal(ws.has(0x90000, 1), false); assert.equal(ws.has(0x18000, 1), false);
  assert.equal(ws.has(0x1b000, 1), true); assert.equal(ws.data[0x90000], 255);
  assert.equal(ws.provenance.imported_format, 'cps-0.56-dat');
  assert.deepEqual(await exportCpsDat(ws), input);
});

test('DAT import owns input before asynchronous digest and edited export preserves opaque regions', async () => {
  const input = syntheticDat(), expected = input.slice();
  const pending = importCpsDat(input, 'copy.dat', { modelConfirmed: true });
  input.fill(0);
  const ws = await pending;
  assert.deepEqual(await exportCpsDat(ws), expected);
  ws.apply(patchChannelInImage(ws.data, 0, { name: '测试名', rx_frequency_hz: 145500000,
    modulation: 0, offset_direction: 0 }, { attribute: 2 }));
  const exported = await exportCpsDat(ws);
  assert.equal(readChannel(ws.data, 0).name, '测试名');
  assert.equal(exported[0x90000], 0xa7); assert.equal(exported[0x18010], expected[0x18010]);
  for (let i = 64; i < exported.length; i++)
    if (i !== 0x11000) assert.equal(exported[i], expected[i], `unexpected change at ${i.toString(16)}`);
});

test('new DAT serializes known configuration into an FF container and refuses incomplete exports', async () => {
  const data = new Uint8Array(PROFILE.capacity).fill(0xa5);
  const ws = new MemoryWorkspace({ data, coverage: CPS_DAT_REGIONS, mode: 'offline' });
  const output = await exportCpsDat(ws);
  assert.equal(output.length, CPS_DAT_SIZE);
  assert.equal(output[0], 0xa5); assert.equal(output[0x1b000], 0xa5);
  assert.equal(output[0x18010], 255); assert.equal(output[0x90000], 255);
  assert.match(inspectCpsDatExport(ws).warnings.join('\n'), /非配置填充区/);
  const partial = new MemoryWorkspace({ data, coverage: CPS_DAT_REGIONS.filter(r => r.id !== 'power_flag') });
  assert.deepEqual(inspectCpsDatExport(partial).missing.map(r => r.id), ['power_flag']);
  await assert.rejects(exportCpsDat(partial), /0x1b000/);
});

test('bounded DAT envelope survives project JSON and verifies hashes without accepting identity metadata', async () => {
  const original = syntheticDat();
  const ws = await importCpsDat(original, 'fixture.dat', { modelConfirmed: true });
  const project = JSON.parse(await exportProject(ws));
  const restored = await restoreCpsDatEnvelope({ ...project.provenance, sessionId: 'forged', authenticated: true });
  assert.deepEqual(Object.keys(restored), ['cps_dat_original']);
  assert.deepEqual(restored.cps_dat_original, ws.provenance.cps_dat_original);
  assert.deepEqual(await restoreCpsDatEnvelope({ imported_format: 'raw-nor' }), {});
  const broken = structuredClone(project.provenance); broken.cps_dat_original.sha256 = '0'.repeat(64);
  await assert.rejects(restoreCpsDatEnvelope(broken), /SHA-256/);
  const oversized = structuredClone(project.provenance); oversized.cps_dat_original.base64 += 'AAAA';
  await assert.rejects(restoreCpsDatEnvelope(oversized), /长度/);
  const wrongType = structuredClone(project.provenance); wrongType.cps_dat_original.bytes = PROFILE.capacity;
  await assert.rejects(restoreCpsDatEnvelope(wrongType), /元数据/);
});

test('DAT reports CPS versus stock mode mismatch without remapping stored modulation bytes', async () => {
  const input = new Uint8Array(CPS_DAT_SIZE).fill(255);
  input[0x11000] = 2; input[0x15] = 2;
  const ws = await importCpsDat(input, 'mode.dat', { modelConfirmed: true });
  assert.match(inspectCpsDatExport(ws).warnings.join('\n'), /1 个信道/);
  const output = await exportCpsDat(ws);
  assert.equal(output[0x15], 2);
});

test('DAT to edited k10 to DAT retains opaque file bytes and never restores a claimed live session', async () => {
  const original = syntheticDat();
  const imported = await importCpsDat(original, 'roundtrip.dat', { modelConfirmed: true });
  imported.apply(patchChannelInImage(imported.data, 0, { name: '轮转', modulation: 0 }, { attribute: 2 }));
  const expected = await exportCpsDat(imported);
  const json = JSON.parse(await exportProject(imported));
  json.source = 'device'; json.sessionId = 'forged-session';
  json.provenance.authenticated = true; json.provenance.sessionId = 'forged-session';
  const restored = await importProject(JSON.stringify(json), 'roundtrip.k10');
  assert.deepEqual(restored.data, imported.data); assert.deepEqual(restored.baseline, imported.baseline);
  assert.equal(restored.mode, 'offline'); assert.equal(restored.sessionId, null);
  assert.equal(restored.provenance.authenticated, undefined);
  assert.equal(restored.provenance.sessionId, undefined);
  assert.equal(restored.has(0x90000, 1), false); assert.equal(restored.has(0x18000, 1), false);
  assert.deepEqual(await exportCpsDat(restored), expected);
  assert.equal((await exportCpsDat(restored))[0x90000], original[0x90000]);
  const bad = structuredClone(json); bad.provenance.cps_dat_original.sha256 = '0'.repeat(64);
  await assert.rejects(importProject(JSON.stringify(bad)), /DAT SHA-256/);
});

test('merging DAT into a live workspace excludes credentials, readonly device fields and reserved tails', async () => {
  const original = syntheticDat();
  const source = await importCpsDat(original, 'overlay.dat', { modelConfirmed: true });
  const live = new MemoryWorkspace({ data: new Uint8Array(PROFILE.capacity).fill(0x9b),
    mode: 'device', sessionId: 'live-session', coverage: READ_REGIONS });
  const merged = overlayConfiguration(live, source);
  for (const address of [0x17000, 0x17003, 0x18000, 0x1800f, 0x1b000,
    0x19000, 0x19002, 0x19003, 0x1900b, 0x190a0, 0x190a5,
    0x1c004, 0x1c007, 0x1c0a0, 0x1c10f, 0x45006, 0x45007])
    assert.equal(merged.data[address], 0x9b, `readonly or reserved address ${address.toString(16)}`);
  assert.equal(merged.data[0x18], original[0x18]);
  assert.equal(merged.data[0x19001], original[0x19001]);
  assert.equal(merged.data[0x1900a], original[0x1900a]);
  assert.equal(live.sessionId, 'live-session');
  assert.equal(live.baseline[0x18], 0x9b, 'Overlay must not replace the device baseline');
});
