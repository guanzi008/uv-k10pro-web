// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMMAND, DEFAULT_K8_BLE_PROFILE, crc16X25, buildHello, buildRead, buildWrite,
  encodeFrame, decodeFrame, parseMessage, FrameStreamParser,
  ProgrammingSession, MockTransport } from '../src/protocol/index.mjs';

const evidence = JSON.parse(await readFile(new URL('../docs/evidence/ble-crc-replay.json', import.meta.url), 'utf8'));
const unhex = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const response = { direction: 'response', wireMode: 'plain', responseChecksum: 'crc16-x25-or-placeholder' };

test('JavaScript CRC matches independently replayed APK ARM64 arithmetic blocks', () => {
  assert.equal(evidence.sample_sha256, 'c2cbc6245093682907109259fa1c888fa1f41c6505a48d113e0b5ca09fd5dabb');
  for (const row of evidence.crc_cases) assert.equal(crc16X25(unhex(row.input_hex)), row.crc16_x25, row.name);
  assert.equal(evidence.passed, evidence.crc_cases.length + evidence.checksum_branch_cases.length);
});

test('APK response mode accepts FFFF and verified X25 while rejecting all other checksums', () => {
  const row = evidence.frame_vectors.find(row => row.name === 'write-ack');
  const verified = unhex(row.frame_hex), placeholder = verified.slice();
  placeholder.set([0xff, 0xff], placeholder.length - 4);
  assert.equal(decodeFrame(verified, response).crcVerified, true);
  const decoded = decodeFrame(placeholder, response);
  assert.equal(decoded.crcVerified, false); assert.equal(decoded.checksumStatus, 'placeholder-unverified');
  const corrupt = verified.slice(); corrupt[corrupt.length - 4] ^= 1;
  assert.throws(() => decodeFrame(corrupt, response), { code: 'BAD_CHECKSUM' });
  assert.throws(() => decodeFrame(placeholder, { ...response, direction: 'request' }), { code: 'BAD_CHECKSUM' });
  assert.throws(() => decodeFrame(verified, { ...response, responseChecksum: 'placeholder' }), { code: 'BAD_CHECKSUM' });
  assert.throws(() => decodeFrame(placeholder, { ...response, responseChecksum: 'crc16-x25' }), { code: 'BAD_CHECKSUM' });
  assert.equal(hex(encodeFrame(unhex(row.body_hex), response)), row.frame_hex);
  for (let split = 0; split <= verified.length; split++) {
    const parser = new FrameStreamParser(response);
    const frames = [...parser.push(placeholder.subarray(0, split)),
      ...parser.push(Uint8Array.from([...placeholder.subarray(split), ...verified]))];
    assert.deepEqual(frames.map(frame => frame.crcVerified), [false, true]);
  }
});

test('a real X25 result of FFFF remains explicitly unverified under APK placeholder compatibility', () => {
  const row = evidence.crc_cases.find(row => row.name === 'crc-equals-placeholder');
  assert.equal(row.crc16_x25, 0xffff);
  const frame = encodeFrame(unhex(row.input_hex));
  assert.equal(decodeFrame(frame, response).crcVerified, false);
  assert.equal(decodeFrame(frame, { ...response, responseChecksum: 'crc16-x25' }).crcVerified, true);
  assert.equal(decodeFrame(frame, { ...response, direction: 'request' }).crcVerified, true);
});

test('Android HELLO and WRITE golden vectors keep padded records and declare full payload lengths', () => {
  const builders = {
    'hello-android': () => buildHello(0x12345678, 1700000000, DEFAULT_K8_BLE_PROFILE),
    'read-four': () => buildRead(0x12100, 4, 0x12345678),
    'write-four-android-padded': () => buildWrite(0x12100, Uint8Array.of(1, 2, 3, 4), 0x12345678, DEFAULT_K8_BLE_PROFILE),
  };
  for (const [name, build] of Object.entries(builders)) {
    const row = evidence.frame_vectors.find(row => row.name === name), body = build();
    assert.equal(hex(body), row.body_hex, name);
    assert.equal(hex(encodeFrame(body, DEFAULT_K8_BLE_PROFILE)), row.frame_hex, name);
  }
  const write = parseMessage(builders['write-four-android-padded']());
  assert.equal(write.lengthConvention, 'android-k8-fixed-128'); assert.equal(write.declaredLength, 140);
  assert.equal(write.payload.length, 140); assert.equal(write.payload.subarray(16).every(n => n === 0), true);
  assert.equal(parseMessage(buildHello(1, 2)).declaredLength, 4);
  assert.equal(parseMessage(buildWrite(0, Uint8Array.of(1), 1)).declaredLength, 12);
  assert.throws(() => buildHello(1, 2, { lengthConvention: 'unknown' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => buildWrite(0, Uint8Array.of(1), 1, { lengthConvention: 'unknown' }), { code: 'INVALID_ARGUMENT' });
});

test('programming session inherits Android length and mixed-response profile for HELLO, read and verified writes', async () => {
  const profile = { wireMode: 'plain', responseChecksum: 'crc16-x25-or-placeholder',
    lengthConvention: 'android-k8', maxFrameLength: 199 };
  const transport = new MockTransport(profile); transport.protocolProfile = profile;
  const captured = [], modes = [], originalWrite = transport.write.bind(transport);
  transport.write = async value => {
    captured.push(decodeFrame(value, { ...profile, direction: 'request' }));
    const mode = captured.length % 2 ? 'placeholder' : 'crc16-x25'; modes.push(mode);
    transport.protocolProfile = { ...profile, responseChecksum: mode };
    try { return await originalWrite(value); }
    finally { transport.protocolProfile = profile; }
  };
  const session = new ProgrammingSession(transport, { selectedModel: 'UV-K10 Pro', sessionToken: 0x12345678, timeoutMs: 100 });
  try {
    await session.connect({ utcSeconds: 1700000000 });
    assert.equal(captured[0].declaredLength, 24);
    assert.equal(session.identity.checksumStatus, 'placeholder-unverified');
    const changed = Uint8Array.of(1, 2, 3, 4);
    await session.writeMemory(0x12000, changed);
    assert.deepEqual(await session.readMemory(0x12000, 4), changed);
    const writes = captured.filter(message => message.command === COMMAND.WRITE);
    assert.equal(writes.length, 1); assert.equal(writes[0].declaredLength, 140);
    assert.equal(writes[0].lengthConvention, 'android-k8-fixed-128');
    assert.equal(captured.every(message => message.crcVerified), true);
    assert.deepEqual([...new Set(modes)].sort(), ['crc16-x25', 'placeholder']);
  } finally { await session.close(); }
});
