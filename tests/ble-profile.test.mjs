// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBleCharacteristics, normalizeBleProfile, parseBleProfile, serializeBleProfile,
  WebBluetoothTransport, DEFAULT_K8_BLE_PROFILE } from '../src/protocol/index.mjs';

const serviceUuid = '10000000-1111-2222-3333-444444444444';
const writeUuid = '20000000-1111-2222-3333-444444444444';
const notifyUuid = '30000000-1111-2222-3333-444444444444';
const profile = { serviceUuid, writeUuid, notifyUuid, writeMode: 'withResponse',
  wireMode: 'xor', responseChecksum: 'placeholder', mtuPayload: 20,
  writeStrategy: 'chunked', interWriteDelayMs: 0, lengthConvention: 'cps-0.56' };

function fakeDevice({ write = true, writeWithoutResponse = false, notify = true, indicate = false,
  sameCharacteristic = false, discoveryError, notifyError } = {}) {
  const calls = [], events = new Map(), rxEvents = new Map();
  const tx = { uuid: writeUuid, properties: { write, writeWithoutResponse },
    async writeValueWithResponse(data) { calls.push(['write-request', [...data]]); },
    async writeValueWithoutResponse(data) { calls.push(['write-command', [...data]]); } };
  const rx = sameCharacteristic ? tx : { uuid: notifyUuid, properties: {} };
  Object.assign(rx.properties, { notify, indicate });
  Object.assign(rx, { addEventListener(type, cb) { rxEvents.set(type, cb); },
    removeEventListener(type) { rxEvents.delete(type); },
    async startNotifications() { calls.push(['subscribe']); if (notifyError) throw notifyError; } });
  const service = { async getCharacteristics() {
    calls.push(['enumerate']); if (discoveryError) throw discoveryError;
    return sameCharacteristic ? [tx] : [tx, rx];
  }, async getCharacteristic(uuid) {
    calls.push(['characteristic', uuid]);
    if (uuid === writeUuid) return tx;
    if (uuid === notifyUuid && !sameCharacteristic) return rx;
    throw new Error('Unknown test characteristic');
  } };
  const device = { id: 'local-opaque-device-id', name: 'test-only synthetic peripheral',
    addEventListener(type, cb) { events.set(type, cb); }, removeEventListener(type) { events.delete(type); },
    gatt: { connected: false, async connect() { calls.push(['connect']); this.connected = true; return {
      async getPrimaryService(uuid) { calls.push(['service', uuid]); assert.equal(uuid, serviceUuid); return service; },
    }; }, disconnect() { calls.push(['disconnect']); this.connected = false; } } };
  const bluetooth = { async requestDevice(options) { calls.push(['chooser', options]); return device; } };
  return { device, bluetooth, calls, events, rxEvents, tx, rx };
}

test('BLE profile file round-trips only validated connection settings and excludes device/password/UI state', () => {
  const text = serializeBleProfile({ ...profile, device: { id: 'never-export-this' }, password: 'never-export-this',
    selectedModel: 'UI value', unrelated: true });
  const document = JSON.parse(text);
  assert.equal(document.model, 'UV-K10-PRO-K8'); assert.equal(document.version, 1);
  assert.deepEqual(parseBleProfile(text), profile); assert.deepEqual(Object.keys(document.profile).sort(), Object.keys(profile).sort());
  assert.doesNotMatch(text, /never-export|password|selectedModel|unrelated/);
  assert.deepEqual(parseBleProfile('\uFEFF' + text), profile);
  assert.equal(normalizeBleProfile({ ...profile, serviceUuid: ` ${serviceUuid.toUpperCase()} ` }).serviceUuid, serviceUuid);
  const legacy = { ...document.profile };
  for (const key of ['writeStrategy', 'interWriteDelayMs', 'lengthConvention']) delete legacy[key];
  assert.deepEqual(parseBleProfile(JSON.stringify({ ...document, profile: legacy })), profile);
});

test('BLE profile rejects foreign models, versions, missing framing, implicit UUIDs and invalid packet sizes', () => {
  const document = JSON.parse(serializeBleProfile(profile));
  for (const mutation of [{ model: 'K82' }, { model: 'UV5' }, { version: 2 }, { format: 'other' }])
    assert.throws(() => parseBleProfile(JSON.stringify({ ...document, ...mutation })), { code: 'INVALID_BLE_PROFILE_FILE' });
  for (const mutation of [{ serviceUuid: 'ffe0' }, { writeUuid: '' }, { notifyUuid: 'undefined' }, { wireMode: 'auto' },
    { responseChecksum: '' }, { writeMode: 'guess' }, { mtuPayload: 245 }, { mtuPayload: 0 }, { mtuPayload: 1.5 },
    { mtuPayload: '20' }, { writeStrategy: 'auto' }, { writeStrategy: 'whole-frame', writeMode: 'withoutResponse' },
    { interWriteDelayMs: -1 }, { interWriteDelayMs: 1001 }, { interWriteDelayMs: 0.5 }, { interWriteDelayMs: '120' },
    { lengthConvention: 'guess' }])
    assert.throws(() => parseBleProfile(JSON.stringify({ ...document, profile: { ...profile, ...mutation } })), { code: 'BLE_PROFILE_REQUIRED' });
  assert.throws(() => parseBleProfile('not JSON'), { code: 'INVALID_BLE_PROFILE_FILE' });
  assert.throws(() => parseBleProfile(' '.repeat(16385)), { code: 'INVALID_BLE_PROFILE_FILE' });
  assert.throws(() => parseBleProfile('中'.repeat(6000)), { code: 'INVALID_BLE_PROFILE_FILE' });
});

test('BLE discovery examines one granted service and exports actual properties without reading, subscribing or sending commands', async () => {
  const mock = fakeDevice({ write: false, writeWithoutResponse: true, notify: false, indicate: true });
  const result = await discoverBleCharacteristics({ serviceUuid, bluetooth: mock.bluetooth });
  assert.equal(result.device, mock.device); assert.equal(result.serviceUuid, serviceUuid);
  assert.deepEqual(mock.calls, [
    ['chooser', { acceptAllDevices: true, optionalServices: [serviceUuid] }],
    ['connect'], ['service', serviceUuid], ['enumerate'], ['disconnect'],
  ]);
  assert.equal(result.characteristics[0].uuid, writeUuid);
  assert.equal(result.characteristics[0].properties.write, false);
  assert.equal(result.characteristics[0].properties.writeWithoutResponse, true);
  assert.equal(result.characteristics[1].properties.notify, false);
  assert.equal(result.characteristics[1].properties.indicate, true);
  assert.equal(mock.device.gatt.connected, false);
  const transport = await WebBluetoothTransport.request({ device: result.device, ...profile, writeMode: 'withoutResponse' });
  assert.equal(mock.calls.filter(row => row[0] === 'chooser').length, 1);
  await transport.write(Uint8Array.of(0xab, 0xcd));
  assert.deepEqual(mock.calls.find(row => row[0] === 'write-command'), ['write-command', [0xab, 0xcd]]);
  await transport.close();
});

test('BLE discovery closes GATT on enumeration error and rejects invalid service before chooser', async () => {
  const expected = new Error('synthetic discovery failure'), mock = fakeDevice({ discoveryError: expected });
  await assert.rejects(discoverBleCharacteristics({ serviceUuid, bluetooth: mock.bluetooth }), error => error === expected);
  assert.equal(mock.device.gatt.connected, false); assert.deepEqual(mock.calls.at(-1), ['disconnect']);
  const before = mock.calls.length;
  await assert.rejects(discoverBleCharacteristics({ serviceUuid: 'unknown', bluetooth: mock.bluetooth }), { code: 'BLE_PROFILE_REQUIRED' });
  assert.equal(mock.calls.length, before);
});

test('normal BLE chooser does not require the known GATT service in advertising and grants only that service', async () => {
  const mock = fakeDevice();
  const transport = await WebBluetoothTransport.request({ bluetooth: mock.bluetooth, ...profile });
  assert.deepEqual(mock.calls[0], ['chooser', { acceptAllDevices: true, optionalServices: [serviceUuid] }]);
  assert.deepEqual(mock.calls.filter(call => call[0] === 'service'), [['service', serviceUuid]]);
  assert.deepEqual(mock.calls.filter(call => call[0] === 'characteristic'),
    [['characteristic', writeUuid], ['characteristic', notifyUuid]]);
  assert.equal(mock.calls.some(call => ['enumerate', 'write-command', 'write-request'].includes(call[0])), false);
  await transport.close();
  const untouched = fakeDevice();
  await assert.rejects(WebBluetoothTransport.request({ bluetooth: untouched.bluetooth, ...profile, serviceUuid: 'ff12' }),
    { code: 'BLE_PROFILE_REQUIRED' });
  assert.deepEqual(untouched.calls, []);
});

test('BLE discovery does not disconnect an active programming session', async () => {
  const mock = fakeDevice(); mock.device.gatt.connected = true;
  await assert.rejects(discoverBleCharacteristics({ serviceUuid, device: mock.device }), { code: 'BLE_DISCOVERY_BUSY' });
  assert.equal(mock.device.gatt.connected, true); assert.deepEqual(mock.calls, []);
});

test('BLE connection checks TX mode and RX notification properties before subscribing or sending any payload', async () => {
  for (const options of [{ write: false, writeWithoutResponse: true }, { notify: false, indicate: false }]) {
    const mock = fakeDevice(options);
    await assert.rejects(WebBluetoothTransport.request({ device: mock.device, ...profile }), { code: 'BLE_CHARACTERISTIC_MISMATCH' });
    assert.equal(mock.calls.some(row => ['subscribe', 'write-command', 'write-request'].includes(row[0])), false);
    assert.equal(mock.device.gatt.connected, false); assert.equal(mock.events.size, 0); assert.equal(mock.rxEvents.size, 0);
  }
});

test('BLE supports an explicitly selected shared TX/RX characteristic and tears down failed subscriptions', async () => {
  const mock = fakeDevice({ sameCharacteristic: true, notify: false, indicate: true });
  const transport = await WebBluetoothTransport.request({ device: mock.device, ...profile, notifyUuid: writeUuid });
  assert.equal(mock.calls.filter(row => row[0] === 'characteristic').length, 1);
  mock.rxEvents.get('characteristicvaluechanged')({ target: { value: new DataView(Uint8Array.of(1, 2, 3).buffer) } });
  assert.deepEqual(await transport.read(), Uint8Array.of(1, 2, 3)); await transport.close();
  const failure = new Error('synthetic subscription failure'), failed = fakeDevice({ notifyError: failure });
  await assert.rejects(WebBluetoothTransport.request({ device: failed.device, ...profile }), error => error === failure);
  assert.equal(failed.device.gatt.connected, false); assert.equal(failed.events.size, 0); assert.equal(failed.rxEvents.size, 0);
});

test('BLE disconnect during notification setup cannot return a falsely open transport', async () => {
  const mock = fakeDevice();
  mock.rx.startNotifications = async () => {
    mock.device.gatt.connected = false;
    mock.events.get('gattserverdisconnected')();
  };
  await assert.rejects(WebBluetoothTransport.request({ device: mock.device, ...profile }), { code: 'DISCONNECTED' });
  assert.equal(mock.events.size, 0); assert.equal(mock.rxEvents.size, 0);
});

test('official K8 preset preserves the recovered model-specific GATT, framing, length and pacing choices', () => {
  assert.deepEqual(DEFAULT_K8_BLE_PROFILE, {
    serviceUuid: '0000ff12-0000-1000-8000-00805f9b34fb',
    writeUuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    notifyUuid: '0000fff3-0000-1000-8000-00805f9b34fb',
    writeMode: 'withResponse', wireMode: 'plain', responseChecksum: 'crc16-x25-or-placeholder',
    mtuPayload: 20, writeStrategy: 'whole-frame', interWriteDelayMs: 120, lengthConvention: 'android-k8',
  });
  assert.equal(Object.isFrozen(DEFAULT_K8_BLE_PROFILE), true);
  assert.deepEqual(parseBleProfile(serializeBleProfile(DEFAULT_K8_BLE_PROFILE)), DEFAULT_K8_BLE_PROFILE);
});

test('whole-frame BLE writes preserve value boundaries, serialize early replies and apply the K8 frame gap', async () => {
  const mock = fakeDevice(), sent = [], started = [];
  const transport = await WebBluetoothTransport.request({ device: mock.device, ...DEFAULT_K8_BLE_PROFILE,
    serviceUuid, writeUuid, notifyUuid });
  mock.tx.writeValueWithResponse = async data => { started.push(performance.now()); sent.push(data.slice()); };
  assert.equal(transport.protocolProfile.lengthConvention, 'android-k8');
  assert.equal(transport.protocolProfile.responseChecksum, 'crc16-x25-or-placeholder');
  const first = new Uint8Array(152).fill(0xa5), second = Uint8Array.of(1, 2, 3);
  const operations = [transport.write(first), transport.write(second)];
  first.fill(0); // Caller mutation after enqueue must not change the queued write.
  await Promise.all(operations);
  assert.equal(sent.length, 2); assert.deepEqual(sent.map(data => data.length), [152, 3]);
  assert.equal(sent[0].every(n => n === 0xa5), true); assert.deepEqual(sent[1], second);
  assert.ok(started[1] - started[0] >= 110, 'second frame must wait for the 120 ms post-frame timer');
  await assert.rejects(transport.write(new Uint8Array(513)), { code: 'FRAME_TOO_LONG' });
  assert.equal(sent.length, 2); await transport.close();
});

test('a failed whole-frame write closes the stream and is never retried as smaller chunks', async () => {
  const mock = fakeDevice(), failure = new Error('synthetic long write failure');
  const transport = await WebBluetoothTransport.request({ device: mock.device, ...profile,
    writeStrategy: 'whole-frame' });
  let attempted = 0;
  mock.tx.writeValueWithResponse = async data => { attempted++; assert.equal(data.length, 152); throw failure; };
  const results = await Promise.allSettled([transport.write(new Uint8Array(152)), transport.write(Uint8Array.of(7))]);
  assert.equal(results[0].reason, failure); assert.equal(results[1].reason.code, 'DISCONNECTED');
  assert.equal(attempted, 1); assert.equal(mock.device.gatt.connected, false); assert.equal(transport.opened, false);
});

test('writes queued under a closed GATT connection cannot leak into a reopened connection', async () => {
  const mock = fakeDevice(), transport = await WebBluetoothTransport.request({ device: mock.device, ...profile,
    writeStrategy: 'whole-frame' });
  const sent = []; let release;
  mock.tx.writeValueWithResponse = async data => {
    sent.push([...data]); if (sent.length === 1) await new Promise(resolve => { release = resolve; });
  };
  const first = transport.write(Uint8Array.of(1));
  const stale = transport.write(Uint8Array.of(2));
  const results = Promise.allSettled([first, stale]);
  await new Promise(resolve => setImmediate(resolve));
  await transport.close(); await transport.open(); release();
  const values = await results; assert.equal(values[1].reason.code, 'DISCONNECTED');
  await transport.write(Uint8Array.of(3));
  assert.deepEqual(sent, [[1], [3]]); await transport.close();
});
