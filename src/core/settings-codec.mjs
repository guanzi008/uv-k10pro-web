// SPDX-License-Identifier: MIT
import { bytes, exact, span, integer, view, encodeText, visibleText, frequencyUnits, hex } from './encoding.mjs';
import { SETTINGS_FIELDS, SETTINGS_BY_ID, STRUCTURED_TABLES, STARTUP_BITMAP, UNRESOLVED_FEATURES } from './schema.mjs';
export { SETTINGS_FIELDS, SETTINGS_BY_ID, SETTINGS_GROUPS, STRUCTURED_TABLES, UNRESOLVED_FEATURES } from './schema.mjs';

function definition(id) {
  if (!Object.hasOwn(SETTINGS_BY_ID, id)) throw new RangeError(`Unknown K8 setting: ${id}`);
  return SETTINGS_BY_ID[id];
}

function rawRead(data, f) {
  const segment = span(data, f.offset, f.length);
  const dv = view(segment);
  switch (f.type) {
    case 'u8': return segment[0];
    case 'bool': return segment[0] <= 1 ? segment[0] === 1 : segment[0];
    case 'bit': return Boolean(segment[0] & (1 << f.bit));
    case 'u16': return dv.getUint16(0, true);
    case 'i16': return dv.getInt16(0, true);
    case 'u32': return dv.getUint32(0, true);
    case 'i32': return dv.getInt32(0, true);
    case 'frequency': return dv.getUint32(0, true) * 10;
    case 'coordinate': {
      const value = dv.getUint32(0, true);
      return `${Math.floor(value / 10000)}.${String(value % 10000).padStart(4, '0')}`;
    }
    case 'text': return visibleText(segment, f.encoding);
    default: throw new RangeError(`Unsupported setting storage type: ${f.type}`);
  }
}

export function readSetting(image, id) {
  const f = definition(id);
  const value = rawRead(image, f);
  return f.display_add ? value + f.display_add : value;
}

export function readSettings(image, { group } = {}) {
  return Object.fromEntries(SETTINGS_FIELDS.filter(f => (!group || group === f.group) && f.offset + f.length <= bytes(image).length)
    .map(f => [f.id, readSetting(image, f.id)]));
}

export function describeSettings(image, { group } = {}) {
  return SETTINGS_FIELDS.filter(f => !group || f.group === group).map(f => ({ ...f,
    available: f.offset + f.length <= bytes(image).length,
    value: f.offset + f.length <= bytes(image).length ? readSetting(image, f.id) : null }));
}

export function parseCoordinate(value, maxDegrees) {
  if (typeof value !== 'string' || !/^\d{1,5}(?:\.\d{1,4})?$/.test(value.trim()))
    throw new TypeError('Coordinate must be ddmm.mmmm / dddmm.mmmm text');
  const [whole, fraction = ''] = value.trim().split('.');
  const packed = Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
  const degrees = Math.floor(packed / 1000000);
  const minutes = packed % 1000000;
  if (minutes >= 600000 || degrees > maxDegrees || (degrees === maxDegrees && minutes !== 0))
    throw new RangeError(`Coordinate must have minutes < 60 and degrees <= ${maxDegrees}`);
  return integer(packed, 0, 0xffffffff, 'coordinate');
}

function applySetting(output, id, value) {
  const f = definition(id);
  if (!f.writable) throw new RangeError(`${id} is read-only: ${f.help ?? 'encoding unresolved'}`);
  const segment = span(output, f.offset, f.length);
  const dv = view(segment);
  if (f.type === 'text') {
    if (f.pattern && (typeof value !== 'string' || !new RegExp(f.pattern).test(value)))
      throw new RangeError(`${f.label} contains unsupported characters`);
    segment.set(encodeText(value, f.length, f.encoding));
    return;
  }
  if (f.type === 'coordinate') { dv.setUint32(0, parseCoordinate(value, f.max_degrees), true); return; }
  if (f.type === 'frequency') { dv.setUint32(0, frequencyUnits(value), true); return; }
  if (f.type === 'bool' || f.type === 'bit') {
    if (typeof value === 'boolean') value = Number(value);
    integer(value, 0, 1, f.label);
    if (f.type === 'bit') segment[0] = (segment[0] & ~(1 << f.bit)) | (value << f.bit);
    else segment[0] = value;
    return;
  }
  integer(value, f.min, f.max, f.label);
  if (f.display_add) value -= f.display_add;
  switch (f.type) {
    case 'u8': segment[0] = value; break;
    case 'u16': dv.setUint16(0, value, true); break;
    case 'i16': dv.setInt16(0, value, true); break;
    case 'u32': dv.setUint32(0, value, true); break;
    case 'i32': dv.setInt32(0, value, true); break;
    default: throw new RangeError(`Unsupported setting storage type: ${f.type}`);
  }
}

export function patchSettings(image, changes) {
  const output = bytes(image).slice();
  for (const [id, value] of Object.entries(changes)) applySetting(output, id, value);
  return output;
}
export function patchSetting(image, id, value) { return patchSettings(image, { [id]: value }); }

function tableFor(kind) {
  if (!Object.hasOwn(STRUCTURED_TABLES, kind)) throw new RangeError(`Unknown K8 table: ${kind}`);
  return STRUCTURED_TABLES[kind];
}
function tableSlice(image, kind, index) {
  const table = tableFor(kind);
  const offset = table.offset + integer(index, 0, table.count - 1, 'table index') * table.size;
  return { table, offset, raw: span(image, offset, table.size).slice() };
}
function contactKind(kind) {
  if (kind === 'dtmf') return 'dtmf_contacts';
  if (kind === 'five_tone') return 'five_tone_contacts';
  if (kind === 'dtmf_contacts' || kind === 'five_tone_contacts') return kind;
  throw new RangeError('Contact kind must be dtmf or five_tone');
}

export function readContact(image, kind, index) {
  kind = contactKind(kind);
  const { raw, offset } = tableSlice(image, kind, index);
  return { kind, index, offset, raw, name: visibleText(raw.subarray(0, 16)), code: visibleText(raw.subarray(16, 24), 'ascii') };
}

export function patchContactInImage(image, kind, index, changes) {
  kind = contactKind(kind);
  const { raw, offset } = tableSlice(image, kind, index);
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name') raw.set(encodeText(value, 16), 0);
    else if (key === 'code') {
      // CPS ConvertCpsDtmf/5ToneContacts calls Util.IsAllDigits. The wider
      // symbol alphabet belongs to signaling up/down codes, not contact IDs.
      if (typeof value !== 'string' || !/^[0-9]*$/.test(value))
        throw new RangeError('Contact code must contain only digits 0..9');
      raw.set(encodeText(value, 8, 'ascii'), 16);
    } else throw new RangeError(`Unknown contact field: ${key}`);
  }
  const output = bytes(image).slice();
  output.set(raw, offset);
  return output;
}

export function readMessage(image, index) {
  const { raw, offset, table } = tableSlice(image, 'predefined_messages', index);
  const auto_index_raw = view(raw).getUint32(0, true);
  const valid = auto_index_raw < table.count;
  let cps_visible = valid;
  // The CPS reader stops at the first idx >= 64; a valid later slot alone does
  // not make that slot visible. Reading never compacts or repairs the image.
  for (let i = 0; cps_visible && i < index; i++)
    cps_visible = view(span(image, table.offset + i * table.size, 4)).getUint32(0, true) < table.count;
  const content = raw.subarray(table.text_offset, table.text_offset + table.text_bytes);
  let start = 0, end = content.length;
  while (start < end && content[start] === 0) start++;
  while (end > start && content[end - 1] === 0) end--;
  let text, text_encoding_valid = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.subarray(start, end));
  } catch {
    text_encoding_valid = false;
    text = Array.from(content.subarray(start, end), byte => byte < 128 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`).join('');
  }
  return { index, offset, raw, auto_index_raw, valid, cps_visible, text, text_encoding_valid };
}

export function patchMessageInImage(image, index, changes) {
  const { raw, offset, table } = tableSlice(image, 'predefined_messages', index);
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'text') raw.set(encodeText(value, table.text_bytes, 'ascii'), table.text_offset);
    else if (key === 'active') {
      if (typeof value !== 'boolean') throw new TypeError('Message active must be Boolean');
      view(raw).setUint32(0, value ? index : 0xffffffff, true);
    } else if (key === 'auto_index_raw') throw new RangeError('Message index is read-only; use active to set the canonical slot index or erase marker');
    else throw new RangeError(`Unknown message field: ${key}`);
  }
  const output = bytes(image).slice();
  output.set(raw, offset);
  return output;
}

export function readUnresolvedBuffer(image, id) {
  const feature = UNRESOLVED_FEATURES.find(f => f.id === id);
  if (!feature || feature.offset === undefined) throw new RangeError(`No fixed buffer defined for ${id}`);
  const raw = span(image, feature.offset, feature.length).slice();
  return { ...feature, raw, raw_hex: hex(raw), writable: false };
}

export function pageBytesToPixels(pageBytes) {
  const data = exact(pageBytes, 1024, '128×64 page bitmap');
  const pixels = new Uint8Array(128 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++)
    pixels[y * 128 + x] = (data[(y >>> 3) * 128 + x] >>> (y & 7)) & 1;
  return pixels;
}

export function pixelsToPageBytes(pixels) {
  const input = exact(pixels, 128 * 64, '128×64 monochrome pixels');
  const output = new Uint8Array(1024);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
    const pixel = integer(input[y * 128 + x], 0, 1, 'pixel (1 = black)');
    output[(y >>> 3) * 128 + x] |= pixel << (y & 7);
  }
  return output;
}

export function readStartupBitmap(image) {
  const raw = span(image, STARTUP_BITMAP.offset, STARTUP_BITMAP.length).slice();
  const dv = view(raw), magic = dv.getUint32(0, true), length = dv.getUint16(4, true);
  const page_bytes = raw.slice(8);
  return { ...STARTUP_BITMAP, raw, magic, length, valid: magic === STARTUP_BITMAP.magic && length === 1024,
    reserved: raw.slice(6, 8), page_bytes, pixels: pageBytesToPixels(page_bytes) };
}

export function patchStartupBitmap(image, pageBytes) {
  const data = exact(pageBytes, 1024, '128×64 page bitmap');
  const output = bytes(image).slice();
  const raw = span(output, STARTUP_BITMAP.offset, STARTUP_BITMAP.length);
  const dv = view(raw);
  dv.setUint32(0, STARTUP_BITMAP.magic, true);
  dv.setUint16(4, 1024, true);
  raw.set(data, 8); // retain header bytes +6/+7 exactly
  return output;
}

// Byte-level differences support review and exact write planning without losing
// unspecified fields. Data copying here never performs a device operation.
export function changedRegions(before, after) {
  before = bytes(before); after = bytes(after);
  if (before.length !== after.length) throw new RangeError('Image edits must preserve image length');
  const result = [];
  let start = null;
  for (let i = 0; i <= before.length; i++) {
    const changed = i < before.length && before[i] !== after[i];
    if (changed && start === null) start = i;
    if (!changed && start !== null) {
      result.push({ offset: start, length: i - start, before: before.slice(start, i), after: after.slice(start, i),
        before_hex: hex(before.subarray(start, i)), after_hex: hex(after.subarray(start, i)) });
      start = null;
    }
  }
  return result;
}
