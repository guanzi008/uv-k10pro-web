// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computePasswordDigest, derivePasswordKey, deriveAuthenticationResponse, ProgrammingSession, MockTransport, COMMAND } from '../src/protocol/index.mjs';

const evidence = JSON.parse(await readFile(new URL('./fixtures/auth-vectors.json', import.meta.url), 'utf8'));
const hex = value => Buffer.from(value).toString('hex');
const options = { selectedModel: 'UV-K10 Pro', sessionToken: 0x12345678 };
test('six normal password vectors match actual x86 native MAC and stock ARM positive/negative AES verification', async () => {
  assert.equal(evidence.hostVendorExecution, false); assert.equal(evidence.dllMainCalled, false);
  for (const vector of evidence.vectors) {
    assert.equal(hex(computePasswordDigest(vector.password)), vector.digestHex);
    assert.equal(hex(derivePasswordKey(vector.password)), vector.keyHex);
    assert.equal(hex(await deriveAuthenticationResponse(vector.password, Buffer.from(vector.challengeHex, 'hex'))), vector.responseHex);
    assert.equal(vector.stockCompare.valid, 0); assert.equal(vector.stockCompare.corrupt, 1);
    assert.equal(vector.stockCompare.hardwareHooks, 0);
    assert.equal(vector.stockNormalAuth.secondaryGate, 0); assert.equal(vector.stockNormalAuth.replyBodyHex, 'd602040000000000');
  }
});
test('correct supplied password enables reads/writes only after matching AUTH response', async () => {
  const transport = new MockTransport({ passwordValid: 1, password: 'test-password' });
  const session = new ProgrammingSession(transport, options); await session.connect();
  assert.equal(session.writeEnabled, false); assert.equal(session.identity.authenticated, false);
  await assert.rejects(session.readMemory(0, 1), { code: 'AUTH_REQUIRED' });
  const identity = await session.authenticate({ password: 'test-password' });
  assert.equal(identity.passwordValid, 1); assert.equal(identity.authenticated, true); assert.equal(identity.writeEnabled, true);
  assert.deepEqual(await session.readMemory(0, 1), Uint8Array.of(255));
  assert.equal((await session.writeMemory(0x12000, Uint8Array.of(9))).verified, true);
  assert.equal(transport.requests.filter(r => r.command === COMMAND.AUTH).length, 1); await session.close();
});
test('incorrect password is rejected once, closes the session, and never schedules a write', async () => {
  const transport = new MockTransport({ passwordValid: 1, password: 'test-password' });
  const session = new ProgrammingSession(transport, options); await session.connect();
  await assert.rejects(session.authenticate({ password: 'wrong-password' }), { code: 'AUTH_REJECTED' });
  assert.equal(session.state, 'error'); assert.equal(session.identity.authenticated, false);
  assert.equal(transport.requests.filter(r => r.command === COMMAND.AUTH).length, 1);
  await assert.rejects(session.writeMemory(0x12000, Uint8Array.of(1)), { code: 'NOT_CONNECTED' }); await session.close();
});
test('invalid password/challenge are rejected locally, unknown profile is not authenticated', async () => {
  assert.throws(() => derivePasswordKey('测'.repeat(11)), { code: 'INVALID_PASSWORD' });
  await assert.rejects(deriveAuthenticationResponse('known', new Uint8Array(15)), { code: 'INVALID_CHALLENGE' });
  await assert.rejects(deriveAuthenticationResponse('known', new Uint8Array(16), { subtle: null }), { code: 'CRYPTO_UNAVAILABLE' });
  const transport = new MockTransport({ firmware: 'unknown', passwordValid: 1 });
  const session = new ProgrammingSession(transport, options); await session.connect();
  await assert.rejects(session.authenticate({ password: 'known' }), { code: 'UNKNOWN_DEVICE' });
  assert.equal(transport.requests.filter(r => r.command === COMMAND.AUTH).length, 0); await session.close();
});
