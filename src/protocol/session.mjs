// SPDX-License-Identifier: MIT
import { COMMAND, CHUNK_SIZE, SECTOR_SIZE, STREAMING_UPDATE_START, ProtocolError,
  bytes, uint, interval, FrameStreamParser, encodeFrame, encodeMessage, buildHello, parseHelloReply,
  buildRead, parseReadReply, buildWrite, parseWriteReply, buildReboot } from './frame.mjs';
import { deriveAuthenticationResponse } from './auth.mjs';

export const SUPPORTED_DEVICE = Object.freeze({ model: 'UV-K10 Pro', firmware: '8.02.16', paramsVersion: 0 });
const same = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
const overlap = (a, n, b, m) => a < b + m && b < a + n;
const abortError = () => new ProtocolError('Operation cancelled; reconnect before continuing', 'CANCELLED');
const throwIfAborted = signal => { if (signal?.aborted) throw abortError(); };

/**
 * CPS-compatible framing, bounded requests, one transaction at a time.
 * A transport provides async read(), write(Uint8Array), close().
 * Real hardware validation is still required; see docs/protocol.md.
 */
export class ProgrammingSession {
  constructor(transport, options = {}) {
    for (const method of ['read', 'write', 'close']) if (typeof transport?.[method] !== 'function')
      throw new TypeError(`transport.${method} is required`);
    this.transport = transport;
    this.options = { selectedModel: undefined, expectedFirmware: SUPPORTED_DEVICE.firmware,
      expectedParamsVersion: SUPPORTED_DEVICE.paramsVersion, timeoutMs: 2000,
      ...transport.protocolProfile, ...options };
    this.profile = { wireMode: this.options.wireMode ?? 'xor', responseChecksum: this.options.responseChecksum ?? 'placeholder',
      maxFrameLength: this.options.maxFrameLength ?? 383 };
    if (!Number.isFinite(this.options.timeoutMs) || this.options.timeoutMs < 1)
      throw new TypeError('timeoutMs must be positive');
    this.state = 'idle'; this.identity = null; this.authenticated = false; this.pending = null; this.sequence = Promise.resolve();
    this.diagnostics = { requests: 0, replies: 0, ignoredReplies: 0, invalidFrames: 0 };
    this.parser = new FrameStreamParser({ ...this.profile, direction: 'response', onError: error => {
      this.diagnostics.invalidFrames++; this._fault(error);
    } });
  }
  get connected() { return this.state === 'connected'; }
  get writeEnabled() { return Boolean(this.connected && this.identity?.writeEnabled); }
  _enqueue(operation) {
    const result = this.sequence.then(operation); this.sequence = result.catch(() => {}); return result;
  }
  _requireConnected() {
    if (!this.connected) throw new ProtocolError('No active programming session; reconnect', 'NOT_CONNECTED');
  }
  _requireReadAccess() {
    this._requireConnected();
    if (this.identity.passwordValid !== 0 && !this.authenticated)
      throw new ProtocolError('Password authentication is required before a verified read', 'AUTH_REQUIRED');
  }
  _requireWriteAccess() {
    this._requireReadAccess();
    if (!this.writeEnabled) throw new ProtocolError('Writing is limited to explicitly selected UV-K10 Pro, firmware 8.02.16, parameter version 0', 'UNKNOWN_DEVICE');
  }
  _fault(error) {
    if (['closed', 'error'].includes(this.state)) return;
    this.state = 'error'; this.lastError = error;
    if (this.pending) this.pending.reject(error);
    // Close rather than reuse a stream with a possible delayed/stale reply.
    this.closePromise ??= Promise.resolve().then(() => this.transport.close()).catch(() => {});
  }
  async _reader() {
    try {
      while (['connecting', 'connected'].includes(this.state)) {
        const chunk = await this.transport.read();
        if (chunk === null) {
          if (['connecting', 'connected'].includes(this.state)) throw new ProtocolError('Transport ended', 'DISCONNECTED');
          return;
        }
        for (const message of this.parser.push(chunk)) {
          if (!['connecting', 'connected'].includes(this.state)) return;
          if (!this.pending) { this.diagnostics.ignoredReplies++; continue; }
          try {
            const value = this.pending.validate(message);
            this.diagnostics.replies++; this.pending.resolve(value);
          } catch (error) { this._fault(error); return; }
        }
      }
    } catch (error) { this._fault(error); }
  }
  _exchange(body, validate, { signal, timeoutMs = this.options.timeoutMs } = {}) {
    throwIfAborted(signal);
    if (this.pending) throw new ProtocolError('Internal request serialization failure', 'CONCURRENT_REQUEST');
    if (!['connecting', 'connected'].includes(this.state)) throw new ProtocolError('Session is unavailable', 'NOT_CONNECTED');
    const frame = encodeFrame(body, { ...this.profile, direction: 'request' });
    return new Promise((resolve, reject) => {
      let settled = false;
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (this.pending === pending) this.pending = null; };
      const pending = { validate,
        resolve: value => { if (!settled) { settled = true; clean(); resolve(value); } },
        reject: error => { if (!settled) { settled = true; clean(); reject(error); } } };
      const cancel = () => this._fault(abortError());
      const timer = setTimeout(() => this._fault(new ProtocolError('No valid device reply before timeout; operation outcome may be uncertain', 'TIMEOUT')), timeoutMs);
      this.pending = pending; signal?.addEventListener('abort', cancel, { once: true }); this.diagnostics.requests++;
      // Do not await a potentially stalled browser write before applying the timeout.
      Promise.resolve().then(() => {
        if (settled || !['connecting', 'connected'].includes(this.state)) return;
        return this.transport.write(frame);
      }).catch(error => this._fault(error));
    });
  }
  connect({ signal, utcSeconds = Math.floor(Date.now() / 1000) } = {}) {
    return this._enqueue(async () => {
      throwIfAborted(signal);
      if (this.connected) return this.identity;
      if (this.state !== 'idle') throw new ProtocolError('Create a new session after disconnect or failure', 'NOT_CONNECTED');
      this.sessionToken = this.options.sessionToken;
      if (this.sessionToken === undefined) {
        if (!globalThis.crypto?.getRandomValues) throw new ProtocolError('A secure random source is required', 'CRYPTO_UNAVAILABLE');
        this.sessionToken = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
      }
      uint(this.sessionToken, 32, 'session token');
      const hello = buildHello(this.sessionToken, utcSeconds);
      this.state = 'connecting'; this.readerTask = this._reader();
      const found = await this._exchange(hello, parseHelloReply, { signal });
      const versionMatched = this.options.selectedModel === SUPPORTED_DEVICE.model &&
        found.firmware === SUPPORTED_DEVICE.firmware && found.paramsVersion === SUPPORTED_DEVICE.paramsVersion &&
        found.firmware === this.options.expectedFirmware && found.paramsVersion === this.options.expectedParamsVersion;
      this.challenge = found.challenge.slice();
      this.identity = Object.freeze({ ...found, selectedModel: this.options.selectedModel,
        modelReportedByDevice: null, versionMatched, writeEnabled: versionMatched && found.passwordValid === 0,
        authenticated: false, authenticationSupported: versionMatched && Boolean(globalThis.crypto?.subtle),
        hardwareVerified: false, rtcSynchronizedTo: utcSeconds,
        note: 'HELLO has no unique product identifier; physical model selection remains necessary.' });
      this.state = 'connected'; return this.identity;
    });
  }
  readMemory(address, length, options = {}) {
    interval(address, length);
    return this._enqueue(async () => { throwIfAborted(options.signal); this._requireReadAccess(); return this._readMemory(address, length, options); });
  }
  /** One normal user-supplied-password attempt. Never guesses or automatically retries. */
  authenticate({ password, signal } = {}) {
    return this._enqueue(async () => {
      throwIfAborted(signal); this._requireConnected();
      if (typeof password !== 'string') throw new TypeError('password must be a string');
      if (!this.identity.versionMatched) throw new ProtocolError('Normal authentication is validated only for the selected stock UV-K10 Pro profile', 'UNKNOWN_DEVICE');
      if (this.identity.passwordValid === 0 || this.authenticated) return this.identity;
      if (this.identity.passwordValid !== 1) throw new ProtocolError('Unrecognized password/access state; no authentication attempt sent', 'UNKNOWN_ACCESS_STATE');
      const response = await deriveAuthenticationResponse(password, this.challenge);
      try {
        throwIfAborted(signal); this._requireConnected();
        const result = await this._exchange(encodeMessage(COMMAND.AUTH, response), message => {
          if (message.command !== COMMAND.AUTH_REPLY || message.payload.length !== 4)
            throw new ProtocolError('Unexpected password authentication reply', 'REPLY_MISMATCH');
          return message.payload[0];
        }, { signal });
        if (result !== 0) {
          const error = new ProtocolError('Device rejected the supplied password; no automatic retry was made', 'AUTH_REJECTED', { result });
          this._fault(error); throw error;
        }
        this.authenticated = true;
        this.identity = Object.freeze({ ...this.identity, authenticated: true, writeEnabled: this.identity.versionMatched });
        return this.identity;
      } finally { response.fill(0); }
    });
  }
  async _readMemory(address, length, { signal, onProgress } = {}) {
    const data = new Uint8Array(length);
    for (let done = 0; done < length;) {
      throwIfAborted(signal); const count = Math.min(CHUNK_SIZE, length - done);
      const block = await this._exchange(buildRead(address + done, count, this.sessionToken),
        message => parseReadReply(message, address + done, count), { signal });
      data.set(block, done); done += count;
      onProgress?.({ operation: 'read', address: address + done - count, completed: done, total: length });
    }
    return data;
  }
  async _accessProbe(address, length, signal) {
    // A nonzero canary OUTSIDE the write is needed because gated reads return zeroes.
    for (const candidate of [0x11000, 0x13000, 0x19000, 0x20000, 0]) {
      if (overlap(candidate, CHUNK_SIZE, address, length)) continue;
      const data = await this._readMemory(candidate, CHUNK_SIZE, { signal });
      if (data.some(n => n !== 0)) return { address: candidate, data };
    }
    throw new ProtocolError('Cannot distinguish unlocked memory from gated zero replies; no nonzero read canary outside the write', 'AMBIGUOUS_READ_ACCESS');
  }
  async _checkProbe(probe, signal) {
    const actual = await this._readMemory(probe.address, probe.data.length, { signal });
    if (!same(actual, probe.data)) throw new ProtocolError('Read-access canary changed; write ACK/readback cannot establish success', 'ACCESS_CHANGED');
  }
  writeMemory(address, value, options = {}) {
    const data = bytes(value).slice(); interval(address, data.length);
    return this._enqueue(async () => {
      throwIfAborted(options.signal); this._requireWriteAccess();
      if (overlap(address, data.length, 0x17000, 0x2000))
        throw new ProtocolError('Credential/protected blocks 0x17000..0x18fff need their independently validated normal write flow', 'PROTECTED_REGION_UNSUPPORTED');
      const { signal, onProgress, onBackup } = options;
      const probe = await this._accessProbe(address, data.length, signal), plans = [], backups = [];
      let cursor = address;
      // Read every required backup before the first write. Unknown areas are never synthesized.
      while (cursor < address + data.length) {
        const high = cursor >= STREAMING_UPDATE_START;
        const base = high ? Math.floor(cursor / SECTOR_SIZE) * SECTOR_SIZE : cursor;
        const end = high ? base + SECTOR_SIZE : Math.min(address + data.length, STREAMING_UPDATE_START);
        const original = await this._readMemory(base, end - base, { signal });
        const desired = original.slice(), startInInput = Math.max(base, address) - address;
        const endInInput = Math.min(end, address + data.length) - address;
        desired.set(data.subarray(startInInput, endInInput), address + startInInput - base);
        if (!same(original, desired)) {
          const backup = { address: base, data: original.slice(), kind: high ? 'sector' : 'range' };
          backups.push(backup); plans.push({ address: base, original, desired, high });
        }
        cursor = end;
      }
      await this._checkProbe(probe, signal);
      for (const backup of backups) { throwIfAborted(signal); await onBackup?.({ ...backup, data: backup.data.slice() }); }
      await this._checkProbe(probe, signal);
      let modified = false, writtenBytes = 0;
      try {
        for (const plan of plans) {
          for (let done = 0; done < plan.desired.length;) {
            throwIfAborted(signal);
            const target = plan.address + done;
            const count = Math.min(CHUNK_SIZE, plan.desired.length - done, SECTOR_SIZE - target % SECTOR_SIZE);
            const block = plan.desired.subarray(done, done + count);
            // High sectors must be reconstructed in full, in ascending order, after any erase.
            if (plan.high || !same(block, plan.original.subarray(done, done + count))) {
              modified = true;
              await this._exchange(buildWrite(target, block, this.sessionToken), message => parseWriteReply(message, target), { signal });
              const actual = await this._readMemory(target, count, { signal });
              if (!same(actual, block)) throw new ProtocolError('Device ACKed but readback differs; a protected/gated write may have been skipped', 'VERIFY_MISMATCH', { address: target });
              await this._checkProbe(probe, signal);
              writtenBytes += count;
            }
            done += count;
            onProgress?.({ operation: 'write-verified', address: target, completed: Math.min(data.length, Math.max(0, target + count - address)), total: data.length, physicalBytes: writtenBytes });
          }
          if (plan.high) {
            const actual = await this._readMemory(plan.address, SECTOR_SIZE, { signal });
            if (!same(actual, plan.desired)) throw new ProtocolError('Full sector verification failed after reconstruction', 'VERIFY_MISMATCH', { address: plan.address });
          }
        }
        await this._checkProbe(probe, signal);
        return { verified: true, address, length: data.length, writtenBytes, unchanged: plans.length === 0,
          checksumStatus: this.identity.checksumStatus, backups };
      } catch (error) {
        error.mayHaveModifiedDevice = modified; error.recovery = backups;
        // A write/verify failure must not be followed automatically by another queued write.
        this._fault(error); throw error;
      }
    });
  }
  /** CPS sends 0x05DD after writing. There is no reply; completion is not proof of reboot. */
  reboot({ signal } = {}) {
    return this._enqueue(async () => {
      throwIfAborted(signal); this._requireWriteAccess();
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
          const fail = error => { cleanup(); this._fault(error); reject(error); };
          const cancel = () => fail(abortError());
          const timer = setTimeout(() => fail(new ProtocolError('Reboot command write timed out; outcome unknown', 'TIMEOUT')), this.options.timeoutMs);
          signal?.addEventListener('abort', cancel, { once: true });
          Promise.resolve().then(() => this.transport.write(encodeFrame(buildReboot(), { ...this.profile, direction: 'request' })))
            .then(() => { cleanup(); resolve(); }, fail);
        });
        return { commandSent: true, rebootConfirmed: false };
      } finally { await this.close(); }
    });
  }
  async close() {
    this.state = 'closed';
    this.pending?.reject(new ProtocolError('Session closed', 'DISCONNECTED'));
    this.closePromise ??= Promise.resolve().then(() => this.transport.close());
    await this.closePromise;
  }
}
