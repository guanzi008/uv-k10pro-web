// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND, FLASH_LIMIT, crc16X25, xorPayload, encodeMessage, parseMessage,
  encodeFrame, decodeFrame, FrameStreamParser, buildRead, buildWrite, buildHello,
  ProgrammingSession, MockTransport, ByteQueue, WebUsbTransport, WebBluetoothTransport } from '../src/protocol/index.mjs';

const hex = value => Buffer.from(value).toString('hex');
const unhex = value => Uint8Array.from(Buffer.from(value, 'hex'));
const opts = { selectedModel: 'UV-K10 Pro', sessionToken: 0x12345678, timeoutMs: 100 };
async function connected(transport = new MockTransport(), options = {}) {
  const session = new ProgrammingSession(transport, { ...opts, ...options });
  await session.connect({ utcSeconds: 1700000000 }); return { session, transport };
}

test('CRC16/X25 check vector and XOR involution', () => {
  assert.equal(crc16X25(new TextEncoder().encode('123456789')), 0x906e);
  const bytes = Uint8Array.from({ length: 257 }, (_, i) => i); assert.deepEqual(xorPayload(xorPayload(bytes)), bytes);
});
test('actual stock sender fixtures: placeholder is explicitly not verified CRC', () => {
  const body = unhex('c602040000100000');
  for (const [wireMode, responseChecksum, fixture] of [
    ['plain', 'placeholder', 'abcd0800c602040000100000ffffdcba'],
    ['xor', 'placeholder', 'abcd0800d06e10e62e810d40decadcba'],
    ['plain', 'crc16-x25', 'abcd0800c6020400001000005392dcba'],
  ]) {
    const profile = { direction: 'response', wireMode, responseChecksum };
    assert.equal(hex(encodeFrame(body, profile)), fixture);
    assert.equal(decodeFrame(unhex(fixture), profile).crcVerified, responseChecksum === 'crc16-x25');
  }
});
test('independent Python codec golden vectors preserve CPS legacy lengths', () => {
  const profile = { wireMode: 'xor' };
  assert.equal(hex(encodeFrame(buildRead(0x12100, 4, 0x12345678), profile)), 'abcd1000d56e18e62eb00c402535d5406b55dd9213e2dcba');
  assert.equal(hex(encodeFrame(buildHello(0x12345678, 1700000000), profile)), 'abcd1c00aa6e10e656c7395221c486251303e980166c14e62e910d402135d5400162dcba');
  const write = buildWrite(0x12100, Uint8Array.of(1, 2, 3, 4), 0x12345678);
  assert.equal(write.length, 144); assert.equal(parseMessage(write).declaredLength, 12);
  assert.equal(parseMessage(write).lengthConvention, 'cps-0.56-fixed-128');
  assert.equal(hex(encodeFrame(write, profile)).slice(-8), 'b4b7dcba');
});
test('parser accepts every possible frame split and multiple frames with noise', () => {
  const wire = unhex('abcd0800d06e10e62e810d40decadcba');
  for (let split = 0; split <= wire.length; split++) {
    const parser = new FrameStreamParser({ direction: 'response', wireMode: 'xor' });
    const messages = [...parser.push(wire.subarray(0, split)), ...parser.push(wire.subarray(split))];
    assert.equal(messages.length, 1); assert.equal(messages[0].command, COMMAND.WRITE_REPLY); assert.equal(parser.bufferedBytes, 0);
  }
  const parser = new FrameStreamParser({ direction: 'response', wireMode: 'xor' });
  assert.equal(parser.push(Uint8Array.from([1, 2, 0xab, ...wire, ...wire, 3])).length, 2);
  assert.equal(parser.discardedBytes, 4);
});
test('malformed length, corrupt checksum, truncated request, and noise do not grow parser indefinitely', () => {
  const errors = [], parser = new FrameStreamParser({ onError: error => errors.push(error) });
  parser.push(new Uint8Array(100000).fill(0xab)); assert.ok(parser.bufferedBytes <= 1);
  parser.push(unhex('abcdffff')); assert.ok(errors.some(e => e.code === 'BAD_LENGTH'));
  const wire = encodeFrame(buildRead(0, 1, 1)); wire[5] ^= 1;
  assert.throws(() => decodeFrame(wire), { code: 'BAD_CHECKSUM' });
  const bad = buildWrite(0, Uint8Array.of(1), 1); bad[8] = 129;
  assert.throws(() => parseMessage(bad), { code: 'BAD_LENGTH' });
  assert.throws(() => buildRead(FLASH_LIMIT - 1, 2, 1), { code: 'INVALID_INTERVAL' });
  assert.throws(() => buildWrite(0, new Uint8Array(129), 1), { code: 'INVALID_INTERVAL' });
  assert.throws(() => buildRead(0, 0, 1), { code: 'INVALID_INTERVAL' });
});
test('session receives fragmented hello, preserves RTC semantics, and serializes whole operations', async () => {
  const { session, transport } = await connected();
  try {
    assert.equal(session.identity.firmware, '8.02.16'); assert.equal(session.writeEnabled, true);
    assert.equal(transport.rtc, 1700000000); assert.equal(session.identity.modelReportedByDevice, null);
    const [first, second] = await Promise.all([session.readMemory(0, 300), session.readMemory(1000, 10)]);
    assert.equal(first.length, 300); assert.equal(second.length, 10);
    assert.deepEqual(transport.requests.filter(r => r.command === COMMAND.READ).map(r => r.address), [0, 128, 256, 1000]);
  } finally { await session.close(); }
});
test('unknown product/version/parameter state cannot be opted into writing through expectedFirmware', async () => {
  for (const [transportOptions, sessionOptions] of [
    [{ firmware: '9.99.99' }, { expectedFirmware: '9.99.99' }],
    [{ paramsVersion: 1 }, { expectedParamsVersion: 1 }],
    [{}, { selectedModel: 'UV-K5' }], [{}, { selectedModel: undefined }],
  ]) {
    const { session, transport } = await connected(new MockTransport(transportOptions), sessionOptions);
    assert.equal(session.writeEnabled, false);
    await assert.rejects(session.writeMemory(0x12000, Uint8Array.of(4)), { code: 'UNKNOWN_DEVICE' });
    assert.equal(transport.requests.filter(r => r.command === COMMAND.WRITE).length, 0); await session.close();
  }
});
test('password state blocks reads and writes instead of trusting zero-filled replies', async () => {
  for (const profile of [{ passwordValid: 1 }, { passwordValid: 2 }]) {
    const { session } = await connected(new MockTransport(profile));
    await assert.rejects(session.readMemory(0, 1), { code: 'AUTH_REQUIRED' });
    await assert.rejects(session.writeMemory(0, Uint8Array.of(1)), { code: 'AUTH_REQUIRED' }); await session.close();
  }
});
test('startLock is a protected-block flag; protected blocks cannot be written at an offset', async () => {
  const { session, transport } = await connected(new MockTransport({ startLockFlag: 1 }));
  assert.equal(session.identity.authenticationSupported, true); assert.equal(session.writeEnabled, true);
  assert.deepEqual(await session.readMemory(0, 2), Uint8Array.of(255, 255));
  await assert.rejects(session.writeMemory(0x17001, Uint8Array.of(1)), { code: 'PROTECTED_REGION_UNSUPPORTED' });
  assert.equal(transport.requests.filter(r => r.command === COMMAND.WRITE).length, 0); await session.close();
});
test('ACKed write must read back, with a complete backup before the first mutation', async () => {
  const { session, transport } = await connected(); let backupSeen = false;
  transport.onRequest = request => { if (request.command === COMMAND.WRITE) assert.equal(backupSeen, true); };
  const wanted = Uint8Array.from({ length: 300 }, (_, i) => i & 255), beforeNeighbor = transport.memory[0x11fff];
  const result = await session.writeMemory(0x12000, wanted, { onBackup: async backup => {
    assert.equal(backup.address, 0x12000); assert.equal(backup.data.length, 300); assert.ok(backup.data.every(n => n === 255)); backupSeen = true;
  } });
  assert.equal(result.verified, true); assert.equal(result.writtenBytes, 300);
  assert.deepEqual(transport.memory.slice(0x12000, 0x12000 + 300), wanted); assert.equal(transport.memory[0x11fff], beforeNeighbor);
  await session.close();
});
test('gated ACK-without-write is detected and carries the real recovery backup', async () => {
  const { session, transport } = await connected(); transport.ackOnlyWrites = true;
  await assert.rejects(session.writeMemory(0x12000, Uint8Array.of(1, 2)), error => {
    assert.equal(error.code, 'VERIFY_MISMATCH'); assert.equal(error.mayHaveModifiedDevice, true);
    assert.deepEqual(error.recovery[0].data, Uint8Array.of(255, 255)); return true;
  });
  assert.equal(session.state, 'error'); assert.equal(transport.memory[0x12000], 255); await session.close();
});
test('all-zero gated reads cannot falsely verify a requested all-zero write', async () => {
  const { session, transport } = await connected();
  transport.onRequest = (request, radio) => {
    if (request.command === COMMAND.WRITE) { radio.ackOnlyWrites = true; radio.gatedReads = true; }
  };
  await assert.rejects(session.writeMemory(0x12000, new Uint8Array(4)), { code: 'ACCESS_CHANGED' });
  assert.equal(transport.memory[0x12000], 255); await session.close();
});
test('already-gated zero data rejects before any write', async () => {
  const { session, transport } = await connected(); transport.gatedReads = true;
  await assert.rejects(session.writeMemory(0x12000, Uint8Array.of(1)), { code: 'AMBIGUOUS_READ_ACCESS' });
  assert.equal(transport.requests.filter(r => r.command === COMMAND.WRITE).length, 0); await session.close();
});
test('access gate changing during backup is detected before any mutation or backup persistence', async () => {
  const { session, transport } = await connected(); let persisted = false;
  transport.onRequest = (request, radio) => { if (request.command === COMMAND.READ && request.address === 0x12000) radio.gatedReads = true; };
  await assert.rejects(session.writeMemory(0x12000, Uint8Array.of(1), { onBackup() { persisted = true; } }), { code: 'ACCESS_CHANGED' });
  assert.equal(transport.requests.filter(r => r.command === COMMAND.WRITE).length, 0); assert.equal(persisted, false); await session.close();
});
test('mode-1 writes reconstruct entire sectors, preserving both prefix and suffix', async () => {
  const transport = new MockTransport();
  for (let i = 0; i < 8192; i++) transport.memory[0x50000 + i] = (i * 7) % 251;
  const original = transport.memory.slice(0x50000, 0x52000), desired = original.slice(); desired.set([1, 2, 3, 4], 4094);
  const { session } = await connected(transport);
  const result = await session.writeMemory(0x50ffe, Uint8Array.of(1, 2, 3, 4));
  assert.equal(result.backups.length, 2); assert.equal(result.writtenBytes, 8192);
  assert.deepEqual(transport.memory.slice(0x50000, 0x52000), desired);
  assert.deepEqual(result.backups[0].data, original.slice(0, 4096)); await session.close();
});
test('backup persistence failure aborts before a device write', async () => {
  const { session, transport } = await connected();
  await assert.rejects(session.writeMemory(0x12000, Uint8Array.of(1), { onBackup() { throw new Error('disk unavailable'); } }), /disk unavailable/);
  assert.equal(transport.requests.filter(r => r.command === COMMAND.WRITE).length, 0); await session.close();
});
test('wrong response address stops the session; same command is not enough', async () => {
  const transport = new MockTransport({ responseHook(body, request) {
    if (request.command === COMMAND.READ) body[4] ^= 1; return body;
  } });
  const { session } = await connected(transport);
  await assert.rejects(session.readMemory(0x12000, 1), { code: 'REPLY_MISMATCH' });
  assert.equal(session.state, 'error'); await session.close();
});
test('timeout invalidates session and queued work cannot consume a late reply', async () => {
  const { session, transport } = await connected(undefined, { timeoutMs: 15 }); transport.dropReplies = true;
  const first = session.readMemory(0, 1), second = session.readMemory(128, 1);
  await assert.rejects(first, { code: 'TIMEOUT' }); await assert.rejects(second, { code: 'NOT_CONNECTED' });
  assert.equal(transport.requests.filter(r => r.command === COMMAND.READ).length, 1); await session.close();
});
test('cancelling an active exchange closes transport and rejects promptly', async () => {
  const { session, transport } = await connected(); transport.dropReplies = true;
  const controller = new AbortController(), operation = session.readMemory(0, 1, { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(operation, { code: 'CANCELLED' });
  await session.close(); assert.equal(transport.opened, false);
});
test('reboot is explicit, sends stock command, and has no claimed hardware confirmation', async () => {
  const { session, transport } = await connected(); assert.equal(transport.rebootRequested, undefined);
  assert.deepEqual(await session.reboot(), { commandSent: true, rebootConfirmed: false });
  assert.equal(transport.rebootRequested, true); assert.equal(session.state, 'closed');
});
test('notification overflow fails, and BLE requires explicit UUID/framing/write profile', async () => {
  const queue = new ByteQueue(3); queue.push(Uint8Array.of(1, 2)); queue.push(Uint8Array.of(3, 4));
  await assert.rejects(queue.read(), { code: 'INPUT_OVERFLOW' });
  assert.throws(() => new WebBluetoothTransport({}, {}), { code: 'BLE_PROFILE_REQUIRED' });
});
test('WebUSB rejects an unrelated USB device before opening it', async () => {
  let opened = false;
  const transport = new WebUsbTransport({ vendorId: 1, productId: 1, open() { opened = true; } });
  await assert.rejects(transport.open(), { code: 'UNKNOWN_USB_PROFILE' }); assert.equal(opened, false);
});
