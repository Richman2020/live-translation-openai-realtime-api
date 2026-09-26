import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import type WebSocket from 'ws';
import type { SoloConfig } from '../src/solo/config';
import {
  SessionManager,
  terminateCall,
  type BridgeOptions,
  type CallProvider,
  type Role,
} from '../src/solo/session-manager';

const config = {
  PUBLIC_BASE_URL: 'https://phone.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'fake-no-api',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
} as SoloConfig;
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
class Socket extends EventEmitter {
  readyState = 1;
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit('close');
    }
  }
  send() {}
}
function fixture(
  t: any,
  options: {
    create?: CallProvider['create'];
    hangup?: CallProvider['hangup'];
    setupTimeoutMs?: number;
    now?: () => number;
  } = {},
) {
  const created: Record<string, any>[] = [];
  const ended: string[] = [];
  const attached: Role[] = [];
  const events: any[] = [];
  let bridgeOptions: BridgeOptions;
  const provider: CallProvider = {
    create: async (args) => {
      created.push(args);
      return options.create
        ? options.create(args)
        : { sid: args.to === 'client:ai-phone' ? localSid : remoteSid };
    },
    hangup: async (sid) => {
      ended.push(sid);
      await options.hangup?.(sid);
    },
  };
  const manager = new SessionManager({
    providerFactory: () => provider,
    bridgeFactory: (args) => {
      bridgeOptions = args;
      return { attach: (role) => attached.push(role), close() {} };
    },
    setupTimeoutMs: options.setupTimeoutMs,
    now: options.now,
  });
  manager.on('event', (event) => events.push(event));
  manager.setPresence(true);
  t.after(async () => {
    await manager.close();
  });
  return {
    manager,
    created,
    ended,
    attached,
    events,
    bridge: () => bridgeOptions,
  };
}
function attach(
  manager: SessionManager,
  id: string,
  role: Role,
  nonce: string,
  sid: string,
  extras = {},
) {
  const socket = new Socket();
  const accepted = manager.attachMedia(socket as unknown as WebSocket, {
    accountSid: config.TWILIO_ACCOUNT_SID,
    callSid: sid,
    streamSid: `MZ${(role === 'local' ? '3' : '4').repeat(32)}`,
    customParameters: { sessionId: id, role, nonce },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    ...extras,
  });
  return { socket, accepted };
}
function browser(f: ReturnType<typeof fixture>) {
  const call = f.manager.createOutbound(config, '+14155550123');
  f.manager.connectBrowser({
    ...call.connectionParams,
    From: 'client:ai-phone',
    CallSid: localSid,
  });
  return call;
}

test('outbound pays for no PSTN call until authenticated local stream; then pairs unique legs and hangs up both once', async (t) => {
  const f = fixture(t);
  const call = browser(f);
  assert.equal(f.created.length, 0);
  assert.equal(
    attach(f.manager, call.id, 'local', 'wrong', localSid).accepted,
    false,
  );
  assert.equal(
    attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid, {
      accountSid: `AC${'9'.repeat(32)}`,
    }).accepted,
    false,
  );
  assert.equal(
    attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid, {
      mediaFormat: undefined,
    }).accepted,
    false,
  );
  assert.equal(f.created.length, 0);
  const local = attach(
    f.manager,
    call.id,
    'local',
    call.connectionParams.nonce,
    localSid,
  );
  assert.equal(local.accepted, true);
  assert.equal(
    f.bridge().transcriptionModel,
    config.OPENAI_TRANSCRIPTION_MODEL,
  );
  await tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].to, '+14155550123');
  assert.throws(() => f.manager.createOutbound(config, '+13105550123'), /BUSY/);
  assert.equal(
    attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid)
      .accepted,
    false,
  );
  const query = new URL(f.created[0].url).searchParams;
  const remoteNonce = query.get('nonce');
  f.manager.connectLeg(call.id, 'remote', remoteNonce, remoteSid);
  const remote = attach(f.manager, call.id, 'remote', remoteNonce, remoteSid);
  assert.equal(remote.accepted, true);
  assert.equal(f.manager.activeSession.status, 'active');
  const metric = {
    role: 'local' as const,
    name: 'speech_stop_to_first_audio_ms' as const,
    scope: 'provider_generation' as const,
    value: 900,
    at: 2000,
    transcriptionMs: 400,
    queueMs: 200,
    generationMs: 300,
  };
  f.bridge().onMetric?.(metric);
  assert.deepEqual(f.events.at(-1), {
    event: 'translation-metric',
    data: { ...metric, sessionId: call.id },
  });
  assert.deepEqual(f.attached, ['local', 'remote']);
  local.socket.close();
  await tick();
  assert.equal(f.manager.activeSession, null);
  assert.equal(remote.socket.readyState, 3);
  assert.equal(f.events.at(-1).data.error, 'PHONE_STREAM_CLOSED');
  const count = f.events.length;
  f.bridge().onMetric?.(metric);
  assert.equal(
    f.events.length,
    count,
    'ended sessions do not emit late timing',
  );
  f.manager.handleStatus(call.id, 'remote', remoteNonce, {
    CallSid: remoteSid,
    CallStatus: 'completed',
  });
  await f.manager.end(call.id);
  assert.deepEqual(f.ended.sort(), [localSid, remoteSid].sort());
  assert.ok(!JSON.stringify(f.events).includes(call.connectionParams.nonce));
  assert.ok(!JSON.stringify(f.events).includes(remoteNonce));
});

test('inbound requires fresh presence, repeated webhook is idempotent, and rings only the browser identity', async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now });
  now += 46000;
  const body = {
    CallSid: remoteSid,
    From: '+14155550123',
    To: config.TWILIO_CALLER_NUMBER,
  };
  assert.match(f.manager.acceptIncoming(config, body), /Reject/);
  f.manager.setPresence(true);
  const xml = f.manager.acceptIncoming(config, body);
  assert.equal(f.manager.acceptIncoming(config, body), xml);
  const id = f.manager.activeSession.id;
  const nonce = /name="nonce" value="([^"]+)"/.exec(xml)[1];
  assert.equal(
    attach(f.manager, id, 'remote', nonce, remoteSid).accepted,
    true,
  );
  await tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].to, 'client:ai-phone');
  assert.match(
    f.manager.acceptIncoming(config, {
      ...body,
      CallSid: `CA${'8'.repeat(32)}`,
    }),
    /Reject/,
  );
  await f.manager.end(id);
  assert.match(f.manager.acceptIncoming(config, body), /Hangup/);
  assert.equal(f.manager.activeSession, null);
});

test('provider failure ends both legs and produces a failed call, without exposing provider details', async (t) => {
  const f = fixture(t);
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  await tick();
  f.bridge().onFailure('OPENAI_SESSION_FAILED');
  await tick();
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.events.at(-1).data.status, 'failed');
  assert.equal(f.events.at(-1).data.error, 'OPENAI_SESSION_FAILED');
  assert.deepEqual(f.ended.sort(), [localSid, remoteSid].sort());
});

test('definitive call creation rejection exposes only numeric diagnostics and cleans up the browser leg', async (t) => {
  const secret = 'private-provider-details-never-publish';
  const f = fixture(t, {
    create: async () => {
      throw Object.assign(new Error(secret), {
        code: 21215,
        status: 403,
        moreInfo: `https://example.com/${secret}`,
        details: { account: secret, token: secret },
      });
    },
  });
  const call = browser(f);
  const local = attach(
    f.manager,
    call.id,
    'local',
    call.connectionParams.nonce,
    localSid,
  );
  await tick();
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(local.socket.readyState, 3);
  assert.deepEqual(f.ended, [localSid]);
  const ended = f.events.at(-1).data;
  assert.equal(ended.status, 'failed');
  assert.equal(ended.error, 'TWILIO_CALL_FAILED');
  assert.equal(ended.providerErrorCode, 21215);
  assert.equal(ended.providerHttpStatus, 403);
  assert.equal(JSON.stringify(f.events).includes(secret), false);
});

test('malformed provider codes are omitted rather than coerced or echoed', async (t) => {
  for (const code of [
    'private-code',
    '21215',
    -1,
    0,
    1.5,
    1000000,
    NaN,
    Infinity,
  ]) {
    const f = fixture(t, {
      create: async () => {
        throw { status: 400, code };
      },
    });
    const call = browser(f);
    attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
    await tick();
    assert.equal(f.manager.activeSession, null);
    assert.equal(f.manager.isCleanupConfirmed(call.id), true);
    assert.equal(f.events.at(-1).data.providerHttpStatus, 400);
    assert.equal(
      Object.hasOwn(f.events.at(-1).data, 'providerErrorCode'),
      false,
    );
    assert.equal(JSON.stringify(f.events).includes('private-code'), false);
  }
});

test('safe diagnostics preserve ambiguous creation cleanup until a signed callback confirms the leg', async (t) => {
  const f = fixture(t, {
    create: async () => {
      throw Object.assign(new Error('private transport details'), {
        status: 503,
        code: 20500,
      });
    },
  });
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  await tick();
  assert.equal(f.manager.activeSession.cleanupUnconfirmed, true);
  assert.equal(f.manager.activeSession.providerHttpStatus, 503);
  assert.equal(f.manager.activeSession.providerErrorCode, 20500);
  assert.equal(f.manager.isCleanupConfirmed(call.id), false);
  assert.equal(
    JSON.stringify(f.events).includes('private transport details'),
    false,
  );
  const nonce = new URL(f.created[0].statusCallback).searchParams.get('nonce');
  f.manager.handleStatus(call.id, 'remote', nonce, {
    CallSid: remoteSid,
    CallStatus: 'completed',
  });
  await tick();
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
});

test('a late successful create after hangup is immediately terminated and never revives the session', async (t) => {
  let resolveCreate: (value: { sid: string }) => void;
  const pending = new Promise<{ sid: string }>((resolve) => {
    resolveCreate = resolve;
  });
  const f = fixture(t, { create: () => pending });
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  await f.manager.end(call.id);
  resolveCreate({ sid: remoteSid });
  await tick();
  assert.equal(f.manager.activeSession, null);
  assert.ok(f.ended.includes(remoteSid));
});

test('ambiguous failed create is reconciled by a late authenticated status callback and terminated', async (t) => {
  const f = fixture(t, {
    create: async () => {
      throw new Error('provider timed out');
    },
  });
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  await tick();
  assert.equal(f.manager.activeSession.cleanupUnconfirmed, true);
  const query = new URL(f.created[0].statusCallback).searchParams;
  const nonce = query.get('nonce');
  f.manager.handleStatus(call.id, 'remote', nonce, {
    CallSid: remoteSid,
    CallStatus: 'ringing',
  });
  await tick();
  f.manager.handleStatus(call.id, 'remote', nonce, {
    CallSid: remoteSid,
    CallStatus: 'ringing',
  });
  await tick();
  assert.equal(f.ended.filter((sid) => sid === remoteSid).length, 1);
});

test('unaccepted calls expire, free the single-call slot, and malformed destination never dials', async (t) => {
  const f = fixture(t, { setupTimeoutMs: 15 });
  assert.throws(
    () => f.manager.createOutbound(config, '911'),
    /INVALID_DESTINATION/,
  );
  assert.throws(
    () => f.manager.createOutbound(config, config.TWILIO_CALLER_NUMBER),
    /OWN_NUMBER/,
  );
  f.manager.createOutbound(config, '+14155550123');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.created.length, 0);
  assert.equal(f.events.at(-1).data.error, 'CALL_SETUP_TIMEOUT');
});

test('termination cancels ringing calls, handles an answer race, and ignores already terminal legs', async () => {
  let current = 'ringing';
  const updates: string[] = [];
  const call = {
    fetch: async () => ({ status: current }),
    update: async ({ status }: { status: 'canceled' | 'completed' }) => {
      updates.push(status);
      if (status === 'canceled') {
        current = 'in-progress';
        throw new Error('answered during cancellation');
      }
      current = 'completed';
    },
  };
  await terminateCall(call);
  await terminateCall(call);
  assert.deepEqual(updates, ['canceled', 'completed']);
});

test('failed hangup retains the call slot; a second successful hangup confirms cleanup and releases it', async (t) => {
  let refuse = true;
  const f = fixture(t, {
    hangup: async (sid) => {
      if (sid === remoteSid && refuse) throw new Error('network unavailable');
    },
  });
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  await tick();
  await f.manager.end(call.id);
  assert.equal(f.manager.activeSession.id, call.id);
  assert.equal(f.manager.activeSession.status, 'ending');
  assert.equal(f.manager.activeSession.cleanupUnconfirmed, true);
  assert.equal(f.manager.isCleanupConfirmed(call.id), false);
  assert.throws(() => f.manager.createOutbound(config, '+13105550123'), /BUSY/);
  refuse = false;
  await f.manager.end(call.id);
  assert.equal(f.manager.activeSession, null);
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.equal(f.ended.filter((sid) => sid === localSid).length, 1);
  assert.equal(f.ended.filter((sid) => sid === remoteSid).length, 2);
});

test('shutdown waits for pending create and its late call termination before acknowledging safety', async (t) => {
  let resolveCreate: (value: { sid: string }) => void;
  const pending = new Promise<{ sid: string }>((resolve) => {
    resolveCreate = resolve;
  });
  const f = fixture(t, { create: () => pending });
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  let stopped = false;
  const stopping = f.manager.close().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(stopped, false);
  resolveCreate({ sid: remoteSid });
  await stopping;
  assert.equal(f.manager.isCleanupConfirmed(call.id), true);
  assert.ok(f.ended.includes(remoteSid));
  assert.equal(f.manager.activeSession, null);
});

test('shutdown refuses an ambiguous creation until its signed terminal callback resolves the unknown leg', async (t) => {
  const f = fixture(t, {
    create: async () => {
      throw new Error('transport failed after submission');
    },
  });
  const call = browser(f);
  attach(f.manager, call.id, 'local', call.connectionParams.nonce, localSid);
  await tick();
  await assert.rejects(f.manager.close(), /CALL_CLEANUP_UNCONFIRMED/);
  assert.equal(f.manager.activeSession.cleanupUnconfirmed, true);
  const nonce = new URL(f.created[0].statusCallback).searchParams.get('nonce');
  f.manager.handleStatus(call.id, 'remote', nonce, {
    CallSid: remoteSid,
    CallStatus: 'completed',
  });
  await f.manager.close();
  assert.equal(f.manager.activeSession, null);
});
