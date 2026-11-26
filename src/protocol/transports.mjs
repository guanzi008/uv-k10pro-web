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

function bleUuid(value, key) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value !== 'string' || !uuid.test(value.trim()))
    throw new ProtocolError(`Explicit canonical ${key} required`, 'BLE_PROFILE_REQUIRED');
  return value.trim().toLowerCase();
}

/** Whitelist settings, so UI state, BluetoothDevice handles and passwords cannot be exported. */
export function normalizeBleProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile))
    throw new ProtocolError('BLE profile must be an object', 'BLE_PROFILE_REQUIRED');
  const result = {};
  for (const key of ['serviceUuid', 'writeUuid', 'notifyUuid']) result[key] = bleUuid(profile[key], key);
  if (!['withResponse', 'withoutResponse'].includes(profile.writeMode))
    throw new ProtocolError('Explicit BLE writeMode required', 'BLE_PROFILE_REQUIRED');
  if (!['plain', 'xor'].includes(profile.wireMode) || !['placeholder', 'crc16-x25', 'crc16-x25-or-placeholder'].includes(profile.responseChecksum))
    throw new ProtocolError('Explicit BLE wireMode and responseChecksum required', 'BLE_PROFILE_REQUIRED');
  const size = profile.mtuPayload ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 244) throw new ProtocolError('BLE payload size must be 1..244', 'BLE_PROFILE_REQUIRED');
  const writeStrategy = profile.writeStrategy ?? 'chunked', interWriteDelayMs = profile.interWriteDelayMs ?? 0;
  const lengthConvention = profile.lengthConvention ?? 'cps-0.56';
  if (!['chunked', 'whole-frame'].includes(writeStrategy) ||
      (writeStrategy === 'whole-frame' && profile.writeMode !== 'withResponse'))
    throw new ProtocolError('BLE whole-frame writes require withResponse', 'BLE_PROFILE_REQUIRED');
  if (!Number.isInteger(interWriteDelayMs) || interWriteDelayMs < 0 || interWriteDelayMs > 1000)
    throw new ProtocolError('BLE frame delay must be 0..1000 ms', 'BLE_PROFILE_REQUIRED');
  if (!['cps-0.56', 'android-k8'].includes(lengthConvention))
    throw new ProtocolError('Explicit K8 request length convention required', 'BLE_PROFILE_REQUIRED');
  return Object.freeze({ ...result, writeMode: profile.writeMode, wireMode: profile.wireMode,
    responseChecksum: profile.responseChecksum, mtuPayload: size, writeStrategy, interWriteDelayMs, lengthConvention });
}

/** APK 1.1.0-68 AOT call/data flow, not a hardware acceptance claim. See docs/ble-profile.md. */
export const DEFAULT_K8_BLE_PROFILE = normalizeBleProfile({
  serviceUuid: '0000ff12-0000-1000-8000-00805f9b34fb',
  writeUuid: '0000fff2-0000-1000-8000-00805f9b34fb',
  notifyUuid: '0000fff3-0000-1000-8000-00805f9b34fb',
  writeMode: 'withResponse', wireMode: 'plain', responseChecksum: 'crc16-x25-or-placeholder',
  writeStrategy: 'whole-frame', interWriteDelayMs: 120, mtuPayload: 20, lengthConvention: 'android-k8',
});

const BLE_PROFILE_FORMAT = 'uv-k10pro-ble-profile';
const BLE_MODEL = 'UV-K10-PRO-K8';

/** A connection configuration is portable; it does not certify the attached radio's model. */
export function serializeBleProfile(profile) {
  return JSON.stringify({ format: BLE_PROFILE_FORMAT, version: 1, model: BLE_MODEL,
    profile: normalizeBleProfile(profile) }, null, 2) + '\n';
}

export function parseBleProfile(text) {
  if (typeof text !== 'string' || text.length > 16384 || new TextEncoder().encode(text).length > 16384)
    throw new ProtocolError('BLE profile must be a JSON file no larger than 16 KiB', 'INVALID_BLE_PROFILE_FILE');
  let document;
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new ProtocolError('Invalid BLE profile JSON', 'INVALID_BLE_PROFILE_FILE'); }
  if (!document || document.format !== BLE_PROFILE_FORMAT || document.version !== 1 || document.model !== BLE_MODEL)
    throw new ProtocolError('BLE profile format, version or radio model does not match UV-K10 Pro / K8', 'INVALID_BLE_PROFILE_FILE');
  return normalizeBleProfile(document.profile);
}

const GATT_PROPERTIES = Object.freeze(['broadcast', 'read', 'writeWithoutResponse', 'write',
  'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries']);

/** Inspect exactly the user-supplied service; never probe candidate UUIDs or send K8 commands. */
export async function discoverBleCharacteristics({ serviceUuid, bluetooth = globalThis.navigator?.bluetooth,
  device: grantedDevice } = {}) {
  serviceUuid = bleUuid(serviceUuid, 'serviceUuid');
  if (!grantedDevice && !bluetooth) throw unavailable('Web Bluetooth');
  // A peripheral need not advertise every service. The chooser is still explicit,
  // and optionalServices grants access only to this one supplied service.
  const device = grantedDevice ?? await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [serviceUuid] });
  if (!device?.gatt) throw new ProtocolError('Selected Bluetooth device has no GATT server', 'BLE_GATT_UNAVAILABLE');
  if (device.gatt.connected)
    throw new ProtocolError('Disconnect the active Bluetooth session before inspecting its service', 'BLE_DISCOVERY_BUSY');
  try {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(serviceUuid);
    const characteristics = await service.getCharacteristics();
    return { device, serviceUuid, characteristics: characteristics.map(characteristic => ({
      uuid: bleUuid(characteristic.uuid, 'characteristic UUID'),
      properties: Object.fromEntries(GATT_PROPERTIES.map(key => [key, characteristic.properties?.[key] === true])),
    })) };
  } finally {
    // No notification subscription, characteristic read, HELLO, or data write is
    // performed here. Reconnection must acquire fresh service/characteristic objects.
    if (device.gatt.connected) device.gatt.disconnect();
  }
}

function checkBleCharacteristics(tx, rx, profile) {
  const writeProperty = profile.writeMode === 'withResponse' ? 'write' : 'writeWithoutResponse';
  const writeMethod = profile.writeMode === 'withResponse' ? 'writeValueWithResponse' : 'writeValueWithoutResponse';
  if (tx?.properties?.[writeProperty] !== true || typeof tx?.[writeMethod] !== 'function')
    throw new ProtocolError(`Selected BLE characteristic does not support ${profile.writeMode}`, 'BLE_CHARACTERISTIC_MISMATCH');
  if (!(rx?.properties?.notify === true || rx?.properties?.indicate === true) || typeof rx?.startNotifications !== 'function')
    throw new ProtocolError('Selected BLE receive characteristic does not support notifications or indications', 'BLE_CHARACTERISTIC_MISMATCH');
}

/** Model-scoped APK preset or explicit profile; GATT properties are rechecked on connection. */
export class WebBluetoothTransport {
  constructor(device, profile) {
    this.profile = normalizeBleProfile(profile); this.device = device; this.kind = 'ble'; this.opened = false;
    this.protocolProfile = Object.freeze({ wireMode: this.profile.wireMode, responseChecksum: this.profile.responseChecksum,
      lengthConvention: this.profile.lengthConvention, maxFrameLength: 199 });
    this.queue = new ByteQueue(); this.writeSequence = Promise.resolve(); this.connectionGeneration = 0;
  }
  static async request({ bluetooth = globalThis.navigator?.bluetooth, device: grantedDevice, ...input } = {}) {
    const profile = normalizeBleProfile(input); if (!grantedDevice && !bluetooth) throw unavailable('Web Bluetooth');
    // The official K8 App scans without service filters. A GATT service need
    // not appear in advertisements; grant only this explicit service, then
    // check its exact characteristics instead of guessing other services.
    const device = grantedDevice ?? await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [profile.serviceUuid] });
    const transport = new WebBluetoothTransport(device, profile); await transport.open(); return transport;
  }
  async open() {
    if (this.opened) return this;
    if (!this.device?.gatt) throw new ProtocolError('Selected Bluetooth device has no GATT server', 'BLE_GATT_UNAVAILABLE');
    if (this.queue.closed) this.queue = new ByteQueue();
    this.connectionGeneration++;
    this.disconnected = () => { this.connectionGeneration++; this.opened = false; this.queue.close(disconnected()); };
    this.device.addEventListener('gattserverdisconnected', this.disconnected);
    try {
      this.server = await this.device.gatt.connect();
      const service = await this.server.getPrimaryService(this.profile.serviceUuid);
      this.tx = await service.getCharacteristic(this.profile.writeUuid);
      this.rx = this.profile.writeUuid === this.profile.notifyUuid ? this.tx : await service.getCharacteristic(this.profile.notifyUuid);
      checkBleCharacteristics(this.tx, this.rx, this.profile);
      this.notify = event => this.queue.push(event.target.value);
      this.rx.addEventListener('characteristicvaluechanged', this.notify);
      await this.rx.startNotifications();
      if (!this.device.gatt.connected || this.queue.closed) throw disconnected();
      this.opened = true; return this;
    } catch (error) { await this.close(); throw error; }
  }
  async read() { return this.queue.read(); }
  async write(value) {
    assertOpen(this); const data = bytes(value).slice();
    if (this.profile.writeStrategy === 'whole-frame' && data.length > 512)
      throw new ProtocolError('BLE characteristic values cannot exceed 512 bytes', 'FRAME_TOO_LONG');
    // Replies can arrive before the platform write promise completes. Preserve
    // frame ordering and the APK's post-frame pacing across that race.
    const generation = this.connectionGeneration;
    const operation = this.writeSequence.then(() => this._write(data, generation));
    this.writeSequence = operation.catch(() => {}); return operation;
  }
  async _write(data, generation) {
    const checkConnection = () => {
      assertOpen(this);
      if (generation !== this.connectionGeneration) throw disconnected();
    };
    checkConnection(); if (!data.length) return;
    const { mtuPayload, writeMode, writeStrategy, interWriteDelayMs } = this.profile;
    try {
      if (writeStrategy === 'whole-frame') {
        // Web Bluetooth has no requestMtu/allowLongWrite control. Hand the whole
        // value to the browser; do not retry failed long writes as byte chunks.
        await this.tx.writeValueWithResponse(data);
      } else {
        for (let i = 0; i < data.length; i += mtuPayload) {
          checkConnection(); const chunk = data.slice(i, i + mtuPayload);
          if (writeMode === 'withResponse') await this.tx.writeValueWithResponse(chunk);
          else await this.tx.writeValueWithoutResponse(chunk);
        }
      }
      if (interWriteDelayMs) await new Promise(resolve => setTimeout(resolve, interWriteDelayMs));
    } catch (error) {
      // A failed value write may have had a partial effect. Do not continue a
      // queued stream after it, or silently change framing/packet boundaries.
      if (generation === this.connectionGeneration) await this.close();
      throw error;
    }
  }
  async close() {
    this.connectionGeneration++; this.opened = false; this.queue.close();
    this.rx?.removeEventListener('characteristicvaluechanged', this.notify);
    this.device.removeEventListener('gattserverdisconnected', this.disconnected);
    // Disconnect first to cancel in-flight GATT work; subscriptions end with the connection.
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }
}
