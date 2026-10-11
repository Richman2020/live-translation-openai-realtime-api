import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionActivity } from '../public/session-activity.js';

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
function fixture(
  options: {
    renew?: (signal: AbortSignal) => Promise<void>;
    accept?: (event: any) => boolean;
  } = {},
) {
  const clock = new Clock();
  const source = new Events();
  const lifecycle = new Events();
  let visible = true;
  let focused = true;
  const requests: { at: number; signal: AbortSignal }[] = [];
  const absoluteDeadline = clock.now + 8 * 60 * 60000;
  const activity = createSessionActivity({
    eventSource: source,
    lifecycleSource: lifecycle,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    isForeground: () => visible && focused,
    acceptEvent: options.accept,
    renew: async ({ signal }: { signal: AbortSignal }) => {
      requests.push({ at: clock.now, signal });
      if (options.renew) await options.renew(signal);
      // Like the authenticated transport, a retired result is never applied.
      if (!signal.aborted)
        activity.updateSession({
          authenticated: true,
          expiresAt: Math.min(absoluteDeadline, clock.now + 15 * 60000),
        });
    },
  });
  const session = (
    authenticated = true,
    expiresAt = clock.now + 15 * 60000,
    paused = false,
  ) => activity.updateSession({ authenticated, expiresAt, paused });
  session();
  return {
    clock,
    source,
    lifecycle,
    activity,
    requests,
    session,
    absoluteDeadline,
    show: (value: boolean) => {
      visible = value;
      source.emit('visibilitychange');
    },
    focus: (value: boolean) => {
      focused = value;
      lifecycle.emit(value ? 'focus' : 'blur');
    },
  };
}

test('bootstrap, passive reads and idle timers never create a renewal', async () => {
  const f = fixture();
  for (const type of [
    'visibilitychange',
    'focus',
    'mousemove',
    'devicechange',
    'status',
    'online',
  ])
    f.source.emit(type);
  await f.clock.advance(15 * 60000);
  assert.equal(f.requests.length, 0);
  assert.equal(f.clock.tasks.size, 0);
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  assert.equal(
    f.requests.length,
    0,
    'real activity after expiry cannot revive the session',
  );
});

test('synthetic activity, hidden tabs and unfocused documents cannot keep login alive', async () => {
  const f = fixture();
  for (const type of ['pointerdown', 'keydown', 'input', 'change', 'wheel'])
    f.source.emit(type, false);
  await f.clock.advance(0);
  assert.equal(f.requests.length, 0);
  f.show(false);
  f.source.emit('keydown');
  await f.clock.advance(5000);
  f.show(true);
  await f.clock.advance(5000);
  assert.equal(f.requests.length, 0);
  f.focus(false);
  f.source.emit('pointerdown');
  await f.clock.advance(5000);
  f.focus(true);
  await f.clock.advance(0);
  assert.equal(f.requests.length, 0);
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
});

test('a first real action renews once and gives the existing server idle window', async () => {
  const f = fixture();
  await f.clock.advance(120000);
  f.source.emit('keydown');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.activity.snapshot.expiresAt, f.clock.now + 15 * 60000);
  await f.clock.advance(15 * 60000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
});

test('short bursts coalesce to one leading and one bounded trailing request', async () => {
  const f = fixture();
  const start = f.clock.now;
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  await f.clock.advance(100);
  f.source.emit('input');
  await f.clock.advance(100);
  f.source.emit('keydown');
  await f.clock.advance(29799);
  assert.equal(f.requests.length, 1);
  await f.clock.advance(1);
  assert.deepEqual(
    f.requests.map((request) => request.at - start),
    [0, 30000],
  );
  await f.clock.advance(60000);
  assert.equal(f.requests.length, 2);
});

test('continuous user activity has a maximum wait without a heartbeat after the last action', async () => {
  const f = fixture();
  const start = f.clock.now;
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  for (let elapsed = 1000; elapsed <= 100000; elapsed += 1000) {
    await f.clock.advance(1000);
    f.source.emit('input');
  }
  await f.clock.advance(20000);
  assert.deepEqual(
    f.requests.map((request) => request.at - start),
    [0, 30000, 60000, 90000, 120000],
  );
  assert.equal(f.activity.snapshot.expiresAt, start + 120000 + 15 * 60000);
  await f.clock.advance(15 * 60000);
  assert.equal(f.requests.length, 5);
});

test('pending manual operations discard queued activity rather than renewing after a read', async () => {
  const f = fixture();
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  await f.clock.advance(100);
  f.source.emit('input');
  f.session(true, f.activity.snapshot.expiresAt, true);
  f.source.emit('keydown');
  await f.clock.advance(30000);
  f.session();
  await f.clock.advance(30000);
  assert.equal(f.requests.length, 1);
  f.source.emit('keydown');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
  await f.clock.advance(1000);
  assert.equal(f.requests.length, 2);
});

test('hiding clears a queued trailing action and visibility alone never resumes it', async () => {
  const f = fixture();
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  await f.clock.advance(100);
  f.source.emit('input');
  f.show(false);
  await f.clock.advance(40000);
  f.show(true);
  await f.clock.advance(40000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
});

test('losing window focus cancels queued renewal and focus alone does not resume it', async () => {
  const f = fixture();
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  await f.clock.advance(100);
  f.source.emit('input');
  f.focus(false);
  await f.clock.advance(40000);
  f.focus(true);
  await f.clock.advance(40000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
});

test('hiding aborts in-flight renewal and ignores its late result and queued activity', async () => {
  const gate = deferred();
  const f = fixture({ renew: () => gate.promise });
  const initialExpiry = f.activity.snapshot.expiresAt;
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  f.source.emit('input');
  f.show(false);
  assert.equal(f.requests[0].signal.aborted, true);
  await f.clock.advance(40000);
  gate.resolve();
  await flush();
  assert.equal(f.activity.snapshot.expiresAt, initialExpiry);
  assert.equal(f.activity.snapshot.inFlight, false);
  f.show(true);
  await f.clock.advance(40000);
  assert.equal(f.requests.length, 1);
});

test('logout retires the flight and a late response cannot resurrect authentication', async () => {
  const gate = deferred();
  const f = fixture({ renew: () => gate.promise });
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  f.source.emit('input');
  f.session(false);
  assert.equal(f.requests[0].signal.aborted, true);
  gate.resolve();
  await flush();
  await f.clock.advance(40000);
  assert.equal(f.activity.snapshot.authenticated, false);
  assert.equal(f.activity.snapshot.expiresAt, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
});

test('a fresh session still serializes against an aborted transport ignoring its signal', async () => {
  const gate = deferred();
  let calls = 0;
  const f = fixture({
    renew: () => (++calls === 1 ? gate.promise : Promise.resolve()),
  });
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  f.session(false);
  f.session();
  f.source.emit('keydown');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
  gate.resolve();
  await flush();
  await f.clock.advance(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].signal.aborted, true);
});

test('navigation disposes every listener and aborts the unresolved request', async () => {
  const gate = deferred();
  const f = fixture({ renew: () => gate.promise });
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  f.lifecycle.emit('pagehide');
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.source.count, 0);
  assert.equal(f.lifecycle.count, 0);
  f.session();
  f.source.emit('keydown');
  gate.resolve();
  await flush();
  await f.clock.advance(40000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.activity.snapshot.disposed, true);
});

test('a throttled timer waking after idle expiry or long after activity is not a keepalive', async () => {
  const f = fixture();
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  f.source.emit('input');
  f.clock.now += 16 * 60000;
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
  const fresh = fixture();
  fresh.source.emit('pointerdown');
  fresh.clock.now += 40000;
  await fresh.clock.advance(0);
  assert.equal(
    fresh.requests.length,
    0,
    'stale activity cannot renew on resume',
  );
});

test('an action exactly at the absolute or idle deadline is never sent', async () => {
  const f = fixture();
  f.session(true, f.clock.now + 1000);
  await f.clock.advance(1000);
  f.source.emit('keydown');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 0);
  f.session(true, f.clock.now);
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  assert.equal(f.activity.snapshot.authenticated, false);
  assert.equal(f.requests.length, 0);
});

test('absolute expiry stays bounded by the authenticated transport, never by activity', async () => {
  const f = fixture();
  f.clock.now = f.absoluteDeadline - 60000;
  f.session(true, f.absoluteDeadline);
  f.source.emit('keydown');
  await f.clock.advance(0);
  assert.equal(f.activity.snapshot.expiresAt, f.absoluteDeadline);
  await f.clock.advance(60000);
  f.source.emit('input');
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
});

test('renewal failure does not retry without another genuine action', async () => {
  const f = fixture({
    renew: async () => {
      throw new Error('unconfirmed transport');
    },
  });
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  await f.clock.advance(60000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
  f.source.emit('keydown');
  await f.clock.advance(1000);
  assert.equal(f.requests.length, 2);
});

test('events during a request serialize into one trailing renewal', async () => {
  const gate = deferred();
  let calls = 0;
  const f = fixture({
    renew: () => (++calls === 1 ? gate.promise : Promise.resolve()),
  });
  f.source.emit('pointerdown');
  await f.clock.advance(0);
  for (let i = 0; i < 10; i++) {
    await f.clock.advance(100);
    f.source.emit('input');
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.tasks.size, 0);
  gate.resolve();
  await flush();
  await f.clock.advance(29000);
  assert.equal(f.requests.length, 2);
  await f.clock.advance(60000);
  assert.equal(f.requests.length, 2);
});

test('authentication controls can be excluded without discarding real device and dial actions', async () => {
  const f = fixture({ accept: (event) => event.target !== 'auth-control' });
  f.source.emit('pointerdown', true, { target: 'auth-control' });
  await f.clock.advance(0);
  assert.equal(f.requests.length, 0);
  f.source.emit('change', true, { target: 'microphone-selection' });
  await f.clock.advance(0);
  assert.equal(f.requests.length, 1);
});

test('invalid configuration fails before installing listeners', () => {
  const events = new Events();
  assert.throws(() =>
    createSessionActivity({
      eventSource: events,
      renew: () => Promise.resolve(),
      minIntervalMs: 0,
    }),
  );
  assert.equal(events.count, 0);
});
