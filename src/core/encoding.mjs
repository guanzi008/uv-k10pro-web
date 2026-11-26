// SPDX-License-Identifier: MIT
// Independent byte/encoding helpers. No vendor program or asset is embedded.
import { GB2312_GRID } from './gb2312-table.mjs';

export function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}

export function integer(value, min, max, label = 'value') {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer in ${min}..${max}`);
  return value;
}

export function span(value, offset, length) {
  const data = bytes(value);
  integer(offset, 0, data.length, 'offset');
  integer(length, 0, data.length - offset, 'length');
  return data.subarray(offset, offset + length);
}

export function exact(value, length, label = 'record') {
  const data = bytes(value);
  if (data.length !== length) throw new RangeError(`${label} must be ${length} bytes`);
  return data;
}

export function view(value) {
  const data = bytes(value);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function hex(value) {
  return Array.from(bytes(value), x => x.toString(16).padStart(2, '0')).join('');
}

export function unhex(value) {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(value))
    throw new TypeError('Expected an even-length hexadecimal string');
  return Uint8Array.from(value.match(/../g) ?? [], x => Number.parseInt(x, 16));
}

export function visibleText(data, encoding = 'gb2312') {
  data = bytes(data);
  let result = '';
  for (let i = 0; i < data.length; i++) {
    const a = data[i];
    if (a === 0 || a === 255) break;
    if (a < 128) { result += String.fromCharCode(a); continue; }
    const b = data[i + 1];
    if (encoding === 'gb2312' && a >= 0xa1 && a <= 0xf7 && b >= 0xa1 && b <= 0xfe) {
      const ch = GB2312_GRID[(a - 0xa1) * 94 + b - 0xa1];
      if (ch && ch !== '\0') { result += ch; i++; continue; }
    }
    result += `\\x${a.toString(16).padStart(2, '0')}`;
  }
  return result;
}

let encodingMap;
export function encodeText(text, length, encoding = 'gb2312') {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  integer(length, 0, 4096, 'text allocation');
  if (!encodingMap) {
    encodingMap = new Map();
    for (let i = 0; i < GB2312_GRID.length; i++) {
      const ch = GB2312_GRID[i];
      if (ch !== '\0') encodingMap.set(ch, [0xa1 + Math.floor(i / 94), 0xa1 + i % 94]);
    }
  }
  const result = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0) throw new RangeError('Embedded NUL is not allowed');
    if (cp < 128) result.push(cp);
    else if (encoding === 'gb2312' && encodingMap.has(ch)) result.push(...encodingMap.get(ch));
    else throw new RangeError(`Character ${JSON.stringify(ch)} is not representable in ${encoding.toUpperCase()}`);
  }
  if (result.length > length) throw new RangeError(`Text needs ${result.length} bytes; maximum is ${length}`);
  const output = new Uint8Array(length);
  output.set(result);
  return output;
}

export function frequencyUnits(hz) {
  integer(hz, 0, 0xffffffff * 10, 'frequency in Hz');
  if (hz % 10) throw new RangeError('Frequency must be an exact multiple of 10 Hz');
  return hz / 10;
}

// Decimal conversion deliberately never passes through floating-point MHz.
export function parseMHz(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value.trim()))
    throw new TypeError('Frequency must be a decimal MHz string with at most six decimal places');
  const [whole, fraction = ''] = value.trim().split('.');
  const hz = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (hz > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Frequency is too large');
  return Number(hz);
}

export function formatMHz(hz) {
  integer(hz, 0, Number.MAX_SAFE_INTEGER, 'frequency in Hz');
  return `${Math.floor(hz / 1000000)}.${String(hz % 1000000).padStart(6, '0')}`;
}
