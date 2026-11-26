// SPDX-License-Identifier: MIT
// Port of guanzi008/uv-k10pro-firmware/tools/channel_codec.py (MIT),
// with immutable image editing and browser-compatible GB2312 encoding.
import { bytes, exact, span, integer, view, hex, visibleText, encodeText, frequencyUnits } from './encoding.mjs';
export { parseMHz, formatMHz } from './encoding.mjs';

export const CHANNEL_COUNT = 999;
export const CHANNEL_SIZE = 64;
export const ATTRIBUTE_BASE = 0x11000;
export const VFO_BASE = 0x10000;
export const VFO_BAND_COUNT = 7;
export const SCAN_LIST_BASE = 0x16000;
export const SCAN_LIST_COUNT = 32;
export const SCAN_LIST_SIZE = 128;
export const SCAN_LIST_MEMBERS = 48;
export const STEP_HZ = Object.freeze([1000, 1500, 2000, 2500, 5000, 6250, 8330, 9000, 10000, 12500, 15000, 20000, 25000]);
export const CHANNEL_ENUMS = Object.freeze({
  power: ['LOW', 'HIGH', 'TURBO'], bandwidth: ['WIDE', 'NARROW'],
  modulation: ['FM', 'AM', 'SSB', 'CW'], offset_direction: ['SIMPLEX', 'PLUS', 'MINUS'],
  tone: ['none', 'CTCSS', 'DCS-N', 'DCS-I', 'U23', 'U24'],
});

const allowed = max => Array.from({ length: max + 1 }, (_, i) => i);
export const CHANNEL_FIELDS = Object.freeze({
  aprs_ptt: { offset: 0x08, allowed: allowed(2) },
  aprs_tx_channel: { offset: 0x09, allowed: allowed(8) },
  offset_direction: { offset: 0x0c, allowed: allowed(2) },
  bandwidth: { offset: 0x0d, allowed: allowed(1) },
  step_index: { offset: 0x0e, allowed: allowed(12) },
  scrambler: { offset: 0x0f, allowed: allowed(10) },
  power: { offset: 0x10, allowed: allowed(2) },
  busy_lockout: { offset: 0x11, allowed: allowed(1) },
  reverse: { offset: 0x12, allowed: allowed(1) },
  signaling_decode: { offset: 0x13, allowed: allowed(1) },
  ptt_id: { offset: 0x14, allowed: allowed(3) },
  modulation: { offset: 0x15, allowed: allowed(3) },
  scan_list: { offset: 0x16, allowed: [...allowed(32), 0xff] },
  squelch: { offset: 0x17, allowed: allowed(9) },
  signaling_system: { offset: 0x3c, allowed: allowed(1) },
  aprs_receive: { offset: 0x3d, allowed: allowed(1) },
});

export function channelOffset(index) { return integer(index, 0, 998, 'channel index') * 64; }
export function vfoOffset(band, side) {
  return VFO_BASE + integer(band, 0, 6, 'VFO band') * 128 + integer(side, 0, 1, 'VFO side') * 64;
}
export function attributeOffset(index) { return ATTRIBUTE_BASE + integer(index, 0, 1005, 'attribute index'); }
export function scanListOffset(index) { return SCAN_LIST_BASE + integer(index, 0, 31, 'scan-list index') * 128; }

export function validTone(tone) {
  if (!tone || !Number.isInteger(tone.kind) || !Number.isInteger(tone.value)) return false;
  const { kind, value } = tone;
  if (kind === 0) return value === 0;
  if (kind === 1) return value >= 600 && value <= 2600;
  if (kind === 2 || kind === 3) return value >= 0 && value <= 0x1ff;
  if (kind === 4) return value >= 0 && value <= 0x7fffff;
  if (kind === 5) return value >= 0 && value <= 0xffffff;
  return false;
}

function toneDescription(kind, value) {
  return { kind, value, name: CHANNEL_ENUMS.tone[kind] ?? 'unknown', valid: validTone({ kind, value }),
    display: kind === 1 ? `${Math.floor(value / 10)}.${value % 10}`
      : (kind === 2 || kind === 3) ? `D${value.toString(8).padStart(3, '0')}${kind === 2 ? 'N' : 'I'}`
        : kind === 0 ? '' : String(value) };
}

export function derivedTxUnits(rx, offset, direction) {
  integer(rx, 0, 0xffffffff, 'RX units');
  integer(offset, 0, 0xffffffff, 'offset units');
  integer(direction, 0, 255, 'direction');
  let value = rx;
  if (direction === 1) value = (rx + offset) >>> 0;
  else if (direction === 2) value = (rx - offset) >>> 0;
  else if (direction !== 0) return 2500000;
  const signed = value >= 0x80000000 ? value - 0x100000000 : value;
  return Math.max(2500000, Math.min(58000000, signed));
}

export function decodeChannel(raw) {
  raw = exact(raw, 64, 'channel record').slice();
  const dv = view(raw);
  const fields = Object.fromEntries(Object.entries(CHANNEL_FIELDS).map(([key, field]) => [key, raw[field.offset]]));
  return {
    raw, raw_hex: hex(raw), name: visibleText(raw.subarray(0x18, 0x22)), ...fields, fields,
    rx_frequency_hz: dv.getUint32(0, true) * 10, offset_hz: dv.getUint32(4, true) * 10,
    derived_tx_frequency_hz_before_reverse: derivedTxUnits(dv.getUint32(0, true), dv.getUint32(4, true), fields.offset_direction) * 10,
    rx_tone: toneDescription(raw[0x0a], dv.getUint32(0x28, true)),
    tx_tone: toneDescription(raw[0x0b], dv.getUint32(0x2c, true)),
    scan_start_hz: dv.getUint32(0x30, true) * 10, scan_end_hz: dv.getUint32(0x34, true) * 10,
    power_name: CHANNEL_ENUMS.power[fields.power] ?? 'unknown',
    bandwidth_name: CHANNEL_ENUMS.bandwidth[fields.bandwidth] ?? 'unknown',
    modulation_name: CHANNEL_ENUMS.modulation[fields.modulation] ?? 'unknown',
    step_hz: STEP_HZ[fields.step_index] ?? null,
  };
}

export function patchChannel(raw, changes) {
  const output = exact(raw, 64, 'channel record').slice();
  const dv = view(output);
  const frequencies = { rx_frequency_hz: 0, offset_hz: 4, scan_start_hz: 0x30, scan_end_hz: 0x34 };
  for (const [key, value] of Object.entries(changes)) {
    if (Object.hasOwn(CHANNEL_FIELDS, key)) {
      const field = CHANNEL_FIELDS[key];
      if (!field.allowed.includes(value)) throw new RangeError(`Invalid ${key}: ${value}`);
      output[field.offset] = value;
    } else if (Object.hasOwn(frequencies, key)) {
      const units = frequencyUnits(value);
      if (key === 'offset_hz' && units > 99999999) throw new RangeError('Offset exceeds stock loader maximum');
      dv.setUint32(frequencies[key], units, true);
    } else if (key === 'name') {
      // The stock loader uses only the first ten bytes of the 16-byte allocation.
      output.set(encodeText(value, 10), 0x18);
    } else if (key === 'rx_tone' || key === 'tx_tone') {
      if (!validTone(value)) throw new RangeError(`${key} is outside the stock sanitizer bounds`);
      output[key === 'rx_tone' ? 0x0a : 0x0b] = value.kind;
      dv.setUint32(key === 'rx_tone' ? 0x28 : 0x2c, value.value, true);
    } else throw new RangeError(`Unknown channel field: ${key}`);
  }
  return output;
}

export function readAttribute(image, index) { return span(image, attributeOffset(index), 1)[0]; }
export function describeAttribute(value) {
  integer(value, 0, 255, 'attribute');
  return { raw: value, deleted: value === 255, band_index: value & 15, upper_nibble: value >>> 4,
    band_nibble_valid: (value & 15) < 7 };
}

export function readChannel(image, index) {
  const result = decodeChannel(span(image, channelOffset(index), 64));
  // A short record-only import remains inspectable; missing attribute is not guessed.
  const attribute = bytes(image).length > attributeOffset(index) ? readAttribute(image, index) : null;
  return { ...result, index, attribute, deleted: attribute === null ? null : attribute === 255 };
}

export function patchChannelInImage(image, index, changes, options = {}) {
  const offset = channelOffset(index);
  const edited = patchChannel(span(image, offset, 64), changes);
  const output = bytes(image).slice();
  output.set(edited, offset);
  if (options.attribute !== undefined) {
    const where = attributeOffset(index);
    span(output, where, 1);
    output[where] = integer(options.attribute, 0, 255, 'attribute');
  }
  return output;
}

export function deleteChannel(image, index) {
  channelOffset(index);
  const output = bytes(image).slice();
  span(output, attributeOffset(index), 1)[0] = 255;
  return output;
}

export function readVfo(image, band, side) {
  return { ...decodeChannel(span(image, vfoOffset(band, side), 64)), band, side,
    attribute: readAttribute(image, CHANNEL_COUNT + band) };
}

export function patchVfoInImage(image, band, side, changes, options = {}) {
  const offset = vfoOffset(band, side);
  const edited = patchChannel(span(image, offset, 64), changes);
  const output = bytes(image).slice();
  output.set(edited, offset);
  if (options.attribute !== undefined)
    span(output, attributeOffset(CHANNEL_COUNT + band), 1)[0] = integer(options.attribute, 0, 255, 'attribute');
  return output;
}

export function decodeScanList(raw) {
  raw = exact(raw, 128, 'scan-list record').slice();
  const dv = view(raw);
  const member_slots = Array.from({ length: 48 }, (_, i) => dv.getUint16(0x18 + 2 * i, true));
  return { raw, name: visibleText(raw.subarray(0, 10)),
    priorities: [dv.getUint16(0x10, true), dv.getUint16(0x12, true)],
    member_slots, members: member_slots.filter(value => value < CHANNEL_COUNT) };
}

function priority(value) {
  if (value === 0xffff || value === 0x5a5a) return value;
  return integer(value, 0, 998, 'priority channel index');
}

export function patchScanList(raw, changes) {
  const output = exact(raw, 128, 'scan-list record').slice();
  const dv = view(output);
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name') output.set(encodeText(value, 10), 0);
    else if (key === 'priorities') {
      if (!Array.isArray(value) || value.length !== 2) throw new RangeError('Two priority values are required');
      value.forEach((v, i) => dv.setUint16(0x10 + i * 2, priority(v), true));
    } else if (key === 'members') {
      if (!Array.isArray(value) || value.length > 48) throw new RangeError('A scan list has at most 48 members');
      for (let i = 0; i < 48; i++) dv.setUint16(0x18 + i * 2, i < value.length ? integer(value[i], 0, 998, 'member index') : 0xffff, true);
    } else throw new RangeError(`Unknown scan-list field: ${key}`);
  }
  return output;
}

export function readScanList(image, index) {
  return { ...decodeScanList(span(image, scanListOffset(index), 128)), index };
}
export function patchScanListInImage(image, index, changes) {
  const offset = scanListOffset(index);
  const edited = patchScanList(span(image, offset, 128), changes);
  const output = bytes(image).slice();
  output.set(edited, offset);
  return output;
}
