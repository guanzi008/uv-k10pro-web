// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeChannel, patchChannel, readChannel, patchChannelInImage, deleteChannel, readVfo, patchVfoInImage,
  readScanList, patchScanListInImage, channelOffset, vfoOffset, derivedTxUnits, parseMHz, formatMHz } from '../src/core/channel-codec.mjs';
import { encodeText, visibleText } from '../src/core/encoding.mjs';

test('channel fixture uses little endian 10 Hz and preserves unknown bytes', () => {
  const raw = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 1) & 255);
  const edited = patchChannel(raw, { name: '泉盛K10', rx_frequency_hz: 145500000,
    offset_hz: 600000, offset_direction: 2, rx_tone: { kind: 1, value: 885 }, power: 1 });
  assert.deepEqual(Array.from(edited.subarray(0, 4)), [0xf0, 0x03, 0xde, 0x00]);
  const result = decodeChannel(edited);
  assert.equal(result.name, '泉盛K10');
  assert.equal(result.rx_frequency_hz, 145500000);
  assert.equal(result.derived_tx_frequency_hz_before_reverse, 144900000);
  assert.deepEqual(result.rx_tone, { kind: 1, value: 885, name: 'CTCSS', valid: true, display: '88.5' });
  assert.deepEqual(edited.subarray(0x22, 0x28), raw.subarray(0x22, 0x28));
  assert.deepEqual(edited.subarray(0x38), raw.subarray(0x38));
  assert.equal(raw[0], 1);
});

test('strict GB2312 does not silently accept GBK extensions, emoji, or overflow', () => {
  assert.equal(visibleText(encodeText('中文ABCDE', 10)), '中文ABCDE');
  assert.throws(() => encodeText('中文ABCDEFZ', 10), /maximum/);
  assert.throws(() => encodeText('😀', 10), /representable/);
  assert.throws(() => encodeText('镕', 10), /representable/); // GBK extension, not GB2312
  assert.equal(visibleText(Uint8Array.of(0x81, 0x40, 0, 0xff)), '\\x81@');
  assert.equal(visibleText(Uint8Array.of(65, 0xff, 66)), 'A');
});

test('integer MHz conversion rejects sub-10 Hz channel edits', () => {
  assert.equal(parseMHz('145.500010'), 145500010);
  assert.equal(formatMHz(145500010), '145.500010');
  assert.throws(() => parseMHz('145.0000001'), /decimal/);
  assert.throws(() => patchChannel(new Uint8Array(64), { rx_frequency_hz: 145500001 }), /10 Hz/);
  assert.throws(() => patchChannel(new Uint8Array(64), { power: 3 }), /Invalid/);
  assert.throws(() => patchChannel(new Uint8Array(64), { rx_tone: { kind: 2, value: 512 } }), /sanitizer/);
});

test('stock transmit arithmetic models unsigned wrap followed by signed clamp', () => {
  assert.equal(derivedTxUnits(14550000, 60000, 2), 14490000);
  assert.equal(derivedTxUnits(10, 20, 2), 2500000);
  assert.equal(derivedTxUnits(0xfffffff0, 2500016, 1), 2500000);
  assert.equal(derivedTxUnits(60000000, 0, 0), 58000000);
  assert.equal(derivedTxUnits(14550000, 0, 255), 2500000);
});

test('channel deletion changes attribute only; no band is inferred', () => {
  const image = new Uint8Array(0x18000).fill(0xa5);
  const edited = patchChannelInImage(image, 998, { name: 'LAST' }, { attribute: 2 });
  assert.equal(readChannel(edited, 998).attribute, 2);
  assert.equal(readChannel(edited, 998).name, 'LAST');
  const deleted = deleteChannel(edited, 998);
  assert.deepEqual(deleted.subarray(channelOffset(998), channelOffset(998) + 64), edited.subarray(channelOffset(998), channelOffset(998) + 64));
  assert.equal(readChannel(deleted, 998).deleted, true);
  assert.throws(() => channelOffset(999), /index/);
  assert.throws(() => patchChannelInImage(new Uint8Array(64), 0, {}, { attribute: 0 }), /offset/);
});

test('14 VFO slots share only seven auxiliary attributes', () => {
  const image = new Uint8Array(0x18000).fill(0xa5);
  const edited = patchVfoInImage(image, 6, 1, { rx_frequency_hz: 433500000 }, { attribute: 6 });
  assert.equal(vfoOffset(6, 1), 0x10340);
  assert.equal(readVfo(edited, 6, 1).rx_frequency_hz, 433500000);
  assert.equal(readVfo(edited, 6, 0).attribute, 6);
  assert.deepEqual(edited.subarray(0x10300, 0x10340), image.subarray(0x10300, 0x10340));
});

test('scan slots, priorities and reserved bytes are independent', () => {
  const image = new Uint8Array(0x18000).fill(0xa5);
  const edited = patchScanListInImage(image, 31, { name: 'SCAN', members: [0, 998, 0], priorities: [0x5a5a, 0xffff] });
  const result = readScanList(edited, 31);
  assert.deepEqual(result.members, [0, 998, 0]);
  assert.equal(result.member_slots.length, 48);
  assert.equal(result.member_slots[3], 65535);
  assert.deepEqual(result.priorities, [0x5a5a, 0xffff]);
  assert.deepEqual(result.raw.subarray(10, 16), new Uint8Array(6).fill(0xa5));
  assert.deepEqual(result.raw.subarray(20, 24), new Uint8Array(4).fill(0xa5));
  assert.deepEqual(result.raw.subarray(120, 128), new Uint8Array(8).fill(0xa5));
});
