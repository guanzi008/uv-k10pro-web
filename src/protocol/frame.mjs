// SPDX-License-Identifier: MIT
// Ported from guanzi008/uv-k10pro-firmware/tools/programming_protocol.py (MIT).
// See docs/protocol.md for the CPS / firmware evidence and important limits.

export const COMMAND = Object.freeze({ HELLO: 0x02bc, HELLO_REPLY: 0x02bd,
  READ: 0x02c3, READ_REPLY: 0x02c4, WRITE: 0x02c5, WRITE_REPLY: 0x02c6,
  AUTH: 0x02d5, AUTH_REPLY: 0x02d6, REBOOT: 0x05dd });
export const FLASH_LIMIT = 0x001ff000;
export const CHUNK_SIZE = 128;
export const SECTOR_SIZE = 4096;
export const STREAMING_UPDATE_START = 0x50000;
export const XOR_KEY = Uint8Array.of(0x16, 0x6c, 0x14, 0xe6, 0x2e, 0x91, 0x0d, 0x40,
  0x21, 0x35, 0xd5, 0x40, 0x13, 0x03, 0xe9, 0x80);

export class ProtocolError extends Error {
  constructor(message, code = 'PROTOCOL_ERROR', details = {}) {
    super(message); this.name = 'ProtocolError'; this.code = code; this.details = details;
  }
}
export function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected Uint8Array, ArrayBuffer, or an ArrayBuffer view');
}
export function uint(value, bits, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits)
    throw new ProtocolError(`${name} must be an unsigned ${bits}-bit integer`, 'INVALID_ARGUMENT');
  return value;
}
export function interval(address, count, maxCount = FLASH_LIMIT) {
  uint(address, 32, 'address');
  if (!Number.isSafeInteger(count) || count < 1 || count > maxCount ||
      address >= FLASH_LIMIT || count > FLASH_LIMIT - address)
    throw new ProtocolError(`Requested interval must fit below 0x1ff000; count 1..${maxCount}`, 'INVALID_INTERVAL');
}
const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);

export function crc16X25(value) {
  let crc = 0xffff;
  for (const octet of bytes(value)) {
    crc ^= octet;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x8408 : 0);
  }
  return crc ^ 0xffff;
}
export function xorPayload(value) {
  return bytes(value).map((octet, i) => octet ^ XOR_KEY[i % XOR_KEY.length]);
}
export function encodeMessage(command, payload = new Uint8Array(), declaredLength = undefined) {
  payload = bytes(payload); uint(command, 16, 'command');
  const declared = declaredLength ?? payload.length; uint(declared, 16, 'declared length');
  const body = new Uint8Array(payload.length + 4), dv = view(body);
  dv.setUint16(0, command, true); dv.setUint16(2, declared, true); body.set(payload, 4);
  return body;
}
export function parseMessage(value) {
  const body = bytes(value);
  if (body.length < 4) throw new ProtocolError('Incomplete inner header', 'BAD_LENGTH');
  const dv = view(body), command = dv.getUint16(0, true), declaredLength = dv.getUint16(2, true);
  const payload = body.slice(4); let lengthConvention = 'complete-payload-length';
  if (command === COMMAND.WRITE) {
    if (payload.length < 12) throw new ProtocolError('Incomplete write header', 'BAD_LENGTH');
    const count = view(payload).getUint16(4, true);
    if (count > payload.length - 12) throw new ProtocolError('Write count exceeds supplied bytes', 'BAD_LENGTH');
    if (declaredLength === 12 && payload.length === 140) lengthConvention = 'cps-0.56-fixed-128';
    else if (!(declaredLength === payload.length && payload.length === 12 + count))
      throw new ProtocolError('Unknown write length convention', 'BAD_LENGTH');
  } else if (command === COMMAND.HELLO && declaredLength === 4 && payload.length === 24) {
    lengthConvention = 'cps-0.56-hello-legacy';
  } else if (declaredLength !== payload.length) {
    throw new ProtocolError('Inner length does not match actual payload', 'BAD_LENGTH');
  }
  return { command, declaredLength, payload, body: body.slice(), lengthConvention };
}

function frameOptions({ direction = 'request', wireMode = 'plain', responseChecksum = 'placeholder', maxFrameLength = 383 } = {}) {
  if (!['request', 'response'].includes(direction) || !['plain', 'xor'].includes(wireMode) ||
      !['placeholder', 'crc16-x25'].includes(responseChecksum) || !Number.isInteger(maxFrameLength) || maxFrameLength < 12 || maxFrameLength > 65543)
    throw new ProtocolError('Invalid frame profile', 'INVALID_ARGUMENT');
  return { direction, wireMode, responseChecksum, maxFrameLength };
}
export function encodeFrame(value, options = {}) {
  const body = bytes(value), profile = frameOptions(options); parseMessage(body);
  if (body.length + 8 > profile.maxFrameLength) throw new ProtocolError('Frame exceeds conservative receive-ring limit', 'FRAME_TOO_LONG');
  const data = new Uint8Array(body.length + 2); data.set(body);
  const checksum = profile.direction === 'response' && profile.responseChecksum === 'placeholder' ? 0xffff : crc16X25(body);
  view(data).setUint16(body.length, checksum, true);
  const frame = new Uint8Array(body.length + 8); frame.set([0xab, 0xcd]);
  view(frame).setUint16(2, body.length, true);
  frame.set(profile.wireMode === 'xor' ? xorPayload(data) : data, 4);
  frame.set([0xdc, 0xba], frame.length - 2); return frame;
}
export function decodeFrame(value, options = {}) {
  const frame = bytes(value), profile = frameOptions(options);
  if (frame.length < 12 || frame[0] !== 0xab || frame[1] !== 0xcd ||
      frame.at(-2) !== 0xdc || frame.at(-1) !== 0xba)
    throw new ProtocolError('Invalid frame delimiters or incomplete frame', 'BAD_FRAME');
  const size = view(frame).getUint16(2, true);
  if (size + 8 !== frame.length || frame.length > profile.maxFrameLength)
    throw new ProtocolError('Invalid outer length', 'BAD_LENGTH');
  const data = profile.wireMode === 'xor' ? xorPayload(frame.subarray(4, -2)) : frame.slice(4, -2);
  const body = data.subarray(0, -2), checksum = view(data).getUint16(data.length - 2, true);
  const placeholder = profile.direction === 'response' && profile.responseChecksum === 'placeholder';
  if (checksum !== (placeholder ? 0xffff : crc16X25(body)))
    throw new ProtocolError(placeholder ? 'Expected stock FFFF checksum placeholder' : 'CRC16/X25 mismatch', 'BAD_CHECKSUM');
  return { ...parseMessage(body), checksum, checksumStatus: placeholder ? 'placeholder-unverified' : 'crc16-x25-verified',
    crcVerified: !placeholder, wireMode: profile.wireMode };
}

/** Bounded incremental parser. Noise is discarded; malformed candidate frames are reported. */
export class FrameStreamParser {
  constructor(options = {}) {
    this.options = frameOptions(options); this.onError = options.onError ?? (() => {});
    this.buffer = []; this.discardedBytes = 0; this.invalidFrames = 0;
  }
  reset() { this.buffer = []; }
  get bufferedBytes() { return this.buffer.length; }
  push(value) {
    const frames = [];
    for (const octet of bytes(value)) {
      this.buffer.push(octet);
      while (this.buffer.length) {
        if (this.buffer[0] !== 0xab || (this.buffer.length > 1 && this.buffer[1] !== 0xcd)) {
          this.buffer.shift(); this.discardedBytes++; continue;
        }
        if (this.buffer.length < 4) break;
        const total = (this.buffer[2] | this.buffer[3] << 8) + 8;
        if (total < 12 || total > this.options.maxFrameLength) {
          this.invalidFrames++; this.onError(new ProtocolError('Invalid streamed frame length', 'BAD_LENGTH'));
          this.buffer.shift(); continue;
        }
        if (this.buffer.length < total) break;
        try {
          frames.push(decodeFrame(Uint8Array.from(this.buffer.slice(0, total)), this.options));
          this.buffer.splice(0, total);
        } catch (error) { this.invalidFrames++; this.onError(error); this.buffer.shift(); }
      }
    }
    return frames;
  }
}

export function buildHello(session, utcSeconds = Math.floor(Date.now() / 1000)) {
  uint(session, 32, 'session'); uint(utcSeconds, 32, 'UTC seconds');
  const payload = new Uint8Array(24), dv = view(payload);
  dv.setUint32(0, session, true); dv.setUint32(4, utcSeconds, true);
  return encodeMessage(COMMAND.HELLO, payload, 4);
}
export function parseHelloReply(message) {
  if (message.command !== COMMAND.HELLO_REPLY || message.payload.length !== 52)
    throw new ProtocolError('Unknown HELLO reply layout; expected stock 56-byte body', 'UNKNOWN_IDENTITY');
  const p = message.payload, nul = p.subarray(0, 16).indexOf(0);
  const firmware = new TextDecoder('utf-8', { fatal: true }).decode(p.subarray(0, nul < 0 ? 16 : nul)).trim();
  return { firmware, passwordValid: p[16], startLockFlag: p[17], paramsVersion: p[18],
    challenge: p.slice(20, 36), raw: p.slice(), checksumStatus: message.checksumStatus };
}
export function buildRead(address, count, session) {
  interval(address, count, CHUNK_SIZE); uint(session, 32, 'session');
  const payload = new Uint8Array(12), dv = view(payload);
  dv.setUint32(0, address, true); dv.setUint16(4, count, true); dv.setUint32(8, session, true);
  return encodeMessage(COMMAND.READ, payload);
}
export function buildWrite(address, value, session, { flag = 0 } = {}) {
  const data = bytes(value); interval(address, data.length, CHUNK_SIZE); uint(session, 32, 'session'); uint(flag, 8, 'flag');
  const payload = new Uint8Array(140), dv = view(payload);
  dv.setUint32(0, address, true); dv.setUint16(4, data.length, true); payload[6] = flag;
  dv.setUint32(8, session, true); payload.set(data, 12);
  return encodeMessage(COMMAND.WRITE, payload, 12);
}
export function parseReadReply(message, address, count) {
  if (message.command !== COMMAND.READ_REPLY || message.payload.length !== count + 8)
    throw new ProtocolError('Unexpected read reply command or length', 'REPLY_MISMATCH');
  const dv = view(message.payload);
  if (dv.getUint32(0, true) !== address || dv.getUint16(4, true) !== count || dv.getUint16(6, true) !== 0)
    throw new ProtocolError('Read address, count, or reserved field mismatch', 'REPLY_MISMATCH');
  return message.payload.slice(8);
}
export function parseWriteReply(message, address) {
  if (message.command !== COMMAND.WRITE_REPLY || message.payload.length !== 4 || view(message.payload).getUint32(0, true) !== address)
    throw new ProtocolError('Write ACK address or length mismatch', 'REPLY_MISMATCH');
  return address;
}
export const buildReboot = () => encodeMessage(COMMAND.REBOOT);
