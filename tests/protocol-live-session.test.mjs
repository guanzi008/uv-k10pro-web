// SPDX-License-Identifier: MIT
// Host/session integration using a synthetic peer. CPU/firmware evidence lives
// in tests/reference/replay-live.py; this model does not validate hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ProgrammingSession } from '../src/protocol/session.mjs';
import { MockTransport } from '../src/protocol/mock-transport.mjs';
import { COMMAND, decodeFrame, encodeFrame, encodeMessage } from '../src/protocol/frame.mjs';
import { LIVE_COMMAND, APRS_SEND_TIMEOUT_MS } from '../src/protocol/live-codec.mjs';
import { buildAprsMessage } from '../src/core/aprs-frame.mjs';

const options = { selectedModel: 'UV-K10 Pro', sessionToken: 0x12345678 };
const location = { utcSeconds: 1735689600, latitude: -34.946333333333335,
  longitude: -123.76116666666667, altitudeMeters: -16.5 };
const packet = buildAprsMessage({ destination: 'APRS', source: 'N0CALL', addressee: 'N0TEST', text: 'Synthetic test' });
const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);
const count = (transport, command) => transport.requests.filter(r => r.command === command).length;

class LiveTransport extends MockTransport {
  constructor(config = {}) {
    super(config); this.aprsResult = 0; this.liveRequests = [];
    this.dropAprs = false; this.beforeRead = null; this.beforeAprsReply = null;
  }
  emitBody(body) {
    this.queue.push(encodeFrame(body, { ...this.protocolProfile, direction: 'response' }));
  }
  emitPacket(value = packet.slice(0, -2)) {
    const payload = new Uint8Array(132); view(payload).setUint16(0, value.length, true); payload.set(value, 4);
    this.emitBody(encodeMessage(LIVE_COMMAND.APRS_RECEIVE, payload));
  }
  async write(value) {
    const message = decodeFrame(value, { ...this.protocolProfile, direction: 'request' });
    if (message.command === COMMAND.HELLO && count(this, COMMAND.HELLO)) {
      this.liveRequests.push(message);
      // A real HELLO changes the challenge; force the test peer to reject an
      // AUTH computed from the old value rather than merely checking a flag.
      this.challenge = this.challenge.map(n => n ^ 0xa5);
      this.authenticated = this.passwordValid === 0;
    }
    if (message.command === COMMAND.READ) await this.beforeRead?.(message, this);
    if (message.command !== LIVE_COMMAND.APRS_SEND) return super.write(value);
    this.liveRequests.push(message); this.requests.push({ command: message.command });
    await this.beforeAprsReply?.(message, this);
    if (!this.dropAprs) this.emitBody(encodeMessage(LIVE_COMMAND.APRS_SEND_REPLY,
      Uint8Array.of(this.aprsResult, 0xa5, 0xff, 0x5a)));
  }
}

async function connected(t, config = {}, sessionOptions = {}) {
  const transport = new LiveTransport(config), session = new ProgrammingSession(transport, { ...options, ...sessionOptions });
  t.after(() => session.close()); await session.connect({ utcSeconds: 1 }); return { session, transport };
}

test('location HELLO rotates a protected challenge, invalidates authentication and increments baseline generation', async t => {
  const { session, transport } = await connected(t, { passwordValid: 1, password: 'synthetic-current' });
  const initialChallenge = session.challenge.slice(), initialIdentity = session.identity;
  await assert.rejects(session.synchronizeLocation(location), { code: 'AUTH_REQUIRED' });
  assert.equal(count(transport, COMMAND.HELLO), 1);
  await session.authenticate({ password: 'synthetic-current' });
  const result = await session.synchronizeLocation(location);
  assert.equal(result.synchronized, true); assert.equal(result.baselineInvalidated, true);
  assert.equal(result.rfTransmissionRequested, false); assert.equal(result.authenticationRequired, true);
  assert.equal(session.identity.baselineGeneration, initialIdentity.baselineGeneration + 1);
  assert.equal(session.baselineGeneration, 2); assert.equal(initialIdentity.baselineGeneration, 1);
  assert.equal(session.identity.rtcSynchronizedTo, location.utcSeconds);
  assert.notDeepEqual(session.challenge, initialChallenge); assert.deepEqual(session.challenge, transport.challenge);
  assert.equal(session.authenticated, false); assert.equal(session.writeEnabled, false);
  await assert.rejects(session.readMemory(0, 1), { code: 'AUTH_REQUIRED' });
  await assert.rejects(session.sendAprs(packet), { code: 'AUTH_REQUIRED' });
  assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 0);
  await session.authenticate({ password: 'synthetic-current' });
  assert.equal(transport.authenticated, true); assert.equal(session.writeEnabled, true);
  assert.equal(count(transport, COMMAND.AUTH), 2);
  assert.deepEqual(await session.readMemory(0, 1), Uint8Array.of(255));
  const sent = transport.liveRequests[0];
  assert.equal(sent.declaredLength, 24); assert.equal(sent.payload[8], 1);
  assert.equal(view(sent.payload).getUint32(0, true), options.sessionToken);
  assert.equal(view(sent.payload).getUint32(4, true), location.utcSeconds);
});

test('password-free location synchronization needs no AUTH and preserves ordinary read/write availability', async t => {
  const { session, transport } = await connected(t);
  const result = await session.synchronizeLocation(location);
  assert.equal(result.authenticationRequired, false); assert.equal(session.writeEnabled, true);
  assert.equal(session.authenticated, false); assert.equal(session.identity.baselineGeneration, 2);
  assert.equal(count(transport, COMMAND.AUTH), 0);
  assert.deepEqual(await session.readMemory(0, 2), Uint8Array.of(255, 255));
  assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 0);
});

test('location can queue behind initial connection before a random session token exists', async t => {
  const transport=new LiveTransport(),session=new ProgrammingSession(transport,{selectedModel:'UV-K10 Pro'});
  t.after(()=>session.close());
  const connecting=session.connect({utcSeconds:1});
  const synchronizing=session.synchronizeLocation(location);
  const [,result]=await Promise.all([connecting,synchronizing]);
  assert.equal(result.synchronized,true); assert.equal(count(transport,COMMAND.HELLO),2);
  assert.equal(view(transport.liveRequests[0].payload).getUint32(0,true),session.sessionToken);
  assert.equal(session.baselineGeneration,2);
});

test('passive APRS events interleaved with READ do not complete or invalidate its transaction', async t => {
  const { session, transport } = await connected(t);
  transport.memory.set(Uint8Array.of(9, 8, 7, 6), 0x100);
  const events = []; const unsubscribe = session.onEvent(event => events.push(event));
  transport.beforeRead = (_message, peer) => peer.emitPacket();
  assert.deepEqual(await session.readMemory(0x100, 4), Uint8Array.of(9, 8, 7, 6));
  assert.equal(events.length, 1); assert.equal(events[0].type, 'aprs-received');
  assert.equal(events[0].decoded.message.text, 'Synthetic test');
  assert.deepEqual(events[0].packet, packet.slice(0, -2)); assert.equal(events[0].fcsIncluded, false);
  assert.equal(session.diagnostics.events, 1); assert.equal(session.diagnostics.replies, 2);
  assert.equal(session.diagnostics.ignoredReplies, 0); assert.equal(session.connected, true);
  unsubscribe(); transport.emitPacket(); await nextTurn();
  assert.equal(events.length, 1); assert.equal(session.diagnostics.events, 2);
});

test('malformed event payloads and throwing listeners do not consume pending READ replies', async t => {
  const { session, transport } = await connected(t); const events = [];
  assert.throws(() => session.onEvent(null), TypeError);
  session.onEvent(() => { throw new Error('synthetic listener failure'); });
  session.onEvent(async () => { throw new Error('synthetic asynchronous listener failure'); });
  session.onEvent(event => events.push(event));
  transport.beforeRead = (_message, peer) => {
    peer.emitBody(encodeMessage(LIVE_COMMAND.APRS_RECEIVE, new Uint8Array(4)));
    const impossible = new Uint8Array(132); view(impossible).setUint16(0, 129, true);
    peer.emitBody(encodeMessage(LIVE_COMMAND.APRS_RECEIVE, impossible));
    peer.emitPacket();
  };
  assert.deepEqual(await session.readMemory(0, 1), Uint8Array.of(255));
  await nextTurn();
  assert.equal(events.length, 1); assert.equal(session.diagnostics.invalidEvents, 2);
  assert.equal(session.diagnostics.listenerErrors, 2); assert.equal(session.diagnostics.invalidFrames, 0);
  assert.equal(session.diagnostics.replies, 2); assert.equal(session.connected, true);
});

test('APRS sends once, copies caller bytes and reports device acceptance without claiming RF delivery', async t => {
  const { session, transport } = await connected(t); const events = [];
  session.onEvent(event => events.push(event));
  transport.beforeAprsReply = (_message, peer) => peer.emitPacket();
  const supplied = packet.slice(), promised = session.sendAprs(supplied); supplied.fill(0);
  const result = await promised;
  assert.equal(result.accepted, true); assert.equal(result.result, 0); assert.equal(result.rfDeliveryConfirmed, false);
  assert.deepEqual(result.payload, Uint8Array.of(0, 0xa5, 0xff, 0x5a));
  assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 1); assert.equal(events.length, 1);
  const request = transport.liveRequests[0];
  assert.equal(request.payload.length, 132); assert.equal(view(request.payload).getUint16(0, true), packet.length);
  assert.deepEqual(request.payload.slice(4, 4 + packet.length), packet); assert.equal(session.connected, true);
});

test('APRS device rejection returns the exact result and never retries', async t => {
  const { session, transport } = await connected(t); transport.aprsResult = 7;
  const result = await session.sendAprs(packet);
  assert.equal(result.accepted, false); assert.equal(result.result, 7); assert.equal(result.rfDeliveryConfirmed, false);
  assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 1); assert.equal(session.connected, true);
});

test('APRS waits exactly ten seconds, then closes with no automatic retransmission', async t => {
  const { session, transport } = await connected(t, {}, { timeoutMs: 25 }); transport.dropAprs = true;
  assert.equal(APRS_SEND_TIMEOUT_MS, 10000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const rejected = assert.rejects(session.sendAprs(packet), { code: 'TIMEOUT' });
    await nextTurn(); assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 1);
    t.mock.timers.tick(9999); await nextTurn();
    assert.equal(session.connected, true); assert.ok(session.pending);
    t.mock.timers.tick(1); await rejected; await nextTurn();
    assert.equal(session.state, 'error'); assert.equal(transport.opened, false);
    t.mock.timers.tick(20000); await nextTurn();
    assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 1);
  } finally { t.mock.timers.reset(); }
});

test('aborting APRS closes the uncertain stream and prevents queued retransmission', async t => {
  const { session, transport } = await connected(t); transport.dropAprs = true;
  const controller = new AbortController();
  const first = assert.rejects(session.sendAprs(packet, { signal: controller.signal }), { code: 'CANCELLED' });
  await nextTurn(); controller.abort(); await first;
  await assert.rejects(session.sendAprs(packet), { code: 'NOT_CONNECTED' });
  assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 1); assert.equal(session.connected, false);
});

test('unknown model, firmware or parameter version cannot send RF packets or synchronize location', async t => {
  for (const [config, sessionOptions] of [[{}, { selectedModel: 'another model' }],
    [{ firmware: 'other' }, {}], [{ paramsVersion: 1 }, {}]]) {
    const { session, transport } = await connected(t, config, sessionOptions);
    await assert.rejects(session.sendAprs(packet), { code: 'UNKNOWN_DEVICE' });
    await assert.rejects(session.synchronizeLocation(location), { code: 'UNKNOWN_DEVICE' });
    assert.equal(count(transport, LIVE_COMMAND.APRS_SEND), 0); assert.equal(count(transport, COMMAND.HELLO), 1);
    assert.equal(transport.liveRequests.length, 0); assert.equal(session.identity.baselineGeneration, 1);
  }
});
