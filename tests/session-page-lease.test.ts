import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionPageLease } from '../public/session-page-lease.js';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Events {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    const group = this.listeners.get(type) || new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, isTrusted = true, extra = {}) {
    for (const listener of this.listeners.get(type) || [])
      listener({ type, isTrusted, ...extra });
  }
  get count() {
    return [...this.listeners.values()].reduce(
      (count, group) => count + group.size,
      0,
    );
  }
}
class Clock {
  now = 1000000;
  serial = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, delay: number) => {
    const id = ++this.serial;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  };
  clear = (id: number) => {
    this.tasks.delete(id);
  };
  async advance(milliseconds: number) {
    const until = this.now + milliseconds;
    for (;;) {
      const entry = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.now = Math.max(this.now, entry[1].at);
      this.tasks.delete(entry[0]);
      entry[1].callback();
      await flush();
    }
    this.now = until;
    await flush();
  }
}
let serial = 0;
function fixture(
  options: { pending?: Promise<void>; fail?: boolean; clock?: Clock } = {},
) {
  const clock = options.clock ?? new Clock();
  const events = new Events();
  const requests: any[] = [];
  const closes: any[] = [];
  let expirations = 0;
  const lease = createSessionPageLease({
    eventSource: events,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    createPageId: () => String(++serial).padStart(43, 'a'),
    onExpire: () => {
      expirations++;
    },
    close: (fields: any) => {
      closes.push(fields);
    },
    renew: async (fields: any) => {
      requests.push(fields);
      if (options.pending) await options.pending;
      if (options.fail) throw new Error('offline');
      if (!fields.signal.aborted)
        lease.updateSession({
          authenticated: true,
          expiresAt: clock.now + 30 * 60000,
        });
    },
  });
  const authenticate = (expiresAt = clock.now + 30 * 60000) =>
    lease.updateSession({ authenticated: true, expiresAt });
  return {
    lease,
    clock,
    events,
    requests,
    closes,
    authenticate,
    expired: () => expirations,
  };
}

test('idle and background pages keep a 60 second heartbeat beyond eight hours', async () => {
  const f = fixture();
  f.authenticate();
  await f.clock.advance(0);
  f.events.emit('blur');
  f.events.emit('visibilitychange', true, { hidden: true });
  await f.clock.advance(9 * 60 * 60000);
  assert.equal(f.requests.length, 541);
  assert.equal(f.lease.snapshot.expiresAt, f.clock.now + 30 * 60000);
  assert.equal(f.expired(), 0);
  f.lease.dispose();
});

test('physical pages have different IDs, independent sequences, and independent close', async () => {
  const first = fixture();
  const second = fixture();
  first.authenticate();
  second.authenticate();
  await first.clock.advance(0);
  await second.clock.advance(0);
  assert.notEqual(first.requests[0].pageId, second.requests[0].pageId);
  first.events.emit('pagehide');
  assert.equal(first.closes[0].sequence, 2);
  assert.equal(first.closes[0].pageId, first.requests[0].pageId);
  await second.clock.advance(60000);
  assert.equal(second.requests.length, 2);
  assert.equal(second.requests[1].sequence, 2);
  assert.equal(second.closes.length, 0);
  second.lease.dispose();
});

test('pagehide aborts an unresolved open before a higher-sequence close, with no resurrection', async () => {
  const gate = deferred();
  const f = fixture({ pending: gate.promise });
  f.authenticate();
  await f.clock.advance(0);
  f.events.emit('pagehide');
  assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual(f.closes[0], {
    pageId: f.requests[0].pageId,
    sequence: 2,
    state: 'close',
  });
  f.authenticate();
  f.events.emit('pageshow');
  f.events.emit('online');
  gate.resolve();
  await flush();
  await f.clock.advance(120000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.lease.snapshot.authenticated, false);
  assert.equal(f.events.count, 0);
});

test('logout cancels heartbeat and fences an ignored-abort late result', async () => {
  const gate = deferred();
  const f = fixture({ pending: gate.promise });
  f.authenticate();
  await f.clock.advance(0);
  f.lease.updateSession({ authenticated: false, expiresAt: 0 });
  gate.resolve();
  await flush();
  await f.clock.advance(60000);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.lease.snapshot.authenticated, false);
  assert.equal(f.requests.length, 1);
  f.lease.dispose();
  assert.equal(f.closes.length, 0);
});

test('short transport failures keep only the confirmed TTL and retry every minute', async () => {
  const f = fixture({ fail: true });
  f.authenticate();
  const expiry = f.lease.snapshot.expiresAt;
  await f.clock.advance(3 * 60000);
  assert.equal(f.requests.length, 4);
  assert.equal(f.lease.snapshot.authenticated, true);
  assert.equal(f.lease.snapshot.expiresAt, expiry);
  await f.clock.advance(27 * 60000);
  assert.equal(f.lease.snapshot.authenticated, false);
  assert.equal(f.expired(), 1);
  assert.equal(f.requests.length, 30);
  f.lease.dispose();
});

test('online and pageshow request prompt serialized refresh-and-renew without waiting a minute', async () => {
  const f = fixture();
  f.authenticate();
  await f.clock.advance(0);
  await f.clock.advance(1000);
  f.events.emit('online');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].resume, true);
  await f.clock.advance(1000);
  f.events.emit('pageshow');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].resume, true);
  f.lease.dispose();
});

test('a frozen page waking past its confirmed lease expires without sending', async () => {
  const f = fixture();
  f.authenticate();
  await f.clock.advance(0);
  f.clock.now += 31 * 60000;
  f.events.emit('online');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.expired(), 1);
  assert.equal(f.lease.snapshot.authenticated, false);
  f.lease.dispose();
});

test('a hung network operation cannot delay finite expiry', async () => {
  const gate = deferred();
  const f = fixture({ pending: gate.promise });
  f.authenticate();
  await f.clock.advance(30 * 60000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.expired(), 1);
  gate.resolve();
  await flush();
  assert.equal(f.lease.snapshot.authenticated, false);
  f.lease.dispose();
});

test('unauthenticated reads and lifecycle events never create a lease', async () => {
  const f = fixture();
  f.events.emit('online');
  f.events.emit('pageshow');
  await f.clock.advance(60000);
  assert.equal(f.requests.length, 0);
  f.lease.dispose();
  assert.equal(f.closes.length, 0);
});

test('offline abort preserves TTL, and recovery waits for the retired transport before renewing', async () => {
  const gate = deferred();
  const f = fixture({ pending: gate.promise });
  f.authenticate();
  await f.clock.advance(0);
  const expiry = f.lease.snapshot.expiresAt;
  f.events.emit('offline');
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.lease.snapshot.authenticated, true);
  assert.equal(f.lease.snapshot.expiresAt, expiry);
  f.events.emit('online');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
  gate.resolve();
  await flush();
  await f.clock.advance(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].resume, true);
  assert.equal(f.requests[1].sequence, 2);
  f.lease.dispose();
});

test('manual refresh pauses pulses without losing the page identity or its finite expiry', async () => {
  const f = fixture();
  f.authenticate();
  await f.clock.advance(0);
  f.lease.updateSession({
    authenticated: true,
    expiresAt: f.lease.snapshot.expiresAt,
    paused: true,
  });
  await f.clock.advance(60000);
  assert.equal(f.requests.length, 1);
  f.authenticate();
  await f.clock.advance(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].pageId, f.requests[1].pageId);
  f.lease.dispose();
});

test('a freshly server-confirmed session after local expiry gets a new lease ID', async () => {
  const f = fixture({ fail: true });
  f.authenticate();
  await f.clock.advance(30 * 60000);
  const oldId = f.requests[0].pageId;
  assert.equal(f.lease.snapshot.authenticated, false);
  // Another live tab may preserve the login. The caller must first confirm it
  // with the server; merely receiving online/pageshow does not reach this path.
  f.authenticate();
  await f.clock.advance(0);
  assert.notEqual(f.requests.at(-1).pageId, oldId);
  assert.equal(f.requests.at(-1).sequence, 1);
  f.lease.dispose();
});

test('server-retired identity rotates only after authenticated retirement confirmation and retries once', async () => {
  const clock = new Clock();
  const events = new Events();
  const requests: any[] = [];
  let ids = 0;
  const lease = createSessionPageLease({
    eventSource: events,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    createPageId: () => String(++ids).padStart(43, 'r'),
    close: () => {},
    renew: async (fields: any) => {
      requests.push(fields);
      return { retired: true };
    },
  });
  lease.updateSession({
    authenticated: true,
    expiresAt: clock.now + 30 * 60000,
  });
  await clock.advance(0);
  assert.equal(
    requests.length,
    2,
    'a repeated 409 cannot make a tight retry loop',
  );
  assert.notEqual(requests[0].pageId, requests[1].pageId);
  assert.equal(requests[1].sequence, 1);
  assert.equal(requests[1].resume, true);
  lease.dispose();
});
