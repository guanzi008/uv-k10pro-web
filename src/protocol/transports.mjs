// SPDX-License-Identifier: MIT
import { bytes, ProtocolError } from './frame.mjs';

const unavailable = name => new ProtocolError(`${name} is unavailable in this browser or context`, 'API_UNAVAILABLE');
const disconnected = () => new ProtocolError('Device transport disconnected', 'DISCONNECTED');
const assertOpen = transport => { if (!transport.opened) throw disconnected(); };

/** Each adapter has async read(): Uint8Array|null, write(bytes), close(). One reader only. */
export class WebSerialTransport {
  constructor(port, { baudRate = 38400 } = {}) {
    if (!Number.isInteger(baudRate) || baudRate <= 0) throw new TypeError('Invalid baud rate');
    this.port = port; this.baudRate = baudRate; this.kind = 'serial'; this.opened = false;
    this.protocolProfile = Object.freeze({ wireMode: 'xor', responseChecksum: 'placeholder', maxFrameLength: 383 });
  }
  static async request({ serial = globalThis.navigator?.serial, filters, ...options } = {}) {
    if (!serial) throw unavailable('Web Serial');
    const port = await serial.requestPort(filters ? { filters } : {});
    const transport = new WebSerialTransport(port, options); await transport.open(); return transport;
  }
  async open() {
    if (this.opened) return this;
    await this.port.open({ baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    this.opened = true;
    try {
      await this.port.setSignals({ requestToSend: false, dataTerminalReady: false });
      this.reader = this.port.readable.getReader(); this.writer = this.port.writable.getWriter();
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async read() {
    assertOpen(this); const { value, done } = await this.reader.read();
    return done ? null : bytes(value).slice();
  }
  async write(value) { assertOpen(this); await this.writer.write(bytes(value)); }
  async close() {
    if (this.closing) return this.closing;
    if (!this.opened) return; this.opened = false;
    this.closing = (async () => {
      await Promise.allSettled([this.reader?.cancel(), this.writer?.abort()]);
      try { this.reader?.releaseLock(); } catch { /* Already released by browser on removal. */ }
      try { this.writer?.releaseLock(); } catch { /* Already released by browser on removal. */ }
      await this.port.close();
    })();
    return this.closing;
  }
}

function usbResult(result, operation, expectedBytes) {
  if (result.status !== 'ok' || (expectedBytes !== undefined && result.bytesWritten !== expectedBytes))
    throw new ProtocolError(`USB ${operation} failed or transferred a short packet`, 'USB_TRANSFER_FAILED', { status: result.status });
  return result;
}

/** Stock descriptor profile only. VID/PID is a filter, not proof of radio model. */
export class WebUsbTransport {
  constructor(device, { baudRate = 38400 } = {}) {
    this.device = device; this.baudRate = baudRate; this.kind = 'usb'; this.opened = false; this.claimed = [];
    this.protocolProfile = Object.freeze({ wireMode: 'xor', responseChecksum: 'placeholder', maxFrameLength: 383 });
  }
  static async request({ usb = globalThis.navigator?.usb, ...options } = {}) {
    if (!usb) throw unavailable('WebUSB');
    const device = await usb.requestDevice({ filters: [{ vendorId: 0x36b7, productId: 0x0001 }] });
    const transport = new WebUsbTransport(device, options); await transport.open(); return transport;
  }
  async open() {
    if (this.opened) return this;
    const d = this.device;
    if (d.vendorId !== 0x36b7 || d.productId !== 0x0001)
      throw new ProtocolError('USB IDs differ from the inspected stock descriptor', 'UNKNOWN_USB_PROFILE');
    await d.open(); this.opened = true;
    try {
      if (!d.configuration || d.configuration.configurationValue !== 1) await d.selectConfiguration(1);
      const comm = d.configuration.interfaces.find(i => i.interfaceNumber === 0);
      const data = d.configuration.interfaces.find(i => i.interfaceNumber === 1);
      const ca = comm?.alternates.find(a => a.interfaceClass === 2 && a.interfaceSubclass === 2);
      const da = data?.alternates.find(a => a.interfaceClass === 0x0a &&
        a.endpoints.some(e => e.type === 'bulk' && e.direction === 'in' && e.endpointNumber === 1) &&
        a.endpoints.some(e => e.type === 'bulk' && e.direction === 'out' && e.endpointNumber === 2));
      if (!ca || !da) throw new ProtocolError('USB interface/endpoint profile differs from stock', 'UNKNOWN_USB_PROFILE');
      for (const [iface, alt] of [[comm, ca], [data, da]]) {
        await d.claimInterface(iface.interfaceNumber); this.claimed.push(iface.interfaceNumber);
        await d.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
      }
      const line = new Uint8Array(7); new DataView(line.buffer).setUint32(0, this.baudRate, true); line[6] = 8;
      usbResult(await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: 0 }, line), 'SET_LINE_CODING', 7);
      // DTR/RTS are false, matching CPS SerialPort defaults; not a modem-reset pulse.
      usbResult(await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0, index: 0 }), 'SET_CONTROL_LINE_STATE');
      return this;
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  async read() {
    assertOpen(this);
    const result = usbResult(await this.device.transferIn(1, 64), 'IN');
    return result.data ? bytes(result.data).slice() : new Uint8Array();
  }
  async write(value) {
    assertOpen(this); const data = bytes(value);
    // Browser/device bulk transport performs 64-byte USB packetization.
    usbResult(await this.device.transferOut(2, data), 'OUT', data.length);
  }
  async close() {
    if (this.closing) return this.closing;
    if (!this.opened) return; this.opened = false;
    this.closing = (async () => {
      // USBDevice.close aborts in-flight transfers; releaseInterface can otherwise wait on IN.
      await this.device.close(); this.claimed = [];
    })();
    return this.closing;
  }
}

/** Bounded notification queue: overflow fails instead of silently losing framing bytes. */
export class ByteQueue {
  constructor(maxBytes = 32768) { this.maxBytes = maxBytes; this.items = []; this.length = 0; this.waiter = null; this.closed = false; }
  push(value) {
    if (this.closed) return;
    const data = bytes(value).slice(); if (!data.length) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(data); return; }
    if (this.length + data.length > this.maxBytes) { this.close(new ProtocolError('Transport input overflow', 'INPUT_OVERFLOW')); return; }
    this.items.push(data); this.length += data.length;
  }
  read() {
    if (this.items.length) { const data = this.items.shift(); this.length -= data.length; return Promise.resolve(data); }
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve(null);
    if (this.waiter) return Promise.reject(new ProtocolError('Only one transport reader is allowed', 'CONCURRENT_READ'));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  close(error = null) {
    this.closed = true; this.error = error; this.items = []; this.length = 0;
    if (this.waiter) { const w = this.waiter; this.waiter = null; error ? w.reject(error) : w.resolve(null); }
  }
}

function validateBleProfile(profile) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const key of ['serviceUuid', 'writeUuid', 'notifyUuid'])
    if (!uuid.test(profile[key] ?? '')) throw new ProtocolError(`Explicit canonical ${key} required; no inferred UV-K10 Pro BLE UUID`, 'BLE_PROFILE_REQUIRED');
  if (!['withResponse', 'withoutResponse'].includes(profile.writeMode))
    throw new ProtocolError('Explicit BLE writeMode required', 'BLE_PROFILE_REQUIRED');
  if (!['plain', 'xor'].includes(profile.wireMode) || !['placeholder', 'crc16-x25'].includes(profile.responseChecksum))
    throw new ProtocolError('Explicit BLE wireMode and responseChecksum required', 'BLE_PROFILE_REQUIRED');
  const size = profile.mtuPayload ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 244) throw new ProtocolError('BLE payload size must be 1..244', 'BLE_PROFILE_REQUIRED');
  return { ...profile, mtuPayload: size };
}

/** Configurable experimental adapter. Multi-model APK strings do not establish a K10 GATT profile. */
export class WebBluetoothTransport {
  constructor(device, profile) {
    this.profile = validateBleProfile(profile); this.device = device; this.kind = 'ble'; this.opened = false;
    this.protocolProfile = Object.freeze({ wireMode: this.profile.wireMode, responseChecksum: this.profile.responseChecksum, maxFrameLength: 199 });
    this.queue = new ByteQueue();
  }
  static async request({ bluetooth = globalThis.navigator?.bluetooth, ...input } = {}) {
    const profile = validateBleProfile(input); if (!bluetooth) throw unavailable('Web Bluetooth');
    const device = await bluetooth.requestDevice({ filters: [{ services: [profile.serviceUuid] }], optionalServices: [profile.serviceUuid] });
    const transport = new WebBluetoothTransport(device, profile); await transport.open(); return transport;
  }
  async open() {
    if (this.opened) return this;
    this.disconnected = () => { this.opened = false; this.queue.close(disconnected()); };
    this.device.addEventListener('gattserverdisconnected', this.disconnected);
    try {
      this.server = await this.device.gatt.connect();
      const service = await this.server.getPrimaryService(this.profile.serviceUuid);
      this.tx = await service.getCharacteristic(this.profile.writeUuid);
      this.rx = this.profile.writeUuid === this.profile.notifyUuid ? this.tx : await service.getCharacteristic(this.profile.notifyUuid);
      this.notify = event => this.queue.push(event.target.value);
      this.rx.addEventListener('characteristicvaluechanged', this.notify);
      await this.rx.startNotifications(); this.opened = true; return this;
    } catch (error) { await this.close(); throw error; }
  }
  async read() { return this.queue.read(); }
  async write(value) {
    assertOpen(this); const data = bytes(value), { mtuPayload, writeMode } = this.profile;
    for (let i = 0; i < data.length; i += mtuPayload) {
      assertOpen(this); const chunk = data.slice(i, i + mtuPayload);
      if (writeMode === 'withResponse') await this.tx.writeValueWithResponse(chunk);
      else await this.tx.writeValueWithoutResponse(chunk);
    }
  }
  async close() {
    this.opened = false; this.queue.close();
    this.rx?.removeEventListener('characteristicvaluechanged', this.notify);
    this.device.removeEventListener('gattserverdisconnected', this.disconnected);
    // Disconnect first to cancel in-flight GATT work; subscriptions end with the connection.
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }
}
