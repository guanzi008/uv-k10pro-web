// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRadioBank, patchRadioStation, patchRadioHeader, clearRadioStation, radioStationOffset } from '../src/core/radio-codec.mjs';

test('FM and SW CPS fixed-array fixtures include record zero VFO', () => {
  let image = new Uint8Array(0x13000).fill(0xa5);
  image = patchRadioStation(image, 'si4732', 'fm', 0, { frequency_hz: 88100000 });
  image = patchRadioStation(image, 'si4732', 'fm', 32, { frequency_hz: 107900000 });
  image = patchRadioStation(image, 'si4732', 'sw', 128, { frequency_hz: 14200000, demodulation: 3, bfo_raw: 65535 });
  const fm = decodeRadioBank(image, 'si4732', 'fm');
  const sw = decodeRadioBank(image, 'si4732', 'sw');
  assert.equal(fm.stations.length, 33);
  assert.equal(fm.presets.length, 32);
  assert.equal(fm.vfo.frequency_hz, 88100000);
  assert.equal(fm.vfo.is_vfo, true);
  assert.equal(sw.stations.length, 129);
  assert.equal(sw.stations[128].mode, 'USB');
  assert.equal(sw.stations[128].bfo_raw, 65535);
  assert.equal(sw.stations[128].reserved, 0xa5);
  assert.equal(radioStationOffset('si4732', 'sw', 128), 0x12b08);
  assert.deepEqual(Array.from(image.subarray(0x12108, 0x1210c)), [0x10, 0x6e, 0x86, 0x00]);
});

test('BK1080 profile shares only FM storage; AM/SSB/BFO remain inaccessible', () => {
  const image = new Uint8Array(0x13000).fill(0xa5);
  const edited = patchRadioStation(image, 'bk1080', 'fm', 1, { frequency_hz: 99100000 });
  assert.equal(decodeRadioBank(edited, 'si4732', 'fm').stations[1].frequency_hz, 99100000);
  assert.deepEqual(edited.subarray(0x12300), image.subarray(0x12300));
  assert.throws(() => decodeRadioBank(image, 'bk1080', 'sw'), /does not support/);
  assert.throws(() => patchRadioStation(image, 'bk1080', 'fm', 1, { demodulation: 1 }), /do not expose/);
  assert.throws(() => patchRadioHeader(image, 'bk1080', 'fm', { agc: 1 }), /not been verified/);
});

test('only explicitly changed radio bytes are overwritten, including deletion', () => {
  const image = new Uint8Array(0x13000).fill(0xa5);
  const edited = patchRadioStation(image, 'si4732', 'lw', 12, { frequency_hz: 198000 });
  const offset = radioStationOffset('si4732', 'lw', 12);
  assert.deepEqual(edited.subarray(offset + 4, offset + 8), image.subarray(offset + 4, offset + 8));
  assert.deepEqual(edited.subarray(0x12210, 0x12300), image.subarray(0x12210, 0x12300));
  const cleared = clearRadioStation(edited, 'si4732', 'lw', 12);
  assert.equal(decodeRadioBank(cleared, 'si4732', 'lw').stations[12].empty, true);
  assert.deepEqual(cleared.subarray(offset + 4, offset + 8), image.subarray(offset + 4, offset + 8));
  assert.throws(() => clearRadioStation(image, 'si4732', 'lw', 0), /VFO/);
  assert.throws(() => patchRadioStation(image, 'si4732', 'fm', 1, { frequency_hz: 65000000 }), /CPS range/);
});

test('broadcast header selection is a zero-based preset index', () => {
  const image = new Uint8Array(0x13000).fill(0xa5);
  const edited = patchRadioHeader(image, 'si4732', 'sw', { mode: 1, channel_index: 127, agc: 37, am_bandwidth: 6 });
  const header = decodeRadioBank(edited, 'si4732', 'sw').header;
  assert.equal(header.mode, 1);
  assert.equal(header.channel_index, 127);
  assert.equal(header.ssb_bandwidth, 0xa5);
  assert.throws(() => patchRadioHeader(image, 'si4732', 'fm', { channel_index: 32 }), /channel_index/);
});
