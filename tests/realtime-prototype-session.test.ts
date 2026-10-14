import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type WebSocket from 'ws';

import type { SoloConfig } from '../src/solo/config';
import { createRealtimePrototypeBridge } from '../src/solo/realtime-prototype';
import type { RealtimePrototypeClientOptions } from '../src/solo/realtime-prototype-client';
import { SessionManager } from '../src/solo/session-manager';

class PhoneSocket extends EventEmitter {
  readyState = 1;

  sent: any[] = [];

  send(value: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(value));
    callback?.();
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1000);
  }
}

const config = {
  PUBLIC_BASE_URL: 'https://offline.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'offline-fake',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
} as SoloConfig;
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;

async function fixture() {
  const hungUp: string[] = [];
  const events: any[] = [];
  let local!: RealtimePrototypeClientOptions;
  let aborted = 0;
  let captionAborted = 0;
  let socketAttempts = 0;
  let remoteNonce = '';
  const manager = new SessionManager({
    providerFactory: () => ({
      create: async (settings) => {
        remoteNonce = new URL(String(settings.url)).searchParams.get('nonce')!;
        return { sid: remoteSid };
      },
      hangup: async (sid) => {
        hungUp.push(sid);
      },
    }),
    bridgeFactory: (options) =>
      createRealtimePrototypeBridge(
        {
          ...options,
          // No supplier transport is permitted in this integration fixture.
          createWebSocket: () => {
            socketAttempts += 1;
            throw new Error('OFFLINE_TRANSPORT_FORBIDDEN');
          },
          createCaptionClient: () => ({
            ready: Promise.resolve(),
            append() {},
            finish: async () => {},
            abort: () => {
              captionAborted += 1;
            },
          }),
        },
        {
          enabled: true,
          voice: 'echo',
          createClient: (settings) => {
            local = settings;
            return {
              ready: Promise.resolve(),
              append() {},
              finish: async () => {},
              abort: () => {
                aborted += 1;
              },
              reconnect: async () => {},
              acknowledgeAudio: () => true,
              withdraw: () => false,
            };
          },
        },
      ),
  });
  manager.on('event', (event) => events.push(event));
  manager.setPresence(true);
  const call = manager.createOutbound(
    config,
    '+14155550123',
    'continuous-captions',
  );
  manager.connectBrowser({
    ...call.connectionParams,
    From: 'client:ai-phone',
    CallSid: localSid,
  });
  const attach = (role: 'local' | 'remote', socket: PhoneSocket) =>
    manager.attachMedia(socket as unknown as WebSocket, {
      customParameters: {
        ...call.connectionParams,
        role,
        nonce: role === 'local' ? call.connectionParams.nonce : remoteNonce,
      },
      accountSid: config.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: `MZ${(role === 'local' ? '3' : '4').repeat(32)}`,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    });
  const localPhone = new PhoneSocket();
  const remotePhone = new PhoneSocket();
  assert.equal(attach('local', localPhone), true);
  await tick();
  manager.connectLeg(call.id, 'remote', remoteNonce, remoteSid);
  assert.equal(attach('remote', remotePhone), true);
  await tick();
  assert.equal(local.voice, 'echo');
  return {
    manager,
    call,
    local,
    localPhone,
    remotePhone,
    hungUp,
    events,
    get aborted() {
      return aborted;
    },
    get captionAborted() {
      return captionAborted;
    },
    get socketAttempts() {
      return socketAttempts;
    },
  };
}

for (const cause of [
  'manual',
  'supplier-failure',
  'phone-disconnect',
] as const) {
  test(`prototype real SessionManager cleans both legs on ${cause} and fences late model output`, async (t) => {
    const f = await fixture();
    t.after(() => f.manager.close());
    f.local.onEvidence?.({
      type: 'source_committed',
      epoch: 1,
      sourceSequence: 1,
    });
    f.local.onConversationTranscript({
      id: 'local:original:prototype:1',
      utteranceId: 'local:prototype:1',
      role: 'local',
      kind: 'original',
      text: '这是离线输入。',
      final: true,
      at: 100,
      pairing: 'explicit',
      sourceRevision: 1,
      inputEpoch: 1,
      sourceSequence: 1,
    });
    assert.ok(f.events.some((event) => event.event === 'conversation'));
    if (cause === 'manual') await f.manager.end(f.call.id);
    else if (cause === 'supplier-failure')
      f.local.onError?.('PROTOTYPE_PROVIDER_DISCONNECTED');
    else f.localPhone.close();
    await tick();
    await tick();
    assert.deepEqual([...new Set(f.hungUp)].sort(), [localSid, remoteSid]);
    assert.ok(f.aborted >= 1);
    assert.ok(f.captionAborted >= 1);
    assert.equal(f.localPhone.readyState, 3);
    assert.equal(f.remotePhone.readyState, 3);
    const count = f.events.length;
    const localSent = f.localPhone.sent.length;
    const remoteSent = f.remotePhone.sent.length;
    f.local.onConversationTranscript({
      id: 'local:translation:prototype:1',
      utteranceId: 'local:prototype:1',
      role: 'local',
      kind: 'translation',
      text: 'Late generated output must stay silent.',
      final: true,
      at: 100,
      pairing: 'explicit',
      sourceRevision: 1,
      inputEpoch: 1,
      sourceSequence: 1,
    });
    f.local.onAudio(Buffer.alloc(4800), {
      utteranceId: 'local:prototype:1',
      responseId: 'late_response',
      epoch: 1,
      sourceSequence: 1,
    });
    f.local.onError?.('LATE_FAILURE');
    assert.equal(f.events.length, count);
    assert.equal(f.localPhone.sent.length, localSent);
    assert.equal(f.remotePhone.sent.length, remoteSent);
    assert.equal(f.socketAttempts, 0);
  });
}
