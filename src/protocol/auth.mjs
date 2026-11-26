// SPDX-License-Identifier: MIT
// Normal user-supplied-password interoperability, recovered from CPS 0.56.
// Independently checked against ss.dll x86 arithmetic and stock ARM authentication.
// This is the vendor-specific derivation, NOT a general-purpose password hash or standard HMAC.
import { bytes, ProtocolError } from './frame.mjs';

const SALT = Uint8Array.from('8e406920d0412a4d99586039f16420fb22e2918498fb2ab6655074fff1b8f8a2'.match(/../g), n => parseInt(n, 16));
const IV = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2);
const rotr = (n, bits) => (n >>> bits) | (n << (32 - bits));

export function reverseWords(value) {
  const input = bytes(value); if (input.length % 4) throw new TypeError('Word reversal requires a multiple of four bytes');
  const output = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 4) for (let j = 0; j < 4; j++) output[i + j] = input[i + 3 - j];
  return output;
}

/** Apply the CPS .NET whitespace and UTF-8 length contract. */
export function normalizePassword(password) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  // .NET 4 String.Trim whitespace set (do not silently trim U+FEFF as JavaScript trim does).
  const normalized = password.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
  const encoded = new TextEncoder().encode(normalized);
  const tooLong = encoded.length > 32; encoded.fill(0);
  if (tooLong) throw new ProtocolError('CPS password must fit in 32 UTF-8 bytes after trimming', 'INVALID_PASSWORD');
  return normalized;
}

/** Compute the exact CPS ss.dll MAC(119) path, including its unusual final compression. */
export function computePasswordDigest(password) {
  const normalized = normalizePassword(password);
  const passwordBytes = new TextEncoder().encode(normalized);
  const block = new Uint8Array(128).fill(0x5a); block.fill(0, 0, 32);
  block.set(passwordBytes); passwordBytes.fill(0);
  block.set(new TextEncoder().encode('xiaoxiao'), 32); block.set(SALT, 64);
  for (let i = 0; i < 108; i += 4) block.subarray(i, i + 4).reverse();
  // SHA-256 padding of exactly 119 bytes produces exactly two blocks.
  block[119] = 0x80; block.fill(0, 120, 128);
  const inputView = new DataView(block.buffer); inputView.setUint32(124, 119 * 8, false);
  const state = IV.slice(), schedule = new Uint32Array(64);
  for (let offset = 0; offset < 128; offset += 64) {
    for (let i = 0; i < 16; i++) schedule[i] = inputView.getUint32(offset + 4 * i, false);
    for (let i = 16; i < 64; i++) {
      const x = schedule[i - 15], y = schedule[i - 2];
      const sigma0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3), sigma1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      schedule[i] = (schedule[i - 16] + sigma0 + schedule[i - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + K[i] + schedule[i]) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const work = [a, b, c, d, e, f, g, h];
    // Native arg3=1 deliberately omits final-block feed-forward; this is NOT standard SHA256.
    for (let i = 0; i < 8; i++) state[i] = offset === 64 ? work[i] : (state[i] + work[i]) >>> 0;
  }
  const result = new Uint8Array(32), outputView = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) outputView.setUint32(i * 4, state[i], false);
  block.fill(0); schedule.fill(0); state.fill(0);
  return result.reverse(); // Native arg4=1 reverses the entire 32-byte digest.
}

export function derivePasswordKey(password) {
  const digest = computePasswordDigest(password), key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = digest[i] ^ digest[31 - i];
  digest.fill(0); return key;
}

/** Returns the exact 16-byte AUTH payload; no password or derived key is persisted. */
export async function deriveAuthenticationResponseFromKey(key, challenge, { subtle = globalThis.crypto?.subtle } = {}) {
  key = bytes(key);
  if (key.length !== 16) throw new ProtocolError('Expected exactly 16 derived key bytes', 'INVALID_PASSWORD_KEY');
  challenge = bytes(challenge);
  if (challenge.length !== 16) throw new ProtocolError('Expected exactly 16 challenge bytes from HELLO', 'INVALID_CHALLENGE');
  if (!subtle) throw new ProtocolError('Web Crypto is unavailable; use a supported secure browser context', 'CRYPTO_UNAVAILABLE');
  const aesKey = reverseWords(key);
  try {
    const imported = await subtle.importKey('raw', aesKey, { name: 'AES-CBC' }, false, ['encrypt']);
    const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, imported, reverseWords(challenge)));
    // .NET Rijndael CBC/PKCS7 and Web Crypto both add a padding block. CPS sends only block 0.
    const response = reverseWords(cipher.subarray(0, 16)); cipher.fill(0); return response;
  } finally { aesKey.fill(0); }
}

export async function deriveAuthenticationResponse(password, challenge, options = {}) {
  const key = derivePasswordKey(password);
  try { return await deriveAuthenticationResponseFromKey(key, challenge, options); }
  finally { key.fill(0); }
}
