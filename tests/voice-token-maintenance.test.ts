import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceTokenMaintenance } from '../public/voice-token-maintenance.js';

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
function fixture() {
  let time = 1000, current = true, timerId = 0, refreshes = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const updates: string[] = [], failures: { code: string }[] = [];
  let refresh: () => Promise<any> = async () => ({ token: `offline-${++refreshes}`, tokenExpiresAt: time + 900000 });
  const owner = createVoiceTokenMaintenance({
    device: { updateToken: (token: string) => updates.push(token) }, tokenExpiresAt: time + 180000,
    refreshToken: () => refresh(), isCurrent: () => current, now: () => time,
    setTimer(callback: () => void, delay: number) { timers.set(++timerId, { at: time + delay, callback }); return timerId; },
    clearTimer(id: number) { timers.delete(id); }, onFailure: value => failures.push(value),
  });
  return { owner, timers, updates, failures,
    replaceRefresh(value: typeof refresh) { refresh = value; }, retire() { current = false; },
    jump(ms: number) { time += ms; },
    async advance(ms: number) {
      const until = time + ms;
      for (let count = 0; count < 100; count += 1) {
        const due = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { time = until; await flush(); return; }
        time = due[1].at; timers.delete(due[0]); due[1].callback(); await flush();
      }
      throw new Error('Unexpected refresh loop');
    },
  };
}

test('only an accepted owner starts finite token maintenance and remains beyond an initial three-minute expiry', async () => {
  const f = fixture();
  await f.owner.refresh(); assert.equal(f.updates.length, 0);
  f.owner.start(); await f.advance(181000);
  assert.deepEqual(f.updates, ['offline-1']); assert.deepEqual(f.failures, []);
  await f.advance(900000);
  assert.equal(f.updates.length, 2); f.owner.stop(); assert.equal(f.timers.size, 0);
});

test('timer throttling and a hidden-page resume refresh the same existing Device without a dial', async () => {
  const f = fixture(); f.owner.start(); f.jump(181000);
  f.owner.check(); await flush();
  assert.deepEqual(f.updates, ['offline-1']); assert.deepEqual(f.failures, []); f.owner.stop();
});

test('simultaneous SDK warning, timer and resume request share one finite refresh', async () => {
  const f = fixture(); let resolve!: (value: any) => void, requests = 0;
  f.replaceRefresh(() => { requests += 1; return new Promise(done => { resolve = done; }); });
  f.owner.start(); const first = f.owner.refresh(); const second = f.owner.refresh(); f.owner.check();
  assert.equal(requests, 1); resolve({ token: 'offline-one', tokenExpiresAt: 901000 });
  await Promise.all([first, second]); assert.deepEqual(f.updates, ['offline-one']); f.owner.stop();
});

test('hangup or logout while refresh is pending discards the result and cannot restore the Device', async () => {
  const f = fixture(); let resolve!: (value: any) => void;
  f.replaceRefresh(() => new Promise(done => { resolve = done; }));
  f.owner.start(); const pending = f.owner.refresh(); f.retire(); f.owner.stop();
  resolve({ token: 'offline-late', tokenExpiresAt: 901000 }); await pending;
  assert.deepEqual(f.updates, []); assert.equal(f.timers.size, 0); assert.deepEqual(f.failures, []);
});

test('revoked authentication stops maintenance and returns only its fixed error code', async () => {
  const f = fixture(); f.replaceRefresh(async () => { throw Object.assign(new Error('secret body and number must not escape'), { code: 'UNAUTHORIZED' }); });
  f.owner.start(); await f.owner.refresh();
  assert.deepEqual(f.failures, [{ code: 'UNAUTHORIZED' }]); assert.equal(f.timers.size, 0);
  await f.owner.refresh(); assert.deepEqual(f.updates, []);
});

test('transient failures receive only two retries without treating healthy media as disconnected', async () => {
  const f = fixture(); let count = 0;
  f.replaceRefresh(async () => { count += 1; throw new Error('Offline transport'); });
  f.owner.start(); await f.owner.refresh(); await f.advance(4000);
  assert.equal(count, 3); assert.deepEqual(f.failures, [{ code: 'VOICE_TOKEN_REFRESH_UNCONFIRMED' }]);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.updates, []); f.owner.stop();
});

test('an unchanged absolute expiry does not repeatedly update the SDK or invent a longer credential', async () => {
  const f = fixture(); f.replaceRefresh(async () => ({ token: 'offline-same-finite-boundary', tokenExpiresAt: 181000 }));
  f.owner.start(); await f.owner.refresh(); await f.owner.refresh();
  assert.deepEqual(f.updates, []); assert.deepEqual(f.failures, []); assert.equal(f.timers.size, 1); f.owner.stop();
});
