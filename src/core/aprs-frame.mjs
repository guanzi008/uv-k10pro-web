// SPDX-License-Identifier: MIT
// Independently reconstructed from APK 68's K8AprsFrame, not K82/UV-5 code.
// The unusual digipeater reserved bits and message sanitization are intentional.
import { bytes, crc16X25, ProtocolError } from '../protocol/frame.mjs';

export const APRS_LIMITS = Object.freeze({ callsign: 6, addressee: 9, ssid: 15, path: 30, text: 67, packet: 128 });
const printable = /^[\x20-\x7e]*$/;
const fail = message => { throw new ProtocolError(message, 'INVALID_APRS'); };
const hex = data => Array.from(data, n => n.toString(16).padStart(2, '0')).join('');
function string(value, name) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  return value;
}
function normalize(value, name, pattern) {
  const result = string(value, name).trim().toUpperCase();
  if (!pattern.test(result)) fail(`${name} has an unsupported length or character`);
  return result;
}
function ssid(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > APRS_LIMITS.ssid) fail(`${name} must be an integer from 0 to 15`);
  return value;
}
function address(call, number, last, digipeater = false) {
  const data = new Uint8Array(7);
  for (let i = 0; i < 6; i++) data[i] = ((call[i] && call[i] !== '-' ? call.charCodeAt(i) : 32) << 1) & 255;
  data[6] = 0x60 | ((number & 15) << 1) | Number(last);
  // K8AprsFrame._buildDigipeaterAddress 0x77A1E8..0x77A1F4.
  if (digipeater) data[6] = (data[6] & 0xbf) | 0x20;
  return data;
}
function dartPathSsid(text) {
  // int.tryParse's ordinary signed decimal and hexadecimal spellings. Invalid
  // values become zero in the App. Decimal overflow also fails int.tryParse.
  if (!/^[+-]?(?:\d+|0[xX][0-9a-fA-F]+)$/.test(text)) return null;
  const negative = text[0] === '-', digits = text.replace(/^[+-]/, '');
  const number = BigInt(digits) * (negative ? -1n : 1n);
  const max = /^0x/i.test(digits) ? 0xffffffffffffffffn : 0x7fffffffffffffffn;
  if (number < -0x8000000000000000n || number > max) return null;
  return Number(BigInt.asUintN(4, number));
}

/** Produce a reviewable packet using the exact K8 App transformations.
 * Printable ASCII only; removes |, ~ and {, then truncates the text to 67.
 * packet includes the little-endian AX.25 FCS and does not include HDLC flags.
 * This function never opens a transport or transmits anything.
 */
export function prepareAprsMessage({ destination, destinationSsid = 0, source, sourceSsid = 0,
  addressee, path = '', text } = {}) {
  destination = normalize(destination, 'destination', /^[A-Z0-9]{1,6}$/);
  source = normalize(source, 'source', /^[A-Z0-9]{1,6}$/);
  addressee = normalize(addressee, 'addressee', /^[A-Z0-9-]{1,9}$/);
  destinationSsid = ssid(destinationSsid, 'destinationSsid'); sourceSsid = ssid(sourceSsid, 'sourceSsid');
  path = string(path, 'path').trim().toUpperCase();
  if (path.length > APRS_LIMITS.path || !printable.test(path)) fail('APRS path must contain at most 30 printable ASCII characters');
  const inputText = string(text, 'text'), cleaned = inputText.replace(/[|~{]/g, '');
  if (!printable.test(cleaned)) fail('APRS text must contain printable ASCII only');
  const normalizedText = cleaned.slice(0, APRS_LIMITS.text), removedCharacters = inputText.length - cleaned.length;
  const truncatedCharacters = cleaned.length - normalizedText.length, warnings = [];
  if (removedCharacters) warnings.push(`按 K8 App 规则移除 ${removedCharacters} 个 |、~、{ 字符。`);
  if (truncatedCharacters) warnings.push(`按 K8 App 规则截去末尾 ${truncatedCharacters} 个字符，保留 67 字符。`);
  if (!normalizedText.trim()) warnings.push('规范化后的消息正文为空。');
  const tokens = path ? path.split(/[, ]+/).map(token => token.trim()).filter(Boolean) : [];
  const digipeaters = tokens.map(token => {
    const dash = token.lastIndexOf('-'), hasSuffix = dash >= 0 && dash < token.length - 1;
    const fullCall = hasSuffix ? token.slice(0, dash) : token;
    const parsedSsid = hasSuffix ? dartPathSsid(token.slice(dash + 1)) : 0;
    const call = fullCall.slice(0, 6), number = parsedSsid ?? 0;
    if (fullCall.length > 6 || (hasSuffix && parsedSsid === null) || /[^A-Z0-9]/.test(call))
      warnings.push(`路径 ${token} 按 K8 App 规则编码；请核对预览中的路径地址。`);
    if (hasSuffix && /^\d+$/.test(token.slice(dash + 1)) && BigInt(token.slice(dash + 1)) > 15n)
      warnings.push(`路径 ${token} 的 SSID 按 K8 App 规则只保留低 4 位（${number}）。`);
    return { token, callsign: call.replaceAll('-', ' '), ssid: number };
  });
  const information = `:${addressee.padEnd(9, ' ')}:${normalizedText}`;
  const content = new Uint8Array(7 * (2 + digipeaters.length) + 2 + information.length);
  content.set(address(destination, destinationSsid, false)); content[6] |= 0x80;
  content.set(address(source, sourceSsid, !digipeaters.length), 7);
  for (let i = 0; i < digipeaters.length; i++) {
    const item = digipeaters[i]; content.set(address(item.callsign, item.ssid, i === digipeaters.length - 1, true), 14 + i * 7);
  }
  const offset = 7 * (2 + digipeaters.length);
  content.set([0x03, 0xf0], offset); content.set(new TextEncoder().encode(information), offset + 2);
  const packet = new Uint8Array(content.length + 2); packet.set(content);
  const fcs = crc16X25(content); new DataView(packet.buffer).setUint16(content.length, fcs, true);
  if (packet.length > APRS_LIMITS.packet) fail(`APRS frame exceeds 128 bytes (${packet.length})`);
  return { packet, packetHex: hex(packet), length: packet.length, destination, destinationSsid,
    source, sourceSsid, addressee, path, digipeaters, information, normalizedText,
    removedCharacters, truncatedCharacters, fcs, warnings };
}

export function buildAprsMessage(options) { return prepareAprsMessage(options).packet; }

/** Decode a received or previewed AX.25 UI frame without modifying it.
 * Stock 8.02.16 removes its checked FCS before emitting 0x02E1, so callers
 * decoding that notification must leave fcs=false. Locally built packets
 * include an FCS and should use fcs=true. There is no byte-pattern guessing.
 */
export function decodeAprsPacket(value, { fcs = false } = {}) {
  const packet = bytes(value).slice();
  if (typeof fcs !== 'boolean') fail('fcs must be a boolean');
  const result = { raw: packet, rawHex: hex(packet), length: packet.length, valid: false,
    fcsStatus: fcs ? 'invalid' : 'not-present', addresses: [], destination: null,
    source: null, path: [], control: null, pid: null, information: '', message: null, error: null };
  const invalid = error => ({ ...result, error });
  if (packet.length < 16 + (fcs ? 2 : 0)) return invalid('Incomplete AX.25 address/control header');
  let content = packet;
  if (fcs) {
    content = packet.subarray(0, -2);
    const expected = new DataView(packet.buffer, packet.byteOffset + packet.length - 2, 2).getUint16(0, true);
    result.fcs = expected;
    if (crc16X25(content) !== expected) return invalid('AX.25 FCS mismatch');
    result.fcsStatus = 'verified';
  }
  let cursor = 0, finalAddress = false;
  while (cursor + 7 <= content.length) {
    const encoded = content.subarray(cursor, cursor + 7), letters = encoded.subarray(0, 6);
    if (letters.some(n => (n & 1) !== 0)) return invalid('AX.25 callsign contains an unshifted byte');
    const callsign = Array.from(letters, n => String.fromCharCode(n >>> 1)).join('').trimEnd();
    if (!/^[\x20-\x7e]+$/.test(callsign)) return invalid('AX.25 callsign contains unsupported bytes');
    const flags = encoded[6], number = (flags >>> 1) & 15;
    result.addresses.push({ callsign, ssid: number, label: callsign + (number ? `-${number}` : ''),
      last: Boolean(flags & 1), commandOrRepeated: Boolean(flags & 0x80), reservedBits: flags & 0x60 });
    cursor += 7;
    if (flags & 1) { finalAddress = true; break; }
    if (result.addresses.length > 18) return invalid('AX.25 address list is too long');
  }
  if (!finalAddress || result.addresses.length < 2 || cursor + 2 > content.length) return invalid('Incomplete AX.25 address chain');
  [result.destination, result.source] = result.addresses; result.path = result.addresses.slice(2);
  result.control = content[cursor++]; result.pid = content[cursor++];
  result.informationBytes = content.slice(cursor);
  result.information = Array.from(result.informationBytes, n => String.fromCharCode(n)).join('');
  result.valid = true;
  if (result.control === 0x03 && result.pid === 0xf0 && result.information[0] === ':' && result.information[10] === ':') {
    result.message = { addressee: result.information.slice(1, 10).trimEnd(), text: result.information.slice(11) };
  }
  return result;
}
