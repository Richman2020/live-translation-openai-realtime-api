import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import { CloudBudgetJournal } from '../src/solo/cloud-budget-journal';
import type { SoloConfig } from '../src/solo/config';
import {
  createSessionBridge,
  SessionManager,
  type Role,
} from '../src/solo/session-manager';

// Real journal, manager, bridge and protocol clients. Only supplier transports
// are deterministic fakes; no external API, paid model or phone is contacted.
const config = {
  PUBLIC_BASE_URL: 'https://phone.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'offline-not-a-key',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe',
} as SoloConfig;
const target = '+14155550123';
const applicationSid = `AP${'a'.repeat(32)}`;
const identity = 'offline-browser';
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const streams = {
  local: `MZ${'3'.repeat(32)}`,
  remote: `MZ${'4'.repeat(32)}`,
};

class OfflineSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  send(raw: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  receive(event: unknown): void {
    this.emit('message', JSON.stringify(event));
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }

  socket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

async function fixture(t: TestContext, outgoingCaptions: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'continuous-cloud-session-'));
  const now = 100000;
  const journal = CloudBudgetJournal.open({
    directory,
    now: () => now,
    policy: {
      allowedTarget: target,
      accountSid: config.TWILIO_ACCOUNT_SID,
      applicationSid,
      budgetUsdMicros: 5000000,
      worstCaseCallUsdMicros: 5000000,
      maxCalls: 1,
      maxWallClockMs: 300000,
      maxInputBytes: 48000,
      maxOutputBytes: 48000,
      lateCallbackWindowMs: 1000,
      rates: {
        // Synthetic offline evidence, not a claim about current real prices.
        twilioReference: 'https://www.twilio.com/synthetic-offline-test',
        openaiReference: 'https://openai.com/synthetic-offline-test',
        checkedAt: now - 1000,
        validUntil: now + 3600000,
      },
    },
  });
  const providers: Array<{ url: string; socket: OfflineSocket }> = [];
  const created: Record<string, unknown>[] = [];
  const limited: Array<{ sid: string; seconds: number }> = [];
  const hungup: string[] = [];
  const persisted = () =>
    JSON.parse(readFileSync(join(directory, 'trial-budget.json'), 'utf8'));
  let acknowledgeLimit!: () => void;
  const limitAcknowledged = new Promise<void>((resolve) => {
    acknowledgeLimit = resolve;
  });
  const forbidLocalVoice = () => {
    throw new Error('OFFLINE_LOCAL_VOICE_MUST_NOT_START');
  };
  const manager = new SessionManager({
    callJournal: journal,
    maxCallMs: 300000,
    now: () => now,
    providerFactory: () => ({
      create: async (args) => {
        // The actual on-disk intent must exist before submitting a dial.
        assert.equal(persisted().intents[0].remote.phase, 'started');
        created.push(args);
        return { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungup.push(sid);
      },
      limit: async (sid, seconds) => {
        limited.push({ sid, seconds });
        await limitAcknowledged;
      },
    }),
    bridgeFactory: (settings) =>
      createSessionBridge(
        {
          ...settings,
          outgoingCaptions,
          createWebSocket: (url) => {
            const socket = new OfflineSocket();
            providers.push({ url, socket });
            return socket.socket();
          },
        },
        {
          nano: forbidLocalVoice,
          nanoCaption: forbidLocalVoice,
          pocket: forbidLocalVoice,
        },
      ),
  });
  t.after(async () => {
    acknowledgeLimit();
    await manager.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = manager.createOutbound(config, target, 'continuous-captions', {
    browserIdentity: identity,
    deferBrowserJoin: true,
    beforePublish: () => {},
    authorizeCurrent: () => {},
    authorizeBrowserJoin: (fields) => {
      assert.equal(fields.From, `client:${identity}`);
      assert.equal(fields.CallSid, localSid);
      return 'join';
    },
  });
  await journal.reserve({
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
    outgoingApplicationSid: applicationSid,
    outgoing: { callId: call.id, identity },
  });
  manager.enforceCallDeadline(call.id);
  journal.beginCreate(call.id, 'local');
  const browserReply = manager.connectBrowserControlled({
    ...call.connectionParams,
    From: `client:${identity}`,
    CallSid: localSid,
  });
  const attach = (role: Role, socket: OfflineSocket, nonce: string) =>
    manager.attachMedia(socket.socket(), {
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: streams[role],
      customParameters: { sessionId: call.id, role, nonce },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    });
  const media = (role: Role, socket: OfflineSocket, audio: Buffer) =>
    socket.receive({
      event: 'media',
      streamSid: streams[role],
      media: { track: 'inbound', payload: audio.toString('base64') },
    });
  return {
    manager,
    call,
    providers,
    created,
    limited,
    hungup,
    persisted,
    browserReply,
    acknowledgeLimit,
    attach,
    media,
  };
}

for (const outgoingCaptions of [false, true]) {
  test(`controlled continuous call progresses from local handshake to one timed remote dial (${outgoingCaptions ? 'five' : 'three'} streams)`, async (t) => {
    const f = await fixture(t, outgoingCaptions);
    const local = new OfflineSocket();
    const remote = new OfflineSocket();
    local.open();
    remote.open();
    const pcmu = Buffer.alloc(160, 0x55);

    assert.deepEqual(f.limited, [{ sid: localSid, seconds: 300 }]);
    const premature = new OfflineSocket();
    premature.open();
    assert.equal(
      f.attach('local', premature, f.call.connectionParams.nonce),
      false,
    );
    assert.equal(premature.readyState, WebSocket.CLOSED);
    assert.equal(f.providers.length, 0);
    assert.equal(f.created.length, 0);

    f.acknowledgeLimit();
    assert.match(await f.browserReply, /<Stream/);
    assert.equal(f.attach('local', local, f.call.connectionParams.nonce), true);
    assert.equal(f.providers.length, 1);
    assert.equal(f.created.length, 0);
    const native = f.providers[0].socket;
    assert.match(
      f.providers[0].url,
      /\/translations\?model=gpt-realtime-translate$/,
    );
    f.media('local', local, pcmu);
    assert.equal(native.sent.length, 0);
    native.open();
    assert.equal(native.sent.length, 1);
    assert.equal(native.sent[0].type, 'session.update');
    f.media('local', local, pcmu);
    const nativeReady = {
      type: 'session.updated',
      session: {
        model: 'gpt-realtime-translate',
        audio: { output: { language: 'en' } },
      },
    };
    native.receive(nativeReady);
    await tick();
    assert.equal(f.created.length, 1);
    assert.equal(f.created[0].to, target);
    assert.equal(f.created[0].timeLimit, 300);
    assert.equal(f.persisted().intents[0].remote.sid, remoteSid);
    assert.equal(f.manager.activeSession?.translationReady, true);
    native.receive(nativeReady);
    await tick();
    assert.equal(f.created.length, 1);
    f.media('local', local, pcmu);
    assert.equal(
      native.sent.filter((event) => event.type.endsWith('.append')).length,
      0,
    );
    assert.equal(f.providers.length, 1);

    const callback = new URL(f.created[0].url as string);
    const remoteNonce = callback.searchParams.get('nonce')!;
    assert.match(
      f.manager.connectLeg(f.call.id, 'remote', remoteNonce, remoteSid),
      /<Stream/,
    );
    assert.equal(f.attach('remote', remote, remoteNonce), true);
    assert.equal(f.providers.length, outgoingCaptions ? 5 : 3);
    assert.equal(
      f.providers.filter(({ url }) => url.includes('/translations?')).length,
      1,
    );
    assert.equal(
      f.providers.filter(({ url }) => url.endsWith('?intent=transcription'))
        .length,
      outgoingCaptions ? 2 : 1,
    );
    assert.equal(
      f.providers.filter(({ url }) => url.endsWith('?model=gpt-realtime-1.5'))
        .length,
      outgoingCaptions ? 2 : 1,
    );

    // Return English is delivered even while all independent captions connect.
    f.media('remote', remote, pcmu);
    const returned = local.sent.find((event) => event.event === 'media');
    assert.ok(returned);
    assert.equal(returned.media.payload, pcmu.toString('base64'));
    for (const { socket } of f.providers.slice(1)) {
      socket.open();
      socket.receive({
        type: 'session.updated',
        session: socket.sent[0].session,
      });
    }
    await tick();
    f.media('local', local, pcmu);
    const nativeAppends = native.sent.filter(
      (event) => event.type === 'session.input_audio_buffer.append',
    );
    assert.equal(nativeAppends.length, 1);
    assert.ok(Buffer.from(nativeAppends[0].audio, 'base64').length > 0);
    if (outgoingCaptions) {
      const localAsr = f.providers[1].socket;
      const sourceAppends = localAsr.sent.filter(
        (event) => event.type === 'input_audio_buffer.append',
      );
      assert.equal(sourceAppends.length, 1);
      assert.equal(sourceAppends[0].audio, nativeAppends[0].audio);
    }
    native.receive({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(960).toString('base64'),
    });
    assert.ok(remote.sent.some((event) => event.event === 'media'));

    await f.manager.end(f.call.id);
    assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
    assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
    assert.equal(f.manager.activeSession, null);
    for (const socket of [
      local,
      remote,
      ...f.providers.map((entry) => entry.socket),
    ]) {
      assert.equal(socket.readyState, WebSocket.CLOSED);
    }
    for (const socket of [local, remote]) {
      assert.equal(
        socket.sent.filter((event) => event.event === 'clear').length,
        1,
      );
    }
    const ledger = f.persisted();
    assert.equal(ledger.intents[0].local.phase, 'terminal');
    assert.equal(ledger.intents[0].remote.phase, 'terminal');
    assert.equal(ledger.intents[0].usage, 'pending');
    assert.equal(ledger.chargedUsdMicros, 5000000);
    await f.manager.end(f.call.id);
    assert.equal(f.hungup.length, 2);
  });
}
