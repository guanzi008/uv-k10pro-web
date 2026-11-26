// SPDX-License-Identifier: MIT
// Explicit synthetic host/device model. This does NOT emulate the ARM CPU or prove hardware compatibility.
import { COMMAND, FLASH_LIMIT, SECTOR_SIZE, STREAMING_UPDATE_START, ProtocolError,
  bytes, decodeFrame, encodeFrame, encodeMessage } from './frame.mjs';
import { ByteQueue } from './transports.mjs';
import { derivePasswordKey, deriveAuthenticationResponseFromKey } from './auth.mjs';

const dv = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export class MockTransport {
  constructor({ memory, firmware = '8.02.16', paramsVersion = 0, passwordValid = 0,
    startLockFlag = 0, password = 'synthetic-demo-password', challenge = Uint8Array.from({ length: 16 }, (_, i) => i), wireMode = 'xor', responseChecksum = 'placeholder',
    fragments = [1, 3, 7, 19], delayMs = 0, responseHook, onRequest } = {}) {
    this.memory = memory ? bytes(memory).slice() : new Uint8Array(FLASH_LIMIT).fill(0xff);
    this.kind = 'mock'; this.opened = true; this.queue = new ByteQueue(); this.requests = [];
    this.protocolProfile = { wireMode, responseChecksum, maxFrameLength: 383 };
    Object.assign(this, { firmware, paramsVersion, passwordValid, startLockFlag, fragments, delayMs, responseHook, onRequest });
    this.passwordKey = derivePasswordKey(password); this.challenge = bytes(challenge).slice(); this.authenticated = passwordValid === 0;
    if (passwordValid === 1 && this.memory.length >= 0x18010) this.memory.set(this.passwordKey, 0x18000);
    if (this.challenge.length !== 16) throw new TypeError('Synthetic challenge must be 16 bytes');
    if (!Array.isArray(fragments) || !fragments.length || fragments.some(n => !Number.isInteger(n) || n < 1)) throw new TypeError('Invalid fragmentation sizes');
    this.ackOnlyWrites = false; this.gatedReads = false; this.dropReplies = false; this.timers = new Set();
  }
  async read() { return this.queue.read(); }
  async write(value) {
    if (!this.opened) throw new ProtocolError('Model transport closed', 'DISCONNECTED');
    const message = decodeFrame(value, { ...this.protocolProfile, direction: 'request' }), p = message.payload;
    const request = { command: message.command };
    if ([COMMAND.READ, COMMAND.WRITE].includes(message.command)) {
      request.address = dv(p).getUint32(0, true); request.count = dv(p).getUint16(4, true); request.session = dv(p).getUint32(8, true);
      if (message.command === COMMAND.WRITE) request.flag = p[6];
    }
    this.requests.push(request); await this.onRequest?.(request, this);
    let body;
    if (message.command === COMMAND.HELLO) {
      this.sessionToken = dv(p).getUint32(0, true); this.rtc = dv(p).getUint32(4, true);
      const reply = new Uint8Array(52); reply.set(new TextEncoder().encode(this.firmware).subarray(0, 16));
      reply[16] = this.passwordValid; reply[17] = this.startLockFlag; reply[18] = this.paramsVersion;
      reply.set(this.challenge, 20);
      body = encodeMessage(COMMAND.HELLO_REPLY, reply);
    } else if (message.command === COMMAND.AUTH) {
      const expected = await deriveAuthenticationResponseFromKey(this.passwordKey, this.challenge);
      this.authenticated = this.passwordValid === 1 && p.length === 16 && p.every((n, i) => n === expected[i]); expected.fill(0);
      body = encodeMessage(COMMAND.AUTH_REPLY, Uint8Array.of(this.authenticated ? 0 : 1, 0, 0, 0));
    } else if ([COMMAND.READ, COMMAND.WRITE].includes(message.command)) {
      const { address, count, session } = request;
      if (session !== this.sessionToken || address >= FLASH_LIMIT) return;
      if (count < 1 || count > 128 || address + count > this.memory.length)
        throw new ProtocolError('Model request outside supplied snapshot', 'MODEL_BOUNDS');
      if (message.command === COMMAND.READ) {
        const reply = new Uint8Array(8 + count); dv(reply).setUint32(0, address, true); dv(reply).setUint16(4, count, true);
        if (!this.gatedReads && this.authenticated) reply.set(this.memory.subarray(address, address + count), 8);
        body = encodeMessage(COMMAND.READ_REPLY, reply);
      } else {
        const startupLocked = address >= 0x17000 && address < 0x18000 && this.startLockFlag !== 0 && request.flag === 0;
        if (!this.ackOnlyWrites && this.authenticated && !startupLocked) {
          // Model the confirmed mode-1 tail-loss behavior, including its erased-target fast path.
          if (address >= STREAMING_UPDATE_START && this.memory.subarray(address, address + count).some(n => n !== 0xff)) {
            const base = Math.floor(address / SECTOR_SIZE) * SECTOR_SIZE;
            const prefix = this.memory.slice(base, address);
            this.memory.fill(0xff, base, base + SECTOR_SIZE); this.memory.set(prefix, base);
          }
          this.memory.set(p.subarray(12, 12 + count), address);
          if (address >= 0x18000 && address < 0x19000) {
            this.passwordKey.fill(0); this.passwordKey = this.memory.slice(0x18000, 0x18010);
            this.passwordValid = this.passwordKey.every(n => n === 255) ? 0 : 1;
          }
        }
        const reply = new Uint8Array(4); dv(reply).setUint32(0, address, true); body = encodeMessage(COMMAND.WRITE_REPLY, reply);
      }
    } else if (message.command === COMMAND.REBOOT) { this.rebootRequested = true; return; }
    else throw new ProtocolError('Command is not implemented in synthetic model', 'MODEL_COMMAND');
    if (this.dropReplies) return;
    body = this.responseHook?.(body, request) ?? body;
    const wire = encodeFrame(body, { ...this.protocolProfile, direction: 'response' });
    const deliver = () => {
      let offset = 0, index = 0;
      while (offset < wire.length) { const count = this.fragments[index++ % this.fragments.length]; this.queue.push(wire.slice(offset, offset + count)); offset += count; }
    };
    if (this.delayMs) { const timer = setTimeout(() => { this.timers.delete(timer); deliver(); }, this.delayMs); this.timers.add(timer); }
    else deliver();
  }
  async close() {
    this.opened = false; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); this.queue.close();
  }
}
