// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSerialTransport, WebUsbTransport, WebBluetoothTransport } from '../src/protocol/index.mjs';

test('Web Serial opens stock settings, transfers arbitrary binary chunks, and releases both locks', async () => {
  const written = [], calls = []; let incoming;
  const port = {
    readable: new ReadableStream({ start(controller) { incoming = controller; } }),
    writable: new WritableStream({ write(value) { written.push(value.slice()); } }),
    async open(settings) { calls.push(['open', settings]); }, async setSignals(signals) { calls.push(['signals', signals]); },
    async close() { assert.equal(this.readable.locked, false); assert.equal(this.writable.locked, false); calls.push(['close']); },
  };
  const transport = await WebSerialTransport.request({ serial: { async requestPort() { return port; } } });
  assert.equal(calls[0][1].baudRate, 38400); assert.equal(calls[0][1].flowControl, 'none');
  incoming.enqueue(Uint8Array.of(0, 255, 171)); assert.deepEqual(await transport.read(), Uint8Array.of(0, 255, 171));
  await transport.write(Uint8Array.of(205, 0)); assert.deepEqual(written, [Uint8Array.of(205, 0)]);
  const pendingRead = transport.read(); await transport.close(); assert.equal(await pendingRead, null); assert.equal(calls.at(-1)[0], 'close');
});

test('WebUSB validates CDC descriptors and uses numeric endpoint plus exact CDC line coding', async () => {
  const calls = [], device = {
    vendorId: 0x36b7, productId: 1, configuration: null,
    async open() { calls.push(['open']); }, async selectConfiguration(value) {
      this.configuration = { configurationValue: value, interfaces: [
        { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 2, interfaceSubclass: 2, endpoints: [] }] },
        { interfaceNumber: 1, alternates: [{ alternateSetting: 0, interfaceClass: 10, endpoints: [
          { endpointNumber: 1, type: 'bulk', direction: 'in' }, { endpointNumber: 2, type: 'bulk', direction: 'out' },
        ] }] },
      ] };
    },
    async claimInterface(n) { calls.push(['claim', n]); }, async selectAlternateInterface(n, alt) { calls.push(['alternate', n, alt]); },
    async controlTransferOut(setup, data) { calls.push(['control', setup, data?.slice()]); return { status: 'ok', bytesWritten: data?.length ?? 0 }; },
    async transferIn(n, length) { calls.push(['in', n, length]); return { status: 'ok', data: new DataView(Uint8Array.of(9, 8).buffer) }; },
    async transferOut(n, data) { calls.push(['out', n, data.slice()]); return { status: 'ok', bytesWritten: data.length }; },
    async close() { calls.push(['close']); },
  };
  const transport = await WebUsbTransport.request({ usb: { async requestDevice({ filters }) { assert.deepEqual(filters, [{ vendorId: 0x36b7, productId: 1 }]); return device; } } });
  const coding = calls.find(row => row[0] === 'control' && row[1].request === 0x20);
  assert.deepEqual(coding[2], Uint8Array.of(0, 150, 0, 0, 0, 0, 8)); assert.equal(coding[1].index, 0);
  assert.deepEqual(await transport.read(), Uint8Array.of(9, 8)); await transport.write(Uint8Array.of(5, 6));
  assert.deepEqual(calls.find(row => row[0] === 'in'), ['in', 1, 64]); assert.equal(calls.find(row => row[0] === 'out')[1], 2);
  device.transferOut = async () => ({ status: 'ok', bytesWritten: 1 });
  await assert.rejects(transport.write(Uint8Array.of(1, 2)), { code: 'USB_TRANSFER_FAILED' });
  await transport.close(); assert.equal(calls.at(-1)[0], 'close');
});

test('Web Bluetooth uses only supplied UUIDs, selected GATT write method, ordered chunks, and notification cleanup', async () => {
  const serviceUuid = '00000001-0000-0000-0000-000000000000', writeUuid = '00000002-0000-0000-0000-000000000000', notifyUuid = '00000003-0000-0000-0000-000000000000';
  const writes = [], listeners = new Map(), deviceListeners = new Map();
  const tx = { properties: { write: true }, async writeValueWithResponse(data) { writes.push(data.slice()); }, async writeValueWithoutResponse() { assert.fail('Wrong GATT write method'); } };
  const rx = { properties: { notify: true }, addEventListener(type, cb) { listeners.set(type, cb); }, removeEventListener(type) { listeners.delete(type); }, async startNotifications() {} };
  const device = {
    addEventListener(type, cb) { deviceListeners.set(type, cb); }, removeEventListener(type) { deviceListeners.delete(type); },
    gatt: { connected: false, async connect() { this.connected = true; return { async getPrimaryService(uuid) {
      assert.equal(uuid, serviceUuid); return { async getCharacteristic(uuid) { return uuid === writeUuid ? tx : uuid === notifyUuid ? rx : assert.fail('Unknown characteristic'); } };
    } }; }, disconnect() { this.connected = false; } },
  };
  const transport = await WebBluetoothTransport.request({ bluetooth: { async requestDevice(input) {
    assert.deepEqual(input, { acceptAllDevices: true, optionalServices: [serviceUuid] }); return device;
  } },
    serviceUuid, writeUuid, notifyUuid, writeMode: 'withResponse', wireMode: 'plain', responseChecksum: 'crc16-x25', mtuPayload: 3 });
  await transport.write(Uint8Array.of(0, 1, 2, 3, 4, 5, 6));
  assert.deepEqual(writes, [Uint8Array.of(0, 1, 2), Uint8Array.of(3, 4, 5), Uint8Array.of(6)]);
  listeners.get('characteristicvaluechanged')({ target: { value: new DataView(Uint8Array.of(171, 205).buffer) } });
  assert.deepEqual(await transport.read(), Uint8Array.of(171, 205));
  const pending = transport.read(); await transport.close(); assert.equal(await pending, null);
  assert.equal(listeners.size, 0); assert.equal(deviceListeners.size, 0); assert.equal(device.gatt.connected, false);
});
