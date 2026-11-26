// SPDX-License-Identifier: MIT
// Exact K8 App payloads, cross-checked with stock UV-K10 Pro 8.02.16 dispatch.
import { bytes, uint, encodeMessage, COMMAND, ProtocolError } from './frame.mjs';
import { decodeAprsPacket } from '../core/aprs-frame.mjs';

export const LIVE_COMMAND = Object.freeze({ APRS_SEND: 0x02dd, APRS_SEND_REPLY: 0x02de, APRS_RECEIVE: 0x02e1 });
export const APRS_SEND_TIMEOUT_MS = 10000; // APK68 Duration@a51d61, 10,000,000 microseconds; retries=0.
const fail = message => { throw new ProtocolError(message, 'INVALID_LIVE_ARGUMENT'); };

/** K8RadioProtocol.encodeAprsFixedPosDms: degrees + decimal minutes.
 * The App rounds minutes to FOUR SIGNIFICANT DIGITS before multiplying by
 * 10,000. It does not use four decimal places and does not carry 60.00 minutes.
 */
export function encodeAprsFixedPosition(degrees) {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees) || degrees < 0 || degrees > 180)
    fail('Absolute coordinate must be a finite number from 0 to 180 degrees');
  const whole = Math.floor(degrees), minutes = Number(((degrees - whole) * 60).toPrecision(4));
  return Math.trunc(whole * 1000000 + minutes * 10000);
}

/** A new HELLO request also changes RTC and challenge. The session owner must
 * parse 0x02BD, replace the challenge, invalidate authentication and old write
 * baselines. This is not an EEPROM update and does not initiate RF sending.
 */
export function buildLocationSync(sessionToken, { utcSeconds, latitude, longitude, altitudeMeters = 0 } = {}) {
  uint(sessionToken, 32, 'session token'); uint(utcSeconds, 32, 'UTC seconds');
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90)
    fail('Latitude must be a finite number from -90 to 90 degrees');
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
    fail('Longitude must be a finite number from -180 to 180 degrees');
  if (typeof altitudeMeters !== 'number' || !Number.isFinite(altitudeMeters)) fail('Altitude must be finite');
  // Dart's round()/libc round rounds ties away from zero, including negative altitude.
  const altitude = Math.sign(altitudeMeters) * Math.floor(Math.abs(altitudeMeters) + 0.5);
  if (altitude < -2147483648 || altitude > 2147483647) fail('Rounded altitude must fit signed 32 bits');
  const payload = new Uint8Array(24), view = new DataView(payload.buffer);
  view.setUint32(0, sessionToken, true); view.setUint32(4, utcSeconds, true);
  payload[8] = 1; payload[9] = latitude < 0 ? 0x53 : 0x4e; payload[10] = longitude < 0 ? 0x57 : 0x45;
  view.setUint32(12, encodeAprsFixedPosition(Math.abs(latitude)), true);
  view.setUint32(16, encodeAprsFixedPosition(Math.abs(longitude)), true); view.setInt32(20, altitude, true);
  return encodeMessage(COMMAND.HELLO, payload);
}

/** Fixed 132-byte payload used by K8AprsMessages.encodeSendRequest. */
export function buildAprsSend(value) {
  const packet = bytes(value);
  if (packet.length < 1 || packet.length > 128) fail('APRS packet must contain 1..128 bytes');
  const payload = new Uint8Array(132); new DataView(payload.buffer).setUint16(0, packet.length, true);
  payload.set(packet, 4); return encodeMessage(LIVE_COMMAND.APRS_SEND, payload);
}

export function parseAprsSendReply(message) {
  if (message.command !== LIVE_COMMAND.APRS_SEND_REPLY || bytes(message.payload).length !== 4)
    throw new ProtocolError('Expected stock 0x02DE APRS result with 4 payload bytes', 'REPLY_MISMATCH');
  // Stock assigns byte0 only. Bytes1..3 are unspecified stack contents.
  const payload = bytes(message.payload).slice(), result = payload[0];
  return { result, accepted: result === 0, rfDeliveryConfirmed: false, payload };
}

/** A passive stock 0x02E1 event, never a response completing an active request.
 * The payload FCS was stripped by the radio before this notification. A length
 * of exactly128 may be a clipped larger RF packet; never claim completeness.
 */
export function parseAprsReceive(message) {
  if (message.command !== LIVE_COMMAND.APRS_RECEIVE || bytes(message.payload).length !== 132)
    throw new ProtocolError('Expected stock 0x02E1 APRS notification with 132 payload bytes', 'BAD_APRS_EVENT');
  const payload = bytes(message.payload), length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, true);
  if (length > 128) throw new ProtocolError('APRS notification length exceeds the 128-byte field', 'BAD_APRS_EVENT');
  const packet = payload.slice(4, 4 + length);
  return { type: 'aprs-received', command: message.command, packet, length,
    reserved: payload.slice(2, 4), possiblyTruncated: length === 128, fcsIncluded: false,
    checksumStatus: message.checksumStatus ?? null, decoded: decodeAprsPacket(packet) };
}
