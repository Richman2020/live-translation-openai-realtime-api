import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlledBrowserTrace } from '../scripts/controlled-browser-trace';

test('controlled trace records local sequence and monotonic timestamps', () => {
  const trace = new ControlledBrowserTrace();
  trace.add('request-start', { page: 1, request: 2, scope: 'fixture' });
  trace.add('request-complete', { request: 2, statusCode: 200 });
  const { events, dropped } = trace.snapshot();
  assert.equal(dropped, 0);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.equal(events[0].page, 1);
  assert.equal(events[0].request, 2);
  assert.equal(events[0].scope, 'fixture');
  assert.equal(events[1].statusCode, 200);
  assert.ok(Number.isFinite(events[0].timeMs));
  assert.ok(Number(events[1].timeMs) >= Number(events[0].timeMs));
});

test('controlled trace admits bounded identifiers, counts and timestamps including zero', () => {
  const trace = new ControlledBrowserTrace();
  trace.add('boundary', {
    page: 0, request: 1, stream: 2, call: 3, sequence: 4, count: 5,
    voiceReservations: 6, providerHangups: 7, revocations: 8,
    bootstrapStarted: 9, bootstrapCompleted: 10, bootstrapPending: 11,
    sseOpened: 12, sseReceived: 13, sseCurrent: 14, epoch: 15,
    statusCode: 599, readCompletedMs: 0, atMs: 0.5, documentTimeOrigin: 1000.25,
  });
  const record = trace.snapshot().events[0];
  assert.equal(Object.keys(record).length, 23);
  assert.equal(record.page, 0);
  assert.equal(record.statusCode, 599);
  assert.equal(record.atMs, 0.5);
});

test('controlled trace rejects invalid numeric inputs without coercion', () => {
  const trace = new ControlledBrowserTrace();
  trace.add('failure', {
    page: '1', request: -1, stream: 1.5, call: Number.MAX_SAFE_INTEGER + 1,
    count: NaN, epoch: Infinity, statusCode: 600,
    atMs: -1, readCompletedMs: Infinity, documentTimeOrigin: '123',
  });
  assert.deepEqual(Object.keys(trace.snapshot().events[0]), ['seq', 'timeMs', 'event']);
});

test('controlled trace admits only known enum values and strict booleans', () => {
  const trace = new ControlledBrowserTrace();
  trace.add('ready', {
    phase: 'readonly', callStatus: 'completed', controllerMode: 'available',
    route: 'browser-session', eventKind: 'snapshot', scenario: 'refresh-ready', scope: 'page',
    managerBlocked: false, serverActive: false, busy: false, sdkClosed: true,
    muteEnabled: false, startEnabled: true, endEnabled: false, hidden: false,
    connected: true, cleanupPending: false, readPending: false,
  });
  const record = trace.snapshot().events[0];
  assert.equal(record.phase, 'readonly');
  assert.equal(record.sdkClosed, true);
  assert.equal(record.managerBlocked, false);
  assert.equal(record.readPending, false);
  assert.equal(Object.keys(record).length, 21);
});

test('controlled trace drops secret text, unknown fields and enum injections', () => {
  const trace = new ControlledBrowserTrace();
  const secret = 'secret-credential-and-call-content';
  trace.add('failure', {
    url: `https://example.invalid/?token=${secret}`, headers: { authorization: secret },
    body: secret, error: new Error(secret), token: secret, voiceText: secret,
    phase: secret, callStatus: secret, controllerMode: secret, route: secret,
    eventKind: secret, scenario: secret, scope: secret,
    busy: 'true', connected: 1, seq: secret, timeMs: secret, event: secret,
  });
  const output = JSON.stringify(trace.snapshot());
  assert.ok(!output.includes(secret));
  assert.deepEqual(Object.keys(trace.snapshot().events[0]), ['seq', 'timeMs', 'event']);
});

test('controlled trace does not execute getters or retain inherited properties', () => {
  const trace = new ControlledBrowserTrace();
  const fields = Object.create({ page: 999, phase: 'active' });
  let getterReads = 0;
  Object.defineProperty(fields, 'request', { get() { getterReads += 1; throw new Error('secret'); } });
  Object.defineProperty(fields, 'serverActive', { value: true });
  trace.add('server-call', fields);
  const record = trace.snapshot().events[0];
  assert.equal(getterReads, 0);
  assert.equal(record.serverActive, true);
  assert.ok(!Object.hasOwn(record, 'request'));
  assert.ok(!Object.hasOwn(record, 'page'));
  assert.ok(!Object.hasOwn(record, 'phase'));
});

test('controlled trace snapshots and input records are detached', () => {
  const trace = new ControlledBrowserTrace();
  const fields = { page: 1, phase: 'active', headers: { authorization: 'private' } };
  trace.add('boundary', fields);
  fields.page = 2;
  fields.phase = 'ending';
  const first = trace.snapshot();
  first.events[0].page = 3;
  first.events.push({ event: 'injected' });
  first.dropped = 100;
  assert.equal(trace.snapshot().events[0].page, 1);
  assert.equal(trace.snapshot().events[0].phase, 'active');
  assert.equal(trace.snapshot().events.length, 1);
  assert.equal(trace.snapshot().dropped, 0);
});

test('controlled trace retains most recent events in order and counts discarded records', () => {
  const trace = new ControlledBrowserTrace(2);
  for (let index = 0; index < 5; index += 1) trace.add('sse-event', { sequence: index });
  const snapshot = trace.snapshot();
  assert.equal(snapshot.dropped, 3);
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [3, 4]);
  assert.deepEqual(snapshot.events.map((event) => event.seq), [4, 5]);
});

test('controlled trace defaults to a bounded 512-record history', () => {
  const trace = new ControlledBrowserTrace();
  for (let index = 0; index < 513; index += 1) trace.add('request-complete', { request: index });
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 512);
  assert.equal(snapshot.dropped, 1);
  assert.equal(snapshot.events[0].request, 1);
});

test('controlled trace rejects unsupported events and capacities without echoing inputs', () => {
  const secret = 'private-token-never-in-errors';
  const trace = new ControlledBrowserTrace();
  assert.throws(() => trace.add(secret), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Invalid trace event');
    assert.ok(!String(error).includes(secret));
    return true;
  });
  for (const limit of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => new ControlledBrowserTrace(limit), /^RangeError: Invalid trace capacity$/);
  assert.equal(trace.snapshot().events.length, 0);
});
