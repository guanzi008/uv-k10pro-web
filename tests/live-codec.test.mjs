// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAprsMessage, prepareAprsMessage, decodeAprsPacket } from '../src/core/aprs-frame.mjs';
import { LIVE_COMMAND, APRS_SEND_TIMEOUT_MS, encodeAprsFixedPosition, buildLocationSync,
  buildAprsSend, parseAprsSendReply, parseAprsReceive } from '../src/protocol/live-codec.mjs';
import { parseMessage, encodeMessage, encodeFrame, decodeFrame, crc16X25 } from '../src/protocol/frame.mjs';

const sample = { destination: 'APRS', source: 'N0CALL', addressee: 'N0TEST', text: 'Hello' };
const report = JSON.parse(readFileSync(new URL('../docs/evidence/live-replay.json', import.meta.url), 'utf8'));
const hex = value => Buffer.from(value).toString('hex');
const unhex = value => new Uint8Array(Buffer.from(value, 'hex'));
const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);

test('APRS App packet includes little-endian FCS and agrees with stock CRC consumer', () => {
  const prepared = prepareAprsMessage(sample), packet = prepared.packet;
  assert.equal(prepared.packetHex, report.sample_aprs_packet_hex);
  assert.equal(hex(packet.subarray(0, 16)), '82a0a4a64040e09c60868298986103f0');
  assert.equal(prepared.information, ':N0TEST   :Hello');
  assert.equal(view(packet).getUint16(packet.length - 2, true), crc16X25(packet.subarray(0, -2)));
  const decoded = decodeAprsPacket(packet, { fcs: true });
  assert.equal(decoded.valid, true); assert.equal(decoded.fcsStatus, 'verified');
  assert.equal(decoded.source.label, 'N0CALL'); assert.equal(decoded.destination.label, 'APRS');
  assert.deepEqual(decoded.message, { addressee: 'N0TEST', text: 'Hello' });
  assert.ok(report.cases.some(c => c.kind === 'aprs-receive-FCS-consumer' && c.ready && c.FCS_removed));
  assert.ok(report.cases.some(c => c.kind === 'aprs-receive-FCS-consumer' && c.corrupted_FCS && !c.ready));
});

test('App address ordering, end bits and unusual digipeater reserved bits are retained', () => {
  const prepared = prepareAprsMessage({ ...sample, source: ' n0call ', sourceSsid: 15,
    destination: ' aprs ', destinationSsid: 1, addressee: ' n0test-7 ', path: ' wide1-1, wide2-2 ' });
  assert.equal(prepared.path, 'WIDE1-1, WIDE2-2');
  const packet = prepared.packet;
  assert.deepEqual([packet[6], packet[13], packet[20], packet[27]], [0xe2, 0x7e, 0x22, 0x25]);
  const decoded = decodeAprsPacket(packet, { fcs: true });
  assert.equal(decoded.destination.label, 'APRS-1'); assert.equal(decoded.source.label, 'N0CALL-15');
  assert.deepEqual(decoded.path.map(p => p.label), ['WIDE1-1', 'WIDE2-2']);
  assert.deepEqual(decoded.path.map(p => p.reservedBits), [0x20, 0x20]);
  assert.equal(decoded.message.addressee, 'N0TEST-7');
});

test('native text removal/truncation is visible in preview; unencodable text is rejected', () => {
  const prepared = prepareAprsMessage({ ...sample, text: 'Hi|~{there}' + 'X'.repeat(70) });
  assert.equal(prepared.removedCharacters, 3); assert.equal(prepared.normalizedText.length, 67);
  assert.equal(prepared.normalizedText.slice(0, 8), 'Hithere}'); assert.equal(prepared.truncatedCharacters, 11);
  assert.equal(prepared.warnings.length, 2);
  assert.throws(() => prepareAprsMessage({ ...sample, text: 'X'.repeat(67) + '中' }), /ASCII/);
  assert.throws(() => prepareAprsMessage({ ...sample, text: 'line\nnext' }), /ASCII/);
  assert.equal(prepareAprsMessage({ ...sample, text: '|~{' }).normalizedText, '');
  assert.ok(prepareAprsMessage({ ...sample, text: '|~{' }).warnings.some(w => w.includes('为空')));
  assert.equal(prepareAprsMessage({ ...sample, text: '  Hello  ' }).normalizedText, '  Hello  ');
});

test('path parsing follows the K8 30-character field and low-four-bit SSID rule', () => {
  const p = prepareAprsMessage({ ...sample, path: 'ABCDEFG-17, WIDE2-X' });
  assert.deepEqual(p.digipeaters.map(x => [x.callsign, x.ssid]), [['ABCDEF', 1], ['WIDE2', 0]]);
  assert.ok(p.warnings.length >= 2);
  assert.equal(prepareAprsMessage({ ...sample, path: 'WIDE1-0xF' }).digipeaters[0].ssid, 15);
  assert.throws(() => prepareAprsMessage({ ...sample, path: 'A'.repeat(31) }), /30/);
  assert.throws(() => prepareAprsMessage({ ...sample, path: 'WIDE1-1\tWIDE2-2' }), /ASCII/);
  assert.throws(() => prepareAprsMessage({ ...sample, path: 'A,B,C,D,E', text: 'X'.repeat(67) }), /128/);
  // Native length boundary includes FCS: 5 digipeaters and 64 text characters.
  assert.equal(buildAprsMessage({ ...sample, path: 'A,B,C,D,E', text: 'X'.repeat(64) }).length, 128);
  for (const patch of [{ source: '' }, { source: 'ABCDEF7' }, { destination: 'N0CALL-1' },
    { addressee: 'TOO-LONG-1' }, { addressee: 'A/B' }, { sourceSsid: -1 }, { destinationSsid: 16 }])
    assert.throws(() => buildAprsMessage({ ...sample, ...patch }), /unsupported|integer/);
});

test('location HELLO has the exact App layout and explicit bounds', () => {
  const message = parseMessage(buildLocationSync(0x12345678, { utcSeconds: 1735689600,
    latitude: -34.946333333333335, longitude: -123.76116666666667, altitudeMeters: -16.5 }));
  assert.equal(message.command, 0x02bc); assert.equal(message.declaredLength, 24);
  const payload = message.payload, dv = view(payload);
  assert.equal(dv.getUint32(0, true), 0x12345678); assert.equal(dv.getUint32(4, true), 1735689600);
  assert.deepEqual(Array.from(payload.subarray(8, 12)), [1, 0x53, 0x57, 0]);
  assert.equal(dv.getUint32(12, true), 34567800); assert.equal(dv.getUint32(16, true), 123456700);
  assert.equal(dv.getInt32(20, true), -17);
  assert.equal(hex(message.body), report.cases.find(c => c.kind === 'location-hello').request_body_hex);
  const zero = parseMessage(buildLocationSync(0, { utcSeconds: 0, latitude: -0, longitude: 0, altitudeMeters: -0.5 }));
  assert.deepEqual(Array.from(zero.payload.subarray(9, 11)), [0x4e, 0x45]);
  assert.equal(view(zero.payload).getInt32(20, true), -1);
  for (const patch of [{ latitude: 91 }, { longitude: -181 }, { longitude: NaN }, { latitude: '1' },
    { altitudeMeters: Infinity }, { altitudeMeters: 2147483647.5 }, { utcSeconds: -1 }])
    assert.throws(() => buildLocationSync(0, { utcSeconds: 1, latitude: 0, longitude: 0, ...patch }));
});

test('coordinate encoding preserves significant-digit rounding and the native boundary quirk', () => {
  assert.equal(encodeAprsFixedPosition(12.3456789), 12207400);
  assert.equal(encodeAprsFixedPosition(12.020576), 12012350);
  assert.equal(encodeAprsFixedPosition(12.0020576), 12001235);
  assert.equal(encodeAprsFixedPosition(89.9999999), 89600000); // no carry to 90 degrees in App.
  assert.equal(encodeAprsFixedPosition(90), 90000000);
  for (const n of [-1, 181, Infinity, NaN]) assert.throws(() => encodeAprsFixedPosition(n));
});

test('APRS fixed send envelope matches actual stock dispatch and does not mutate caller bytes', () => {
  const packet = buildAprsMessage(sample), before = packet.slice(), body = buildAprsSend(packet), message = parseMessage(body);
  assert.equal(message.command, LIVE_COMMAND.APRS_SEND); assert.equal(message.payload.length, 132);
  assert.equal(view(message.payload).getUint16(0, true), packet.length);
  assert.deepEqual(message.payload.slice(2, 4), new Uint8Array(2));
  assert.deepEqual(message.payload.slice(4, 4 + packet.length), packet);
  assert.ok(message.payload.slice(4 + packet.length).every(n => n === 0)); assert.deepEqual(packet, before);
  assert.equal(hex(body), report.cases.find(c => c.kind === 'aprs-send').request_body_hex);
  assert.equal(APRS_SEND_TIMEOUT_MS, 10000);
  assert.throws(() => buildAprsSend(new Uint8Array()), /1..128/);
  assert.throws(() => buildAprsSend(new Uint8Array(129)), /1..128/);
  assert.equal(parseMessage(buildAprsSend(new Uint8Array(128))).payload.length, 132);
});

test('APRS result is an explicit device result; uninitialized padding is not a success condition', () => {
  const reply = parseAprsSendReply(parseMessage(encodeMessage(0x02de, Uint8Array.of(0, 0xa5, 0xff, 0x5a))));
  assert.equal(reply.accepted, true); assert.equal(reply.rfDeliveryConfirmed, false);
  assert.equal(parseAprsSendReply(parseMessage(encodeMessage(0x02de, Uint8Array.of(1, 0, 0, 0)))).accepted, false);
  assert.equal(parseAprsSendReply(parseMessage(encodeMessage(0x02de, Uint8Array.of(255, 0, 0, 0)))).result, 255);
  for (const command of [0x02dd, 0x02e1]) assert.throws(() => parseAprsSendReply({ command, payload: new Uint8Array(4) }), /Expected/);
  assert.throws(() => parseAprsSendReply({ command: 0x02de, payload: new Uint8Array(0) }), /Expected/);
});

test('every captured stock response decodes with its actual transport framing', () => {
  for (const item of report.cases.filter(c => c.response_frame_hex)) {
    const transport = item.transport ?? 2;
    const message = decodeFrame(unhex(item.response_frame_hex), { direction: 'response',
      wireMode: transport === 2 ? 'plain' : 'xor', responseChecksum: transport === 2 ? 'crc16-x25' : 'placeholder' });
    if (item.kind === 'aprs-send') assert.equal(parseAprsSendReply(message).result, item.result);
    if (message.command === LIVE_COMMAND.APRS_RECEIVE) {
      const event = parseAprsReceive(message);
      if (item.kind === 'aprs-receive-FCS-consumer') {
        assert.equal(event.decoded.message.text, 'Hello'); assert.equal(event.fcsIncluded, false);
        assert.equal(event.decoded.fcsStatus, 'not-present'); assert.equal(event.possiblyTruncated, false);
      } else if (item.input_length >= 128) {
        assert.equal(event.length, 128); assert.equal(event.possiblyTruncated, true);
      }
    }
  }
});

test('receive events preserve raw bytes, ignore unused padding and reject inconsistent envelopes', () => {
  const packet = buildAprsMessage(sample).slice(0, -2), payload = new Uint8Array(132).fill(0xa5);
  view(payload).setUint16(0, packet.length, true); payload.set(packet, 4);
  const event = parseAprsReceive({ command: 0x02e1, payload });
  assert.deepEqual(event.packet, packet); assert.deepEqual(event.reserved, Uint8Array.of(0xa5, 0xa5));
  assert.equal(event.decoded.information, ':N0TEST   :Hello');
  payload.fill(0); assert.deepEqual(event.packet, packet);
  for (const size of [0, 4, 131, 133]) assert.throws(() => parseAprsReceive({ command: 0x02e1, payload: new Uint8Array(size) }), /132/);
  view(payload).setUint16(0, 129, true); assert.throws(() => parseAprsReceive({ command: 0x02e1, payload }), /128/);
  assert.throws(() => parseAprsReceive({ command: 0x02de, payload }), /Expected/);
  const corrupted = buildAprsMessage(sample); corrupted[10] ^= 1;
  assert.equal(decodeAprsPacket(corrupted, { fcs: true }).valid, false);
  assert.equal(decodeAprsPacket(new Uint8Array(2)).valid, false);
  assert.equal(decodeAprsPacket(new Uint8Array(128)).valid, false);
  // A valid outer frame does not turn malformed RF packet contents into decoded messages.
  const invalidPayload = new Uint8Array(132); view(invalidPayload).setUint16(0, 2, true);
  const framed = encodeFrame(encodeMessage(0x02e1, invalidPayload), { direction: 'response' });
  assert.equal(parseAprsReceive(decodeFrame(framed, { direction: 'response' })).decoded.valid, false);
});

test('receive subviews retain transport-checksum evidence without inventing a received FCS', () => {
  const packet = buildAprsMessage(sample).slice(0, -2);
  const storage = new Uint8Array(151).fill(0xcc), payload = storage.subarray(9, 141);
  payload.fill(0xa5); view(payload).setUint16(0, packet.length, true); payload.set(packet, 4);
  for (const checksumStatus of ['crc16-x25-verified', 'placeholder-unverified']) {
    const event = parseAprsReceive({ command: LIVE_COMMAND.APRS_RECEIVE, payload, checksumStatus });
    assert.equal(event.checksumStatus, checksumStatus);
    assert.equal(event.fcsIncluded, false); assert.equal(event.decoded.fcsStatus, 'not-present');
    assert.deepEqual(event.packet, packet); assert.equal(event.decoded.message.text, 'Hello');
    assert.deepEqual(event.reserved, Uint8Array.of(0xa5, 0xa5));
  }
  const event = parseAprsReceive({ command: LIVE_COMMAND.APRS_RECEIVE, payload });
  storage.fill(0); assert.deepEqual(event.packet, packet); assert.equal(event.decoded.message.text, 'Hello');
  assert.deepEqual(event.reserved, Uint8Array.of(0xa5, 0xa5)); assert.equal(event.checksumStatus, null);
});
