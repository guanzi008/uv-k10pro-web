// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, READ_REGIONS, isWritableRange } from '../src/core/profile.mjs';
import { MemoryWorkspace, normalizeCoverage, covers, executeWritePlan } from '../src/core/workspace.mjs';
import { createDemoWorkspace } from '../src/demo.mjs';
import { ProgrammingSession, MockTransport } from '../src/protocol/index.mjs';

function liveWorkspace(data) { return new MemoryWorkspace({ mode: 'device', data, coverage: READ_REGIONS, sessionId: 'test-live' }); }
test('coverage normalizes adjacent ranges but never fills unread holes', () => {
  const ranges = normalizeCoverage([{ address: 20, length: 4 }, { address: 0, length: 5 }, { address: 5, length: 5 }]);
  assert.deepEqual(ranges, [{ address: 0, length: 10 }, { address: 20, length: 4 }]);
  assert.equal(covers(ranges, 9, 2), false);
  assert.throws(() => normalizeCoverage([{ address: 0x3fffff, length: 2 }]), /length/);
});
test('synthetic demo is internally valid but never a full dump or trusted live workspace', () => {
  const demo = createDemoWorkspace();
  assert.equal(demo.mode, 'demo'); assert.equal(demo.complete, false); assert.equal(demo.sessionId, null);
  assert.equal(demo.dirtyBytes(), 0); assert.ok(demo.loadedBytes > 90000);
  const edited = demo.data.slice(); edited[0x40000] = 17;
  assert.throws(() => demo.apply(edited), /unread/);
});
test('write plan isolates exact diffs, splits at 128 bytes, and rejects unresolved storage', () => {
  const demo = createDemoWorkspace(), changed = demo.data.slice(); changed.fill(0x81, 100, 500);
  demo.apply(changed); const plan = demo.planWrites();
  assert.equal(plan.bytes, 400); assert.ok(plan.blocks.every(b => b.length <= 128));
  const bad = demo.data.slice(); bad[0x17000] ^= 1; demo.apply(bad);
  assert.throws(() => demo.planWrites(), /尚未验证/);
});
test('imported provenance or a forged session id cannot confer device write permission', async () => {
  const ws = createDemoWorkspace(); ws.data[5] ^= 1; ws.sessionId = 'test-live';
  const plan = ws.planWrites();
  await assert.rejects(executeWritePlan(ws, { identity: { writeEnabled: true } }, 'test-live', plan), /先读取/);
});
test('preflight checks every changed block before the first write and detects stale data', async () => {
  const ws = liveWorkspace(createDemoWorkspace().data); const next = ws.data.slice(); next[0] ^= 1; next[256] ^= 1; ws.apply(next);
  const events = []; const session = { identity: { writeEnabled: true },
    async readMemory(address, length) { events.push(['read', address]); return address === 256 ? Uint8Array.of(77) : ws.baseline.slice(address, address + length); },
    async writeMemory() { events.push(['write']); return { verified: true }; } };
  await assert.rejects(executeWritePlan(ws, session, 'test-live', ws.planWrites()), /设备数据已变化/);
  assert.deepEqual(events, [['read', 0], ['read', 256]]);
  assert.equal(ws.uncertain, false);
});
test('write journal preserves verified progress and marks the failed block uncertain', async () => {
  const ws = liveWorkspace(createDemoWorkspace().data), next = ws.data.slice(); next[0] ^= 1; next[256] ^= 1; ws.apply(next);
  let persisted = false, calls = 0;
  const session = { identity: { writeEnabled: true }, async readMemory(a, n) { return ws.baseline.slice(a, a + n); },
    async writeMemory() { assert.equal(persisted, true); if (++calls === 2) throw new Error('disconnect'); return { verified: true }; } };
  await assert.rejects(executeWritePlan(ws, session, 'test-live', ws.planWrites(), { onBackup: async () => { persisted = true; } }), /disconnect/);
  assert.equal(ws.baseline[0], next[0]); assert.notEqual(ws.baseline[256], next[256]);
  assert.deepEqual(ws.journal.map(x => x.status), ['verified', 'uncertain']);
  assert.equal(ws.uncertain, true); assert.throws(() => ws.planWrites(), /不确定/);
});
test('workspace pipeline performs actual framed mock-session writes and preserves all untouched storage', async () => {
  const original = createDemoWorkspace().data, ws = liveWorkspace(original), next = ws.data.slice();
  next[0x18] = 65; next[0x12108] ^= 1; next[0x1e003] = 7; ws.apply(next);
  const transport = new MockTransport({ memory: original.slice() });
  const session = new ProgrammingSession(transport, { selectedModel: 'UV-K10 Pro', timeoutMs: 500 });
  try {
    await session.connect();
    const result = await executeWritePlan(ws, session, 'test-live', ws.planWrites());
    assert.equal(result.verified, true); assert.equal(ws.dirtyBytes(), 0);
    assert.deepEqual(transport.memory, next);
  } finally { await session.close(); }
});
test('backup persistence rejection prevents every write', async () => {
  const ws = liveWorkspace(createDemoWorkspace().data); ws.data[0] ^= 1;
  let writes = 0;
  const session = { identity: { writeEnabled: true }, async readMemory(a,n) { return ws.baseline.slice(a,a+n); },
    async writeMemory() { writes++; return { verified: true }; } };
  await assert.rejects(executeWritePlan(ws, session, 'test-live', ws.planWrites(), { onBackup: async () => { throw new Error('quota'); } }), /quota/);
  assert.equal(writes, 0);
});

test('band write policy permits proven fields but forbids adjacent padding, identity and group tails', () => {
  assert.equal(isWritableRange(0x19008, 2), true);
  assert.equal(isWritableRange(0x19010, 7), true);
  assert.equal(isWritableRange(0x19017, 1), false);
  assert.equal(isWritableRange(0x19000, 1), false);
  assert.equal(isWritableRange(0x1c008, 15), true); // name plus adjacent RX flags
  assert.equal(isWritableRange(0x1c0a0, 112), false);
  assert.equal(isWritableRange(0x45006, 2), false);
});
