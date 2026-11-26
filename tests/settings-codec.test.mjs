// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSetting, patchSetting, patchSettings, readContact, patchContactInImage, readMessage, patchMessageInImage,
  readUnresolvedBuffer, changedRegions, parseCoordinate, readStartupBitmap, patchStartupBitmap,
  pageBytesToPixels, pixelsToPageBytes } from '../src/core/settings-codec.mjs';
import { SETTINGS_FIELDS } from '../src/core/schema.mjs';

test('APRS CPS interval is one byte and never overwrites ACK', () => {
  const image = new Uint8Array(0x46000).fill(0xa5);
  image[0x1e004] = 1;
  const edited = patchSetting(image, 'aprs_tx_interval', 60);
  assert.equal(edited[0x1e003], 60);
  assert.equal(edited[0x1e004], 1);
  assert.deepEqual(changedRegions(image, edited).map(r => [r.offset, r.length]), [[0x1e003, 1]]);
});

test('APRS filter follows CPS LSB masks, preserving all other bits', () => {
  const image = new Uint8Array(0x46000);
  image[0x1e007] = 0x80;
  const edited = patchSettings(image, { aprs_filter_position: true, aprs_filter_weather: true });
  assert.equal(edited[0x1e007], 0xa1);
  assert.equal(readSetting(edited, 'aprs_filter_status'), true);
  assert.equal(readSetting(edited, 'aprs_filter_mic_e'), false);
  assert.equal(patchSetting(edited, 'aprs_filter_position', false)[0x1e007], 0xa0);
});

test('APRS coordinate conversion is exact ddmm.mmmm, not decimal degrees', () => {
  const image = new Uint8Array(0x46000).fill(0xa5);
  const edited = patchSettings(image, { aprs_latitude: '3114.5678', aprs_longitude: '12128.1234' });
  assert.equal(readSetting(edited, 'aprs_latitude'), '3114.5678');
  assert.equal(new DataView(edited.buffer).getUint32(0x1e018, true), 31145678);
  assert.equal(parseCoordinate('9000.0000', 90), 90000000);
  assert.throws(() => parseCoordinate('8960.0000', 90), /minutes/);
  assert.throws(() => parseCoordinate('9000.0001', 90), /degrees/);
});

test('GB2312 name and ASCII APRS fields have different strict encodings', () => {
  const image = new Uint8Array(0x46000).fill(0xa5);
  const edited = patchSettings(image, { device_name: '测试K10', aprs_own_callsign: 'BG0TEST', call_channel: 999 });
  assert.equal(readSetting(edited, 'device_name'), '测试K10');
  assert.equal(readSetting(edited, 'aprs_own_callsign'), 'BG0TEST');
  assert.equal(new DataView(edited.buffer).getUint16(0x1300e, true), 998);
  assert.equal(readSetting(edited, 'call_channel'), 999);
  assert.throws(() => patchSetting(image, 'aprs_text', '中文'), /ASCII/);
  assert.throws(() => patchSetting(image, 'backlight_red', 101), /integer/);
});

test('unknown Boolean bytes remain visible and untouched during other edits', () => {
  const image = new Uint8Array(0x46000).fill(0xff);
  assert.equal(readSetting(image, 'beep'), 255);
  const edited = patchSetting(image, 'end_talk', 2);
  assert.equal(edited[0x13010], 255);
  assert.equal(readSetting(edited, 'end_talk'), 2);
  assert.throws(() => patchSetting(image, 'beep', 2), /integer/);
});

test('active K8 NOAA settings occupy only their verified general bytes', () => {
  const image = new Uint8Array(0x46000).fill(0xa5);
  const edited = patchSettings(image, { noaa_squelch: 7, noaa_search: 1 });
  assert.equal(readSetting(edited, 'noaa_squelch'), 7);
  assert.equal(readSetting(edited, 'noaa_search'), 1);
  assert.deepEqual(changedRegions(image, edited).map(r => [r.offset, r.length]), [[0x13001, 1], [0x13003, 1]]);
  assert.throws(() => patchSetting(image, 'noaa_squelch', 10), /integer/);
  assert.throws(() => patchSetting(image, 'noaa_same', 1), /Unknown K8 setting/);
  assert.throws(() => readUnresolvedBuffer(image, 'noaa_same'), /No fixed buffer/);
});

test('contact and message edits preserve neighboring records and reserved fields', () => {
  const image = new Uint8Array(0x46000).fill(0xa5);
  const contact = patchContactInImage(image, 'dtmf', 15, { name: '本地', code: '12345678' });
  assert.equal(readContact(contact, 'dtmf', 15).name, '本地');
  assert.equal(readContact(contact, 'dtmf', 15).code, '12345678');
  assert.throws(() => patchContactInImage(image, 'dtmf', 0, { code: '12A#' }), /digits/);
  assert.throws(() => patchContactInImage(image, 'five_tone', 0, { code: '12E' }), /digits/);
  assert.deepEqual(contact.subarray(0x1a000, 0x1a168), image.subarray(0x1a000, 0x1a168));
  const message = patchMessageInImage(image, 63, { text: 'HELLO' });
  const result = readMessage(message, 63);
  assert.equal(result.text, 'HELLO');
  assert.deepEqual(result.raw.subarray(0, 24), new Uint8Array(24).fill(0xa5));
  assert.deepEqual(result.raw.subarray(72), new Uint8Array(184).fill(0xa5));
  assert.throws(() => patchMessageInImage(image, 0, { auto_index_raw: 1 }), /read-only/);
});

test('CPS messages read UTF-8 but write ASCII with a 48-byte bound', () => {
  const image = new Uint8Array(0x46000).fill(0xff);
  image.fill(0, 0x2e000 + 24, 0x2e000 + 72);
  image.set(new TextEncoder().encode('中文'), 0x2e000 + 24);
  assert.equal(readMessage(image, 0).text, '中文');
  assert.equal(readMessage(image, 0).text_encoding_valid, true);
  assert.throws(() => patchMessageInImage(image, 0, { text: '中文' }), /ASCII/);
  assert.throws(() => patchMessageInImage(image, 0, { text: 'A'.repeat(49) }), /maximum is 48/);
  const full = patchMessageInImage(image, 0, { text: 'A'.repeat(48) });
  assert.equal(readMessage(full, 0).text, 'A'.repeat(48));
  assert.deepEqual(full.subarray(0x2e048, 0x2e050), new Uint8Array(8).fill(0xff));
  image[0x2e000 + 24] = 0xff;
  assert.equal(readMessage(image, 0).text_encoding_valid, false);
  assert.match(readMessage(image, 0).text, /^\\x[fF][fF]/);
});

test('CPS message visibility stops at the first invalid index without compacting slots', () => {
  const image = new Uint8Array(0x46000).fill(0xff);
  const later = patchMessageInImage(image, 1, { active: true, text: 'SECOND' });
  assert.equal(readMessage(later, 1).valid, true);
  assert.equal(readMessage(later, 1).cps_visible, false);
  const contiguous = patchMessageInImage(later, 0, { active: true, text: 'FIRST' });
  assert.equal(readMessage(contiguous, 1).cps_visible, true);
  assert.equal(readMessage(contiguous, 1).auto_index_raw, 1);
  const removed = patchMessageInImage(contiguous, 0, { active: false });
  assert.equal(readMessage(removed, 0).auto_index_raw, 0xffffffff);
  assert.equal(readMessage(removed, 0).valid, false);
  assert.equal(readMessage(removed, 0).text, 'FIRST');
  assert.equal(readMessage(removed, 1).valid, true);
  assert.equal(readMessage(removed, 1).cps_visible, false);
  assert.deepEqual(removed.subarray(0x2e004), contiguous.subarray(0x2e004));
  assert.throws(() => patchMessageInImage(image, 0, { active: 1 }), /Boolean/);
});

test('schema fields do not overlap except explicitly packed filter bits', () => {
  const occupied = new Map();
  for (const f of SETTINGS_FIELDS) {
    for (let i = f.offset; i < f.offset + f.length; i++) {
      const old = occupied.get(i);
      assert.ok(!old || (f.type === 'bit' && old.type === 'bit' && f.bit !== old.bit), `${f.id} overlaps ${old?.id}`);
      occupied.set(i, f);
    }
  }
});

test('unresolved special buffers are copied for inspection and marked read-only', () => {
  const image = new Uint8Array(0x46000).fill(0xa5);
  const result = readUnresolvedBuffer(image, 'startup_password');
  assert.equal(result.writable, false);
  assert.equal(result.raw.length, 4);
  result.raw[0] = 0;
  assert.equal(image[0x17000], 0xa5);
});

test('boot bitmap corner and page fixtures agree with CPS page conversion', () => {
  const pixels = new Uint8Array(8192);
  pixels[0] = 1;
  pixels[7 * 128 + 127] = 1;
  pixels[8 * 128] = 1;
  pixels[63 * 128 + 127] = 1;
  const data = pixelsToPageBytes(pixels);
  assert.equal(data[0], 1);
  assert.equal(data[127], 128);
  assert.equal(data[128], 1);
  assert.equal(data[1023], 128);
  assert.deepEqual(pageBytesToPixels(data), pixels);
  const image = new Uint8Array(0x46000).fill(0xa5);
  const edited = patchStartupBitmap(image, data);
  const result = readStartupBitmap(edited);
  assert.equal(result.valid, true);
  assert.deepEqual(Array.from(edited.subarray(0x45000, 0x45006)), [0x5a, 0x5a, 0xbc, 0x9a, 0, 4]);
  assert.deepEqual(result.reserved, Uint8Array.of(0xa5, 0xa5));
  assert.deepEqual(edited.subarray(0x45408), image.subarray(0x45408));
  assert.deepEqual(result.pixels, pixels);
});
