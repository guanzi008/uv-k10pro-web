// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyChannels, pasteChannels, moveChannels, sortChannels, reorderChannels,
  batchPatchChannels, generateChannels } from '../src/core/channel-tools.mjs';
import { MemoryWorkspace, executeWritePlan } from '../src/core/workspace.mjs';
import { READ_REGIONS } from '../src/core/profile.mjs';
import { readChannel, patchChannelInImage, readScanList } from '../src/core/channel-codec.mjs';
import { createDemoWorkspace } from '../src/demo.mjs';

const raw = (image, index) => image.slice(index * 64, (index + 1) * 64);
const attr = (image, index) => image[0x11000 + index];

test('overlapping copy uses captured records and leaves source-only slots unchanged', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  const clipboard = copyChannels(ws, [2, 0, 1]);
  const output = pasteChannels(ws, clipboard, 1);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(raw(output, i + 1), raw(before, i));
    assert.equal(attr(output, i + 1), attr(before, i));
  }
  assert.deepEqual(raw(output, 0), raw(before, 0));
  assert.deepEqual(ws.data, before);
  output[64] ^= 1;
  assert.deepEqual(clipboard.records[0].raw, raw(before, 0));
});

test('overlapping cut erases only non-destination source attributes', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  const output = pasteChannels(ws, copyChannels(ws, [0, 1, 2], { cut: true }), 1);
  assert.equal(attr(output, 0), 255);
  assert.deepEqual(raw(output, 0), raw(before, 0));
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(raw(output, i + 1), raw(before, i));
    assert.equal(attr(output, i + 1), attr(before, i));
  }
  assert.deepEqual(output.subarray(4 * 64, 0x11000), before.subarray(4 * 64, 0x11000));
  assert.deepEqual(ws.data, before);
});

test('cut checks source identity and current bytes, while copied snapshots remain reusable', () => {
  const ws = createDemoWorkspace(), other = createDemoWorkspace();
  const cut = copyChannels(ws, [0], { cut: true }), copied = copyChannels(ws, [0]);
  assert.throws(() => pasteChannels(other, cut, 5), /工作区/);
  ws.apply(patchChannelInImage(ws.data, 0, { name: '改变' }));
  const changed = ws.data.slice();
  assert.throws(() => pasteChannels(ws, cut, 5), /已修改/);
  assert.deepEqual(ws.data, changed);
  assert.deepEqual(raw(pasteChannels(ws, copied, 5), 5), copied.records[0].raw);
  ws.undo();
  assert.deepEqual(raw(pasteChannels(ws, cut, 5), 5), cut.records[0].raw);
});

test('invalid paste bounds, duplicates and unloaded destinations fail before applying any edit', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  assert.throws(() => copyChannels(ws, [0, 0]), /重复/);
  assert.throws(() => pasteChannels(ws, copyChannels(ws, [0, 1]), 998), /999/);
  const partial = new MemoryWorkspace({ data: before, coverage: [{ address: 0, length: 64 }, { address: 0x11000, length: 1 }] });
  assert.throws(() => pasteChannels(partial, copyChannels(ws, [0]), 1), /未读取/);
  assert.deepEqual(ws.data, before);
  assert.equal(ws.undoStack.length, 0);
});

test('move is a complete record permutation and optionally remaps scan priorities and members', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  const output = moveChannels(ws, [0, 1], 4, { updateScanLists: true });
  const order = [2, 3, 0, 1];
  order.forEach((source, destination) => assert.deepEqual(raw(output, destination), raw(before, source)));
  assert.deepEqual(raw(output, 4), raw(before, 4));
  const scan = readScanList(output, 0);
  assert.deepEqual(scan.members, [2, 3, 0, 1, 4, 5]);
  assert.deepEqual(scan.priorities, [2, 0xffff]);
  assert.deepEqual(output.subarray(0x13000, 0x13010), before.subarray(0x13000, 0x13010));
  const fixedReferences = moveChannels(ws, [0, 1], 4, { updateScanLists: false });
  assert.deepEqual(fixedReferences.subarray(0x16000, 0x17000), before.subarray(0x16000, 0x17000));
});

test('scan remapping preserves empty holes, unknown member words, sentinels and reserved bytes', () => {
  const ws = createDemoWorkspace();
  const dv = new DataView(ws.data.buffer);
  dv.setUint16(0x16018, 0, true);
  dv.setUint16(0x1601a, 0xffff, true);
  dv.setUint16(0x1601c, 2, true);
  dv.setUint16(0x1601e, 0xa5a5, true);
  dv.setUint16(0x16010, 0x5a5a, true);
  ws.data[0x1600f] = 0x91; ws.data[0x1607f] = 0x38;
  const before = ws.data.slice();
  const output = moveChannels(ws, [0], 3, { updateScanLists: true }), changed = new DataView(output.buffer);
  assert.equal(changed.getUint16(0x16018, true), 2);
  assert.equal(changed.getUint16(0x1601a, true), 0xffff);
  assert.equal(changed.getUint16(0x1601c, true), 1);
  assert.equal(changed.getUint16(0x1601e, true), 0xa5a5);
  assert.equal(changed.getUint16(0x16010, true), 0x5a5a);
  assert.equal(output[0x1600f], 0x91);
  assert.equal(output[0x1607f], 0x38);
  assert.deepEqual(ws.data, before);
});

test('sorting a subset is stable, keeps deleted entries last, and preserves other records', () => {
  const ws = createDemoWorkspace();
  ws.data = patchChannelInImage(ws.data, 0, { rx_frequency_hz: 150000000 });
  ws.data = patchChannelInImage(ws.data, 1, { rx_frequency_hz: 145000000 });
  ws.data = patchChannelInImage(ws.data, 2, { rx_frequency_hz: 145000000 });
  const before = ws.data.slice();
  const sorted = sortChannels(ws, [0, 1, 2, 20]);
  [1, 2, 0, 20].forEach((source, index) => assert.deepEqual(raw(sorted, [0, 1, 2, 20][index]), raw(before, source)));
  assert.deepEqual(raw(sorted, 3), raw(before, 3));
  assert.equal(attr(sorted, 20), 255);
  const reverse = sortChannels(ws, [0, 1, 2, 20], { descending: true });
  assert.deepEqual(raw(reverse, 0), raw(before, 0));
  assert.deepEqual(raw(reverse, 1), raw(before, 1));
  assert.deepEqual(raw(reverse, 2), raw(before, 2));
  assert.equal(attr(reverse, 20), 255);
  assert.throws(() => reorderChannels(ws, Array.from({ length: 999 }, () => 0)), /不重复/);
});

test('batch parameters preserve names, frequencies, attributes and unknown bytes atomically', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  const output = batchPatchChannels(ws, [0, 2], { power: 2, squelch: 7, tx_tone: { kind: 1, value: 885 } });
  for (const index of [0, 2]) {
    const c = readChannel(output, index);
    assert.equal(c.fields.power, 2); assert.equal(c.fields.squelch, 7); assert.equal(c.tx_tone.value, 885);
    assert.deepEqual(raw(output, index).subarray(0, 8), raw(before, index).subarray(0, 8));
    assert.deepEqual(raw(output, index).subarray(0x18, 0x28), raw(before, index).subarray(0x18, 0x28));
    assert.equal(attr(output, index), attr(before, index));
  }
  assert.deepEqual(raw(output, 1), raw(before, 1));
  assert.throws(() => batchPatchChannels(ws, [0, 20], { power: 1 }), /已启用/);
  assert.throws(() => batchPatchChannels(ws, [0, 1], { power: 3 }), /Invalid/);
  assert.throws(() => batchPatchChannels(ws, [0], { name: 'renamed' }), /名称/);
  assert.deepEqual(ws.data, before);
});

test('generation derives each band attribute, honors negative offset and snapshots an overlapping template', () => {
  const ws = createDemoWorkspace();
  ws.data[0x11000] = 0xa2;
  ws.data[63] = 0x7d;
  const before = ws.data.slice();
  const output = generateChannels(ws, { startIndex: 0, count: 3, rxStartHz: 430000000, stepHz: 12500,
    txOffsetHz: -600000, templateIndex: 0, namePrefix: '组' });
  for (let i = 0; i < 3; i++) {
    const c = readChannel(output, i);
    assert.equal(c.rx_frequency_hz, 430000000 + 12500 * i);
    assert.equal(c.derived_tx_frequency_hz_before_reverse, 429400000 + 12500 * i);
    assert.equal(c.name, `组${i + 1}`);
    assert.equal(attr(output, i), 0xa5);
    assert.equal(output[(i + 1) * 64 - 1], 0x7d);
  }
  assert.deepEqual(raw(output, 3), raw(before, 3));
  assert.deepEqual(ws.data, before);
});

test('generation fails atomically for later invalid frequencies, missing plans and overlong names', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  const spec = { startIndex: 20, count: 3, rxStartHz: 575000000, stepHz: 5000000, templateIndex: 0 };
  assert.throws(() => generateChannels(ws, spec), /生成的接收频率/);
  assert.throws(() => generateChannels(ws, { ...spec, rxStartHz: 75000000, stepHz: 1000000 }), /频段|range|band/);
  assert.throws(() => generateChannels(ws, { ...spec, rxStartHz: 145000000, stepHz: 12500, namePrefix: '长'.repeat(5) }), /maximum|bytes/);
  const partial = new MemoryWorkspace({ data: before, coverage: [{ address: 0, length: 999 * 64 }, { address: 0x11000, length: 1024 }] });
  assert.throws(() => generateChannels(partial, { ...spec, rxStartHz: 145000000, stepHz: 12500 }), /未读取/);
  assert.deepEqual(ws.data, before);
  assert.equal(ws.undoStack.length, 0);
});

test('undo and redo restore bytes, invalidate old write plans, and branch on a new edit', () => {
  const ws = createDemoWorkspace(), before = ws.data.slice();
  ws.apply(batchPatchChannels(ws, [0], { power: 2 }));
  const first = ws.data.slice(), planRevision = ws.revision;
  ws.apply(batchPatchChannels(ws, [0], { squelch: 8 }));
  const second = ws.data.slice();
  assert.equal(ws.undo(), true); assert.deepEqual(ws.data, first);
  assert.equal(ws.redo(), true); assert.deepEqual(ws.data, second);
  assert.ok(ws.revision > planRevision);
  ws.undo(); ws.undo(); assert.deepEqual(ws.data, before); assert.equal(ws.undo(), false);
  ws.redo();
  ws.apply(batchPatchChannels(ws, [0], { squelch: 9 }));
  assert.equal(ws.redo(), false);
  ws.discard(); assert.deepEqual(ws.data, ws.baseline);
  assert.equal(ws.undo(), true); assert.equal(readChannel(ws.data, 0).fields.squelch, 9);
});

test('device commit clears local undo history while failed backup retains reversible edits', async () => {
  const ws = new MemoryWorkspace({ data: createDemoWorkspace().data, coverage: READ_REGIONS, mode: 'device', sessionId: 'edit-test' });
  ws.apply(batchPatchChannels(ws, [0], { power: 2 }));
  const device = ws.baseline.slice();
  let writes = 0;
  const session = { identity: { writeEnabled: true },
    async readMemory(address, length) { return device.slice(address, address + length); },
    async writeMemory(address, data) { writes++; device.set(data, address); return { verified: true }; } };
  await assert.rejects(executeWritePlan(ws, session, 'edit-test', ws.planWrites(), {
    onBackup: async () => { throw new Error('quota reached'); } }), /quota/);
  assert.equal(writes, 0); assert.equal(ws.undoStack.length, 1);
  await executeWritePlan(ws, session, 'edit-test', ws.planWrites());
  assert.ok(writes > 0);
  assert.equal(ws.dirtyBytes(), 0); assert.equal(ws.undo(), false); assert.equal(ws.redo(), false);
  assert.deepEqual(ws.data, device);
});
