// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgrammingSession } from '../src/protocol/session.mjs';
import { MockTransport } from '../src/protocol/mock-transport.mjs';
import { COMMAND } from '../src/protocol/frame.mjs';
import { derivePasswordKey, normalizePassword } from '../src/protocol/auth.mjs';

const options = { selectedModel: 'UV-K10 Pro', sessionToken: 0x12345678 };
async function connected(config = {}) {
  const transport = new MockTransport(config), session = new ProgrammingSession(transport, options);
  await session.connect(); return { session, transport };
}
const writes = transport => transport.requests.filter(r => r.command === COMMAND.WRITE);
const auths = transport => transport.requests.filter(r => r.command === COMMAND.AUTH);

test('setting a programming password on a password-free device uses ordinary write then verifies new normal AUTH', async () => {
  const { session, transport } = await connected();
  const result = await session.changeProgrammingPassword({ newPassword: 'synthetic-new', confirmPassword: 'synthetic-new' });
  assert.deepEqual(result, { verified: true, changed: true, kind: 'programming', disabled: false, reconnectRequired: true });
  assert.equal(session.state, 'closed'); assert.equal(transport.opened, false);
  assert.deepEqual(transport.memory.slice(0x18000, 0x18010), derivePasswordKey('synthetic-new'));
  assert.equal(writes(transport).length, 1); assert.equal(writes(transport)[0].flag, 0);
  assert.equal(writes(transport)[0].address, 0x18000); assert.equal(writes(transport)[0].count, 16);
  assert.equal(auths(transport).length, 1);
  assert.ok(transport.requests.indexOf(writes(transport)[0]) < transport.requests.indexOf(auths(transport)[0]));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-new|key|password/i);
});

test('replacement rechecks supplied current password even when already authenticated and preserves neighbors', async () => {
  const { session, transport } = await connected({ passwordValid: 1, password: 'synthetic-current' });
  transport.memory[0x17fff] = 0x37; transport.memory[0x18010] = 0x91;
  await session.authenticate({ password: 'synthetic-current' });
  await session.changeProgrammingPassword({ currentPassword: 'synthetic-current', newPassword: '替换口令', confirmPassword: '替换口令' });
  assert.equal(auths(transport).length, 3); // Earlier login, forced current, new-key verification.
  assert.deepEqual(transport.memory.slice(0x18000, 0x18010), derivePasswordKey('替换口令'));
  assert.equal(transport.memory[0x17fff], 0x37); assert.equal(transport.memory[0x18010], 0x91);
  assert.equal(transport.passwordValid, 1); assert.equal(session.connected, false);
});

test('clearing a programming password writes FF16 only after normal current-password authentication', async () => {
  const { session, transport } = await connected({ passwordValid: 1, password: 'synthetic-current' });
  const result = await session.changeProgrammingPassword({ currentPassword: 'synthetic-current', newPassword: '', confirmPassword: '' });
  assert.equal(result.disabled, true); assert.equal(transport.passwordValid, 0);
  assert.deepEqual(transport.memory.slice(0x18000, 0x18010), new Uint8Array(16).fill(255));
  assert.equal(auths(transport).length, 1); assert.equal(writes(transport)[0].flag, 0);
});

test('wrong current password closes session without any credential write, including after previous login', async () => {
  const { session, transport } = await connected({ passwordValid: 1, password: 'synthetic-current' });
  await session.authenticate({ password: 'synthetic-current' });
  await assert.rejects(session.changeProgrammingPassword({ currentPassword: 'wrong', newPassword: 'new', confirmPassword: 'new' }), { code: 'AUTH_REJECTED' });
  assert.equal(writes(transport).length, 0); assert.equal(auths(transport).length, 2);
  assert.deepEqual(transport.memory.slice(0x18000, 0x18010), derivePasswordKey('synthetic-current'));
  await session.close();
});

test('startup numeric code is uint32 LE, respects baseline, and disable writes FFFFFFFF', async () => {
  for (const disable of [false, true]) {
    const { session, transport } = await connected();
    transport.memory.set(Uint8Array.of(0x40, 0xe2, 1, 0), 0x17000);
    const result = await session.changeStartupPassword({ ...(disable ? { disable: true } : { password: '000007' }), expectedCurrent: 123456 });
    assert.equal(result.disabled, disable); assert.equal(result.kind, 'startup');
    assert.deepEqual(transport.memory.slice(0x17000, 0x17004), disable ? new Uint8Array(4).fill(255) : Uint8Array.of(7, 0, 0, 0));
    assert.equal(writes(transport).length, 1); assert.equal(writes(transport)[0].flag, 0); assert.equal(session.state, 'closed');
  }
});

test('startup lock and stale baseline reject before write; generic offset credential writes stay forbidden', async () => {
  const locked = await connected({ startLockFlag: 1 });
  await assert.rejects(locked.session.changeStartupPassword({ password: '123456' }), { code: 'STARTUP_PASSWORD_LOCKED' });
  assert.equal(writes(locked.transport).length, 0); await locked.session.close();
  const stale = await connected();
  await assert.rejects(stale.session.changeStartupPassword({ password: '123456', expectedCurrent: 0 }), { code: 'STALE_CREDENTIAL_BASELINE' });
  assert.equal(writes(stale.transport).length, 0);
  for (const address of [0x17000, 0x17003, 0x18000, 0x1800f, 0x18fff])
    await assert.rejects(stale.session.writeMemory(address, Uint8Array.of(0)), { code: 'PROTECTED_REGION_UNSUPPORTED' });
  await stale.session.close();
});

test('invalid confirmation, digit count, byte count and unknown firmware send no credential requests', async () => {
  const { session, transport } = await connected();
  for (const password of ['', '1234567', '-1', '1.5', '1e2', '１２３'])
    await assert.rejects(session.changeStartupPassword({ password }), { code: 'INVALID_STARTUP_PASSWORD' });
  await assert.rejects(session.changeProgrammingPassword({ newPassword: 'one', confirmPassword: 'two' }), { code: 'PASSWORD_CONFIRMATION_MISMATCH' });
  await assert.rejects(session.changeProgrammingPassword({ newPassword: '测'.repeat(11), confirmPassword: '测'.repeat(11) }), { code: 'INVALID_PASSWORD' });
  assert.equal(writes(transport).length, 0); assert.equal(auths(transport).length, 0); await session.close();
  const foreign = await connected({ firmware: 'other' });
  await assert.rejects(foreign.session.changeProgrammingPassword({ newPassword: 'new', confirmPassword: 'new' }), { code: 'UNKNOWN_DEVICE' });
  assert.equal(writes(foreign.transport).length, 0); await foreign.session.close();
  assert.equal(normalizePassword('\u0085 abc \u3000'), 'abc');
  assert.equal(normalizePassword('\ufeffabc'), '\ufeffabc');
});

test('ACK without persistence and gated readback never report successful credential changes or expose key recovery data', async () => {
  const { session, transport } = await connected(); transport.ackOnlyWrites = true;
  await assert.rejects(session.changeProgrammingPassword({ newPassword: 'new', confirmPassword: 'new' }), error => {
    assert.equal(error.code, 'CREDENTIAL_VERIFY_MISMATCH'); assert.equal(error.mayHaveModifiedDevice, true);
    assert.equal(error.recovery, undefined); assert.doesNotMatch(error.message, /new|passwordKey/); return true;
  });
  assert.equal(writes(transport).length, 1); assert.equal(auths(transport).length, 0); await session.close();
  const gated = await connected(); gated.transport.gatedReads = true;
  await assert.rejects(gated.session.changeStartupPassword({ password: '0' }), { code: 'AMBIGUOUS_READ_ACCESS' });
  assert.equal(writes(gated.transport).length, 0); await gated.session.close();
});

test('failed new-password verification stops without a rollback or another write', async () => {
  const { session, transport } = await connected({ onRequest(request, model) {
    if (request.command === COMMAND.AUTH && writes(model).length) model.passwordKey.fill(0);
  } });
  await assert.rejects(session.changeProgrammingPassword({ newPassword: 'new', confirmPassword: 'new' }), error => {
    assert.equal(error.code, 'AUTH_REJECTED'); assert.equal(error.mayHaveModifiedDevice, true); return true;
  });
  assert.equal(writes(transport).length, 1); assert.equal(auths(transport).length, 1); assert.equal(session.state, 'error');
  await session.close();
});

test('unchanged startup value closes cleanly without issuing a write', async () => {
  const { session, transport } = await connected();
  const result = await session.changeStartupPassword({ disable: true, expectedCurrent: 0xffffffff });
  assert.equal(result.changed, false); assert.equal(writes(transport).length, 0); assert.equal(session.state, 'closed');
});
