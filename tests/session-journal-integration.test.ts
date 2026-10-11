import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import TwilioRestException from 'twilio/lib/base/RestException';
import type WebSocket from 'ws';

import type { SoloConfig } from '../src/solo/config';
import { CloudBudgetJournal } from '../src/solo/cloud-budget-journal';
import {
  SessionManager,
  type BridgeOptions,
  type CallJournalPort,
  type CallProvider,
  type Role,
} from '../src/solo/session-manager';

// Explicit offline providers and journal: no supplier transport or voice model.
const config = {
  PUBLIC_BASE_URL: 'https://phone.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'offline-not-a-key',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
} as SoloConfig;
const target = '+14155550123';
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const identity = 'offline-browser';
const RestException =
  (TwilioRestException as unknown as { default?: typeof TwilioRestException })
    .default || TwilioRestException;

class OfflineSocket extends EventEmitter {
  readyState = 1;

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  send(): void {}
}

function fixture(
  t: TestContext,
  options: {
    create?: CallProvider['create'];
    limit?: CallProvider['limit'];
    missingLimit?: boolean;
    durationMs?: number;
    noReserve?: boolean;
    failBegin?: boolean;
    failRecord?: boolean;
    failTerminal?: boolean;
    failConsume?: boolean;
  } = {},
) {
  const journalEvents: Array<{
    operation: string;
    role?: Role;
    sid?: string;
    bytes?: number;
  }> = [];
  const order: string[] = [];
  const created: Record<string, unknown>[] = [];
  const hungup: string[] = [];
  const limited: Array<{ sid: string; seconds: number }> = [];
  const consumed: Array<{ direction: 'input' | 'output'; bytes: number }> = [];
  const attempted = new Set<Role>();
  let reserved = false;
  let revoked = false;
  let settings: BridgeOptions | undefined;
  let failRecord = options.failRecord || false;
  const deadline = Date.now() + (options.durationMs ?? 300000);
  const journal: CallJournalPort = {
    assertTarget: (to) => {
      order.push('target');
      if (to !== target) throw new Error('OFFLINE_TARGET_DENIED');
    },
    assertCallCurrent: () => {
      if (!reserved || Date.now() >= deadline)
        throw new Error('OFFLINE_BUDGET_DENIED');
    },
    callLimits: (id) => {
      journal.assertCallCurrent(id);
      return { deadline, remainingWallClockMs: deadline - Date.now() };
    },
    beginCreate: (id, role, to) => {
      journal.assertCallCurrent(id);
      if (role === 'remote') journal.assertTarget(to!);
      if (options.failBegin && role === 'remote')
        throw new Error('OFFLINE_STORAGE_FAILURE');
      assert.equal(attempted.has(role), false);
      attempted.add(role);
      order.push(`intent:${role}`);
      journalEvents.push({ operation: 'begin', role });
      return `offline_${role}`;
    },
    recordCreated: (_id, role, sid) => {
      journalEvents.push({ operation: 'created', role, sid });
      if (failRecord) throw new Error('OFFLINE_STORAGE_FAILURE');
      assert.ok(attempted.has(role));
    },
    markUnknown: (_id, role) => {
      journalEvents.push({ operation: 'unknown', role });
      reserved = false;
    },
    confirmAbsent: (_id, role) => {
      journalEvents.push({ operation: 'absent', role });
    },
    confirmTerminal: (_id, role, sid) => {
      journalEvents.push({ operation: 'terminal', role, sid });
      if (options.failTerminal) throw new Error('OFFLINE_STORAGE_FAILURE');
    },
    consumeMedia: (id, direction, bytes) => {
      journal.assertCallCurrent(id);
      if (options.failConsume) throw new Error('OFFLINE_MEDIA_LIMIT');
      consumed.push({ direction, bytes });
    },
  };
  const manager = new SessionManager({
    callJournal: journal,
    providerFactory: () => ({
      create: async (args) => {
        order.push('provider:create');
        created.push(args);
        return options.create ? options.create(args) : { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungup.push(sid);
      },
      ...(options.missingLimit
        ? {}
        : {
            limit: async (sid: string, seconds: number) => {
              limited.push({ sid, seconds });
              await options.limit?.(sid, seconds);
            },
          }),
    }),
    bridgeFactory: (args) => {
      settings = args;
      return { attach: () => {}, close: () => {} };
    },
    maxCallMs: 300000,
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
  });
  const admission = {
    browserIdentity: identity,
    deferBrowserJoin: true as const,
    beforePublish: () => {
      order.push('ownership');
    },
    authorizeCurrent: () => {
      if (revoked) throw new Error('OFFLINE_OWNER_REVOKED');
    },
    authorizeBrowserJoin: () => 'join' as const,
  };
  const call = manager.createOutbound(
    config,
    target,
    'continuous-captions',
    admission,
  );
  if (!options.noReserve) {
    reserved = true;
    manager.enforceCallDeadline(call.id);
    journal.beginCreate(call.id, 'local');
  }
  const connect = () =>
    manager.connectBrowser({
      ...call.connectionParams,
      From: `client:${identity}`,
      CallSid: localSid,
    });
  const connectControlled = () =>
    manager.connectBrowserControlled({
      ...call.connectionParams,
      From: `client:${identity}`,
      CallSid: localSid,
    });
  const attach = (
    role: Role = 'local',
    nonce = call.connectionParams.nonce,
  ) => {
    const socket = new OfflineSocket();
    const accepted = manager.attachMedia(socket as unknown as WebSocket, {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: `MZ${(role === 'local' ? '3' : '4').repeat(32)}`,
      customParameters: { sessionId: call.id, role, nonce },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    });
    return { accepted, socket };
  };
  const bridge = () => {
    assert.ok(settings);
    return settings;
  };
  const ready = async () => {
    await connectControlled();
    assert.equal(attach().accepted, true);
    bridge().onConnection({ role: 'local', state: 'ready' });
    await tick();
  };
  const remoteNonce = () => {
    const url = new URL(created[0].url as string);
    const nonce = url.searchParams.get('nonce');
    assert.ok(nonce);
    return nonce;
  };
  return {
    manager,
    call,
    journal,
    journalEvents,
    order,
    created,
    hungup,
    limited,
    consumed,
    connect,
    connectControlled,
    attach,
    bridge,
    ready,
    remoteNonce,
    revoke: () => {
      revoked = true;
    },
    failRecord: () => {
      failRecord = true;
    },
    reserve: () => {
      reserved = true;
    },
  };
}

test('durable manager rejects an unprotected local caller and checks destination before ownership registration', async (t) => {
  const f = fixture(t);
  await f.manager.end(f.call.id);
  f.manager.setPresence(true);
  assert.throws(
    () => f.manager.createOutbound(config, target),
    /CONTROLLED_CALL_REQUIRED/,
  );
  const events = f.order.length;
  assert.throws(
    () =>
      f.manager.createOutbound(config, '+14155550124', 'continuous-captions', {
        browserIdentity: identity,
        deferBrowserJoin: true,
        beforePublish: () => {
          throw new Error('OWNERSHIP_MUST_NOT_RUN');
        },
        authorizeCurrent: () => {},
        authorizeBrowserJoin: () => 'join',
      }),
    /OFFLINE_TARGET_DENIED/,
  );
  assert.deepEqual(f.order.slice(events), ['target']);
  assert.equal(f.created.length, 0);
});

test('every remote creation has a durable intent before provider submission and receives the remaining call time limit', async (t) => {
  const f = fixture(t);
  await f.ready();
  assert.ok(
    f.order.indexOf('intent:remote') < f.order.indexOf('provider:create'),
  );
  assert.equal(f.created.length, 1);
  assert.ok(
    Number(f.created[0].timeLimit) > 0 && Number(f.created[0].timeLimit) <= 300,
  );
  assert.ok(
    f.journalEvents.some(
      (event) =>
        event.operation === 'created' &&
        event.role === 'remote' &&
        event.sid === remoteSid,
    ),
  );
  await f.manager.end(f.call.id);
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.deepEqual(
    new Set(
      f.journalEvents
        .filter((event) => event.operation === 'terminal')
        .map((event) => event.sid),
    ),
    new Set([localSid, remoteSid]),
  );
});

test('missing current reservation never constructs the bridge or submits the destination leg', async (t) => {
  const f = fixture(t, { noReserve: true });
  assert.throws(f.connect, /BUDGET_NOT_READY/);
  await tick();
  assert.equal(f.attach().accepted, false);
  assert.throws(f.bridge);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.hungup, [localSid]);
});

test('failed durable remote intent creates no provider request or unknown role but still cleans the browser leg', async (t) => {
  const f = fixture(t, { failBegin: true });
  await f.ready();
  assert.equal(f.created.length, 0);
  assert.equal(
    f.journalEvents.some((event) => event.operation === 'unknown'),
    false,
  );
  assert.deepEqual(f.hungup, [localSid]);
  assert.equal(f.manager.controlAdmissionBlocked, true);
  await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
});

test('a known browser SID survives a journal write failure and is terminated independently', async (t) => {
  const f = fixture(t, { failRecord: true });
  assert.throws(f.connect, /BUDGET_NOT_READY/);
  await tick();
  assert.deepEqual(f.hungup, [localSid]);
  assert.equal(f.created.length, 0);
  assert.equal(f.manager.activeSession?.cleanupUnconfirmed, true);
  await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
});

test('a provider-returned SID survives failed persistence and both known legs are still terminated', async (t) => {
  let fail!: () => void;
  const f = fixture(t, {
    create: async () => {
      fail();
      return { sid: remoteSid };
    },
  });
  fail = f.failRecord;
  await f.ready();
  await tick();
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.equal(
    f.journalEvents.some((event) => event.operation === 'unknown'),
    false,
  );
  await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
});

test('a journal terminal write failure never suppresses cleanup of the other known leg', async (t) => {
  const f = fixture(t, { failTerminal: true });
  await f.ready();
  await f.manager.end(f.call.id);
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
  assert.equal(f.hungup.length, 2);
  await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
  assert.equal(f.hungup.length, 2);
});

for (const failure of [
  { name: 'transport error', error: new Error('OFFLINE_TRANSPORT') },
  {
    name: 'unverified numeric status',
    error: Object.assign(new Error('OFFLINE'), { status: 400 }),
  },
  {
    name: '408 response',
    error: new RestException({ statusCode: 408, body: {} }),
  },
  {
    name: '429 response',
    error: new RestException({ statusCode: 429, body: {} }),
  },
  {
    name: '500 response',
    error: new RestException({ statusCode: 500, body: {} }),
  },
]) {
  test(`${failure.name} retains unknown creation and accepts only a bound late callback for cleanup`, async (t) => {
    const f = fixture(t, {
      create: async () => {
        throw failure.error;
      },
    });
    await f.ready();
    assert.ok(
      f.journalEvents.some(
        (event) => event.operation === 'unknown' && event.role === 'remote',
      ),
    );
    assert.equal(
      f.journalEvents.some((event) => event.operation === 'absent'),
      false,
    );
    await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
    f.manager.handleStatus(f.call.id, 'remote', f.remoteNonce(), {
      CallSid: remoteSid,
      CallStatus: 'ringing',
    });
    await tick();
    assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  });
}

test('a definitive Twilio SDK rejection records an absent leg without inventing usage or refund', async (t) => {
  const f = fixture(t, {
    create: async () => {
      throw new RestException({ statusCode: 400, body: { code: 21211 } });
    },
  });
  await f.ready();
  assert.ok(
    f.journalEvents.some(
      (event) => event.operation === 'absent' && event.role === 'remote',
    ),
  );
  assert.equal(
    f.journalEvents.some((event) => event.operation === 'unknown'),
    false,
  );
  assert.deepEqual(f.hungup, [localSid]);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
});

test('native and both caption branches check connect authority and consume each actual audio byte once', async (t) => {
  const f = fixture(t);
  await f.connectControlled();
  assert.equal(f.attach().accepted, true);
  const gate = f.bridge().admitAudio;
  assert.ok(gate);
  for (const path of [
    'native_translation',
    'outgoing_captions',
    'outgoing_captions',
    'remote_captions',
    'remote_captions',
  ] as const) {
    assert.equal(
      gate({
        role: path === 'remote_captions' ? 'remote' : 'local',
        path,
        stage: 'connect',
        bytes: 0,
        audioMs: 0,
      }),
      true,
    );
  }
  assert.equal(f.consumed.length, 0);
  for (const path of [
    'native_translation',
    'outgoing_captions',
    'remote_captions',
  ] as const) {
    assert.equal(
      gate({
        role: path === 'remote_captions' ? 'remote' : 'local',
        path,
        stage: 'input',
        bytes: 960,
        audioMs: 20,
      }),
      true,
    );
  }
  assert.equal(
    gate({
      role: 'local',
      path: 'native_translation',
      stage: 'output',
      bytes: 4800,
      audioMs: 100,
    }),
    true,
  );
  assert.equal(
    gate({
      role: 'remote',
      path: 'return_original',
      stage: 'output',
      bytes: 160,
      audioMs: 20,
    }),
    true,
  );
  assert.deepEqual(f.consumed, [
    { direction: 'input', bytes: 960 },
    { direction: 'input', bytes: 960 },
    { direction: 'input', bytes: 960 },
    { direction: 'output', bytes: 4800 },
    { direction: 'output', bytes: 160 },
  ]);
  f.revoke();
  assert.equal(
    gate({
      role: 'local',
      path: 'outgoing_captions',
      stage: 'input',
      bytes: 960,
      audioMs: 20,
    }),
    false,
  );
  assert.equal(f.consumed.length, 5);
  await tick();
  assert.deepEqual(f.hungup, [localSid]);
});

test('media limit failure stops upload/output and independently terminates known legs', async (t) => {
  const f = fixture(t, { failConsume: true });
  await f.ready();
  assert.equal(
    f.bridge().admitAudio!({
      role: 'local',
      path: 'native_translation',
      stage: 'input',
      bytes: 960,
      audioMs: 20,
    }),
    false,
  );
  assert.equal(f.consumed.length, 0);
  await tick();
  assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
});

test('reservation deadline expires before any media or answer and cannot be restarted by rechecking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(t, { durationMs: 80 });
  await f.connectControlled();
  t.mock.timers.tick(30);
  f.manager.enforceCallDeadline(f.call.id);
  t.mock.timers.tick(50);
  await tick();
  assert.equal(f.manager.activeSession, null);
  assert.deepEqual(f.hungup, [localSid]);
  assert.equal(f.created.length, 0);
  assert.throws(
    () => f.manager.enforceCallDeadline(f.call.id),
    /BUDGET_NOT_READY/,
  );
});

test('a signed terminal callback journals its validated bound SID but a mismatched callback cannot write', async (t) => {
  const f = fixture(t);
  await f.ready();
  const before = f.journalEvents.length;
  assert.throws(
    () =>
      f.manager.handleStatus(f.call.id, 'remote', 'wrong-nonce', {
        CallSid: remoteSid,
        CallStatus: 'completed',
      }),
    /INVALID_SESSION/,
  );
  assert.equal(f.journalEvents.length, before);
  f.manager.handleStatus(f.call.id, 'remote', f.remoteNonce(), {
    CallSid: remoteSid,
    CallStatus: 'completed',
  });
  await tick();
  assert.ok(
    f.journalEvents.some(
      (event) =>
        event.operation === 'terminal' &&
        event.role === 'remote' &&
        event.sid === remoteSid,
    ),
  );
  assert.deepEqual(f.hungup, [localSid]);
});

test('controlled browser stream is withheld until the supplier accepts its independent duration cap', async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(t, { limit: async () => pending });
  let published = false;
  const reply = f.connectControlled().then((xml) => {
    published = true;
    return xml;
  });
  await tick();
  assert.equal(published, false);
  assert.equal(f.limited.length, 1);
  assert.equal(f.limited[0].sid, localSid);
  assert.ok(f.limited[0].seconds > 0 && f.limited[0].seconds <= 300);
  assert.equal(f.attach().accepted, false);
  assert.throws(f.bridge);
  assert.equal(f.created.length, 0);
  release();
  assert.match(await reply, /<Stream/);
  assert.equal(f.attach().accepted, true);
  f.bridge().onConnection({ role: 'local', state: 'ready' });
  await tick();
  assert.equal(f.created.length, 1);
});

for (const options of [
  { name: 'missing cap operation', missingLimit: true },
  {
    name: 'failed cap update',
    limit: async () => {
      throw new Error('OFFLINE_PROVIDER_FAILURE');
    },
  },
]) {
  test(`${options.name} emits Hangup and cleans the browser SID before any model or outgoing request`, async (t) => {
    const f = fixture(t, options);
    const xml = await f.connectControlled();
    assert.match(xml, /<Hangup/);
    assert.doesNotMatch(xml, /<Stream/);
    assert.deepEqual(f.hungup, [localSid]);
    assert.equal(f.attach().accepted, false);
    assert.throws(f.bridge);
    assert.equal(f.created.length, 0);
    assert.equal(
      f.journalEvents.some((event) =>
        ['unknown', 'absent'].includes(event.operation),
      ),
      false,
    );
  });
}

test('revocation during the supplier cap update discards its late success and cannot start media', async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(t, { limit: async () => pending });
  const reply = f.connectControlled();
  await tick();
  f.revoke();
  release();
  assert.match(await reply, /<Hangup/);
  assert.equal(f.attach().accepted, false);
  assert.throws(f.bridge);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.hungup, [localSid]);
});

test('hangup during the supplier cap update discards its late success and keeps a completed tombstone', async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(t, { limit: async () => pending });
  const reply = f.connectControlled();
  await tick();
  await f.manager.end(f.call.id);
  release();
  assert.match(await reply, /<Hangup/);
  assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.hungup, [localSid]);
});

test('outgoing subtitle failure retains native call readiness and preserves a separate speaker status in snapshots', async (t) => {
  const f = fixture(t);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  f.manager.on('event', (event) => {
    events.push(event);
  });
  await f.ready();
  f.bridge().onCaptionState({ state: 'ready' });
  f.bridge().onOutgoingCaptionState!({
    role: 'local',
    state: 'failed',
    translationSource: 'independent_text',
  });
  assert.equal(f.manager.activeSession?.translationReady, true);
  assert.equal(f.manager.activeSession?.captionState, 'ready');
  assert.equal(f.manager.activeSession?.outgoingCaptionState, 'failed');
  assert.deepEqual(events.at(-1), {
    event: 'caption-status',
    data: {
      role: 'local',
      state: 'failed',
      translationSource: 'independent_text',
      sessionId: f.call.id,
    },
  });
  assert.equal(f.hungup.length, 0);
});

test('real durable journal and manager record both legs and termination while retaining pending billing and the full reservation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'phone-manager-journal-'));
  const now = Date.now();
  const journal = CloudBudgetJournal.open({
    directory,
    policy: {
      allowedTarget: target,
      accountSid: config.TWILIO_ACCOUNT_SID,
      applicationSid: `AP${'a'.repeat(32)}`,
      budgetUsdMicros: 5000000,
      worstCaseCallUsdMicros: 5000000,
      maxCalls: 1,
      maxWallClockMs: 300000,
      maxInputBytes: 48000,
      maxOutputBytes: 48000,
      lateCallbackWindowMs: 1000,
      rates: {
        // These are synthetic offline rate evidence, not verified real prices.
        twilioReference: 'https://www.twilio.com/synthetic-offline-test',
        openaiReference: 'https://openai.com/synthetic-offline-test',
        checkedAt: now - 1000,
        validUntil: now + 3600000,
      },
    },
  });
  const creates: Record<string, unknown>[] = [];
  const hungup: string[] = [];
  let settings: BridgeOptions | undefined;
  const manager = new SessionManager({
    callJournal: journal,
    maxCallMs: 300000,
    providerFactory: () => ({
      create: async (args) => {
        creates.push(args);
        return { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungup.push(sid);
      },
      limit: async () => {},
    }),
    bridgeFactory: (args) => {
      settings = args;
      return { attach: () => {}, close: () => {} };
    },
  });
  t.after(async () => {
    await manager.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = manager.createOutbound(config, target, 'continuous-captions', {
    browserIdentity: identity,
    deferBrowserJoin: true,
    beforePublish: () => {},
    authorizeCurrent: () => {},
    authorizeBrowserJoin: () => 'join',
  });
  const reservation = await journal.reserve({
    version: 1,
    callId: call.id,
    identity,
    authSessionId: 'offline_session',
    principalId: 'offline_principal',
    browserOwnerId: 'offline_owner',
    authEpoch: 1,
    controller: { leaseId: 'offline_lease', tabId: 'offline_tab', epoch: 1 },
    issuedAt: now,
    expiresAt: now + 60000,
    incomingAllow: false,
    outgoingApplicationSid: `AP${'a'.repeat(32)}`,
    outgoing: { callId: call.id, identity },
  });
  manager.enforceCallDeadline(call.id);
  journal.beginCreate(call.id, 'local');
  assert.match(
    await manager.connectBrowserControlled({
      ...call.connectionParams,
      From: `client:${identity}`,
      CallSid: localSid,
    }),
    /<Stream/,
  );
  assert.equal(
    manager.attachMedia(new OfflineSocket() as unknown as WebSocket, {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: localSid,
      streamSid: `MZ${'3'.repeat(32)}`,
      customParameters: {
        sessionId: call.id,
        role: 'local',
        nonce: call.connectionParams.nonce,
      },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    }),
    true,
  );
  assert.ok(settings);
  settings.onConnection({ role: 'local', state: 'ready' });
  await tick();
  assert.equal(creates.length, 1);
  await manager.end(call.id);
  await reservation.release();
  const persisted = JSON.parse(
    readFileSync(join(directory, 'trial-budget.json'), 'utf8'),
  );
  assert.equal(persisted.chargedUsdMicros, 5000000);
  assert.equal(persisted.intents.length, 1);
  assert.equal(persisted.intents[0].local.sid, localSid);
  assert.equal(persisted.intents[0].remote.sid, remoteSid);
  assert.equal(persisted.intents[0].local.phase, 'terminal');
  assert.equal(persisted.intents[0].remote.phase, 'terminal');
  assert.equal(persisted.intents[0].phase, 'cleanup');
  assert.equal(persisted.intents[0].usage, 'pending');
  assert.deepEqual(new Set(hungup), new Set([localSid, remoteSid]));
});
