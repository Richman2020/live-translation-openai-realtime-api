/* eslint-disable max-classes-per-file, no-await-in-loop -- The offline owner fixture has independent phone/model peers and ordered lifecycle cases. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import fastify from 'fastify';

import {
  CLOUD_SESSION_COOKIE,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import { createCloudAccessTransport } from '../src/solo/cloud-access-transport';
import {
  createOwnedPhoneEventStreams,
  type OwnedPhoneStreamAccess,
} from '../src/solo/phone-event-stream';
import { setImmediate as tick } from 'node:timers/promises';
import WebSocket from 'ws';

import {
  createLiveTranslateClient,
  LIVE_TRANSLATE_MODEL,
  type LiveTranslateClientOptions,
  type LiveTranslateRole,
} from '../src/experiments/livetranslate-client';
import { createPersonalVoiceAdmission } from '../src/solo/cloud-service';
import type { CloudVoiceReservation } from '../src/solo/cloud-voice-join';
import type { SoloConfig } from '../src/solo/config';
import { createLiveTranslatePhoneBridge } from '../src/solo/livetranslate-phone-bridge';
import {
  SessionManager,
  type BridgeOptions,
  type Role,
} from '../src/solo/session-manager';

// This is a synthetic negative-protocol lifecycle test, NOT the captured
// 2026-10-16 phone event stream. It deliberately creates a genuine output-item
// ownership conflict through the real LiveTranslate client, not by calling its
// onError callback. Supplier/phone peers and auth session are offline fakes.
// The manager/bridge/client, access policy/transport and SSE writer are real.
// The small OwnedPhoneStreamAccess projection below is an injected owner port;
// this does not exercise Google login or the full CloudPhoneAccess composition.
// Fictional NANP 555 numbers and fake credentials, never actual user data.
// Authentication here is the trusted explicit personal-admission port; it does
// not claim that a synthetic browser identity has passed real Google login.
const configuration = {
  PUBLIC_BASE_URL: 'https://offline.example.com',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'UNUSED_OPENAI_OFFLINE_KEY',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
} as SoloConfig;
const target = '+14155550123';
const identity = 'offline_authenticated_owner';
const localSid = `CA${'1'.repeat(32)}`;
const remoteSid = `CA${'2'.repeat(32)}`;
const streams = { local: `MZ${'3'.repeat(32)}`, remote: `MZ${'4'.repeat(32)}` };

class Phone extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  closed = 0;

  send(raw: string, callback?: () => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (event.event === 'mark') this.receive(event);
  }

  receive(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  media(role: Role, pcmu: Buffer) {
    this.receive({
      event: 'media',
      streamSid: streams[role],
      media: {
        track: 'inbound',
        timestamp: '20',
        payload: pcmu.toString('base64'),
      },
    });
  }

  audio() {
    return Buffer.concat(
      this.sent
        .filter((event) => event.event === 'media')
        .map((event) => Buffer.from(event.media.payload, 'base64')),
    );
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', 1000);
  }

  terminate() {
    this.close();
  }

  socket() {
    return this as unknown as WebSocket;
  }
}

class Model extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  bufferedAmount = 0;

  sent: any[] = [];

  closed = 0;

  sequence = 0;

  constructor(readonly options: LiveTranslateClientOptions) {
    super();
  }

  session() {
    const { role, voice } = this.options;
    return {
      id: `offline-model-${role}`,
      model: LIVE_TRANSLATE_MODEL,
      voice,
      enable_voice_clone: false,
      output_modalities: role === 'local' ? ['text', 'audio'] : ['text'],
      translation: { language: role === 'local' ? 'en' : 'zh' },
      audio: {
        input: {
          format: { type: 'pcm', sample_rate: 16000 },
          turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        },
        output: { format: { type: 'pcm', sample_rate: 24000 }, voice },
      },
    };
  }

  receive(event: object) {
    this.sequence += 1;
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event_id: `${this.options.role}-${this.sequence}`,
          ...event,
        }),
      ),
      false,
    );
  }

  send(raw: string, callback?: () => void) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    callback?.();
    if (event.type === 'session.update')
      queueMicrotask(() =>
        this.receive({ type: 'session.updated', session: this.session() }),
      );
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closed += 1;
    this.emit('close', 1000);
  }

  terminate() {
    this.close();
  }

  inputCount() {
    return this.sent.filter(
      (event) => event.type === 'input_audio_buffer.append',
    ).length;
  }
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await tick();
}

async function fixture(t: TestContext) {
  let now = 100000;
  let authorized = true;
  let occupancy: CloudVoiceReservation | undefined;
  let settings!: BridgeOptions;
  const events: any[] = [];
  const protocol: any[] = [];
  const created: any[] = [];
  const hungup: string[] = [];
  const models = new Map<LiveTranslateRole, Model>();
  const local = new Phone();
  const remote = new Phone();
  const manager = new SessionManager({
    maxCallMs: null,
    allowedTarget: target,
    now: () => now,
    providerFactory: () => ({
      async create(args) {
        created.push(args);
        return { sid: remoteSid };
      },
      async hangup(sid) {
        hungup.push(sid);
      },
      async limit() {
        assert.fail(
          'No application duration or budget cap may be reintroduced',
        );
      },
    }),
    bridgeFactory(options) {
      settings = options;
      return createLiveTranslatePhoneBridge(
        {
          ...options,
          remoteCaptions: true,
          outgoingCaptions: false,
          createWebSocket() {
            throw new Error('OpenAI transport must not be created');
          },
        },
        {
          config: {
            region: 'beijing',
            workspaceId: 'offline-owner-workspace',
            apiKey: 'OFFLINE_FAKE_ALIYUN_KEY',
            model: LIVE_TRANSLATE_MODEL,
            voice: 'Andre',
          },
          deps: {
            createClient(optionsForModel) {
              assert.equal(
                models.has(optionsForModel.role),
                false,
                'No replacement model sessions',
              );
              const model = new Model(optionsForModel);
              models.set(optionsForModel.role, model);
              const client = createLiveTranslateClient({
                ...optionsForModel,
                onProtocolDiagnostic(event) {
                  protocol.push(event);
                  optionsForModel.onProtocolDiagnostic?.(event);
                },
                createWebSocket(address) {
                  assert.equal(
                    address,
                    'wss://offline-owner-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
                  );
                  return model as unknown as WebSocket;
                },
              });
              queueMicrotask(() =>
                model.receive({
                  type: 'session.created',
                  session: model.session(),
                }),
              );
              return client;
            },
          },
        },
      );
    },
  });
  manager.on('event', (event) => events.push(event));
  manager.setPresence(true);
  const admission = (browserIdentity = identity) => ({
    browserIdentity,
    deferBrowserJoin: true as const,
    beforePublish() {},
    authorizeCurrent() {
      if (!authorized) throw new Error('OFFLINE_OWNER_AUTH_REVOKED');
    },
    authorizeBrowserJoin(fields: Record<string, string>) {
      assert.equal(fields.From, `client:${identity}`);
      assert.equal(fields.CallSid, localSid);
      occupancy!.assertCurrent();
      return 'join' as const;
    },
  });
  const call = manager.createOutbound(
    configuration,
    target,
    'continuous-captions',
    admission(),
  );
  occupancy = await createPersonalVoiceAdmission(manager).reserve({
    version: 1,
    callId: call.id,
    identity,
    authSessionId: 'offline_auth_session',
    principalId: 'offline_principal',
    browserOwnerId: 'offline_owner',
    authEpoch: 1,
    controller: {
      leaseId: 'offline_lease',
      tabId: 'offline_owner_tab',
      epoch: 1,
    },
    issuedAt: now,
    expiresAt: now + 60000,
    authExpiresAt: now + 60000,
    tokenExpiresAt: now + 60000,
    incomingAllow: false,
    outgoingApplicationSid: `AP${'a'.repeat(32)}`,
    outgoing: { callId: call.id, identity },
  });
  await manager.connectBrowserControlled({
    ...call.connectionParams,
    From: `client:${identity}`,
    CallSid: localSid,
  });
  const attach = (
    role: Role,
    socket: Phone,
    changes: Record<string, unknown> = {},
    parameterChanges: Record<string, unknown> = {},
  ) => {
    const nonce =
      role === 'local'
        ? call.connectionParams.nonce
        : new URL(String(created[0].url)).searchParams.get('nonce')!;
    return manager.attachMedia(socket.socket(), {
      accountSid: configuration.TWILIO_ACCOUNT_SID,
      callSid: role === 'local' ? localSid : remoteSid,
      streamSid: streams[role],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      ...changes,
      customParameters: {
        sessionId: call.id,
        role,
        nonce,
        ...parameterChanges,
      },
    });
  };
  assert.equal(attach('local', local), true);
  await flush();
  assert.equal(created.length, 1);
  const remoteNonce = new URL(String(created[0].url)).searchParams.get(
    'nonce',
  )!;
  manager.connectLeg(call.id, 'remote', remoteNonce, remoteSid);
  assert.equal(attach('remote', remote), true);
  await flush();
  assert.equal(manager.activeSession?.status, 'active');
  assert.equal(models.size, 2);
  t.after(async () => {
    authorized = true;
    await manager.close();
    await manager.close();
  });
  return {
    manager,
    call,
    protocol,
    settings,
    events,
    created,
    hungup,
    models,
    local,
    remote,
  };
}

/** Wait for a frame boundary, never a fixed sleep intended to hide a race. */
async function ownerStream(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const token = Buffer.alloc(32, 7).toString('base64url');
  const auth: CloudAuthSession = {
    authSessionId: 'synthetic-auth',
    principalId: 'synthetic-principal',
    browserOwnerId: 'synthetic-owner',
    epoch: 1,
    issuedAt: 1,
    absoluteExpiresAt: 999999,
    idleExpiresAt: 999999,
    revoked: false,
    csrfToken: Buffer.alloc(32, 8).toString('base64url'),
  };
  const origin = configuration.PUBLIC_BASE_URL;
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    resolveSession: (candidate) => (candidate === token ? auth : undefined),
    now: () => 100000,
  });
  const headers = {
    host: 'offline.example.com',
    cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
  const context = policy.authenticate(
    { ...headers, origin, 'x-phone-csrf': auth.csrfToken },
    'mutate',
    { surface: 'http', method: 'POST' },
  );
  policy.registerCall(context, f.call.id);
  const access: OwnedPhoneStreamAccess = {
    policy,
    ownedActive(current) {
      policy.authorizeCall(current, f.call.id, 'read');
      return f.manager.activeSession;
    },
    runAuthorizedEvent(current, event, commit) {
      if (
        !['call', 'caption-status'].includes(event.event) ||
        !event.data ||
        typeof event.data !== 'object'
      )
        return false;
      const id = Object.getOwnPropertyDescriptor(
        event.data,
        event.event === 'call' ? 'id' : 'sessionId',
      )?.value;
      if (id !== f.call.id) return false;
      policy.runAuthorizedCall(current, id, 'read', commit);
      return true;
    },
  };
  const transport = createCloudAccessTransport(policy);
  const stream = createOwnedPhoneEventStreams({
    access,
    transport,
    manager: f.manager,
  });
  const app = fastify({ logger: false });
  app.get('/api/events', { preHandler: stream.guard }, stream.handler);
  app.get('/api/browser-session', { preHandler: stream.guard }, (request) => ({
    activeSession: access.ownedActive(transport.requestContext(request)),
  }));
  const responses: IncomingMessage[] = [];
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as import('node:net').AddressInfo;
  t.after(async () => {
    stream.close();
    responses.forEach((reply) => reply.destroy());
    await app.close();
  });
  async function read() {
    return new Promise<{
      frames: any[];
      next: (predicate: (frame: any) => boolean) => Promise<any>;
      close: () => void;
    }>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: '/api/events', headers },
        (response) => {
          responses.push(response);
          assert.equal(response.statusCode, 200);
          response.setEncoding('utf8');
          const frames: any[] = [];
          const waiting = new Set<{
            predicate: (frame: any) => boolean;
            resolve: (frame: any) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
          }>();
          let pending = '';
          response.on('data', (part) => {
            pending += part;
            for (
              let end = pending.indexOf('\n\n');
              end >= 0;
              end = pending.indexOf('\n\n')
            ) {
              const raw = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (!raw.startsWith('event: ')) continue;
              const [event, data] = raw.split('\n');
              const frame = {
                event: event.slice(7),
                data: JSON.parse(data.slice(6)),
              };
              frames.push(frame);
              for (const wait of waiting)
                if (wait.predicate(frame)) {
                  clearTimeout(wait.timer);
                  waiting.delete(wait);
                  wait.resolve(frame);
                }
            }
          });
          response.on('error', () => {});
          response.once('close', () => {
            for (const wait of waiting) {
              clearTimeout(wait.timer);
              wait.reject(
                new Error('Synthetic SSE closed before requested frame'),
              );
            }
            waiting.clear();
          });
          resolve({
            frames,
            close: () => response.destroy(),
            next(predicate) {
              const previous = frames.find(predicate);
              if (previous) return Promise.resolve(previous);
              return new Promise((yes, no) => {
                const wait = {
                  predicate,
                  resolve: yes,
                  reject: no,
                  timer: undefined as unknown as ReturnType<typeof setTimeout>,
                };
                wait.timer = setTimeout(() => {
                  waiting.delete(wait);
                  no(new Error('Synthetic SSE frame boundary timeout'));
                }, 2000);
                waiting.add(wait);
              });
            },
          });
        },
      );
      request.once('error', reject);
      request.end();
    });
  }
  return {
    read,
    refresh: async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/browser-session',
        headers,
      });
      assert.equal(response.statusCode, 200);
      return response.json().activeSession;
    },
  };
}

for (const failedRole of ['local', 'remote'] as const) {
  test(
    `synthetic real ${failedRole} client item conflict reaches owner SSE without ending phone; refresh, late events and manual end stay safe`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const server = await ownerStream(t, f);
      const reader = await server.read();
      const before = await reader.next((frame) => frame.event === 'snapshot');
      assert.equal(before.data.activeSession.status, 'active');
      assert.notEqual(before.data.activeSession.translationStopped, true);
      const model = f.models.get(failedRole)!;
      const sourceId = 'synthetic-source';
      const outputId = 'synthetic-shared-output';
      const response1 = 'synthetic-response-one';
      const response2 = 'synthetic-response-two';
      model.receive({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: sourceId,
        content_index: 0,
        transcript:
          failedRole === 'local'
            ? '不要取消，改为十五。'
            : 'Do not cancel. Change it to fifteen.',
      });
      model.receive({
        type: 'conversation.item.created',
        previous_item_id: sourceId,
        item: { id: outputId, role: 'assistant', content: [] },
      });
      model.receive({
        type: 'response.created',
        response: { id: response1, status: 'in_progress' },
      });
      const deltaType =
        failedRole === 'local'
          ? 'response.audio_transcript.delta'
          : 'response.text.delta';
      const firstDelta = {
        type: deltaType,
        item_id: outputId,
        response_id: response1,
        output_index: 0,
        content_index: 0,
        delta:
          failedRole === 'local'
            ? 'Do not cancel. Change it to fifteen.'
            : '不要取消，改为十五。',
      };
      model.receive(firstDelta);
      if (failedRole === 'local')
        model.receive({
          type: 'response.audio.delta',
          item_id: outputId,
          response_id: response1,
          output_index: 0,
          content_index: 0,
          delta: Buffer.alloc(4800, 1).toString('base64'),
        });
      await flush();
      assert.equal(
        f.protocol.some((event) => event.fatal),
        false,
      );
      model.receive({
        type: 'response.created',
        response: { id: response2, status: 'in_progress' },
      });
      // A single output item cannot belong to two simultaneously live responses.
      // This differs from legitimate input bookkeeping with an assistant role
      // and predecessor; sharing an actual source/output identity is still fatal.
      const conflict = {
        ...firstDelta,
        response_id: response2,
        event_id: 'synthetic-conflict-event',
      };
      model.receive(conflict);
      await flush();
      const fatal = f.protocol.filter((event) => event.fatal);
      assert.equal(fatal.length, 1);
      assert.equal(fatal[0].code, 'LIVETRANSLATE_ITEM_CONFLICT');
      const status = await reader.next(
        (frame) =>
          frame.event === 'call' && frame.data.translationStopped === true,
      );
      const caption = await reader.next(
        (frame) =>
          frame.event === 'caption-status' &&
          frame.data.translationStopped === true,
      );
      assert.equal(status.data.id, f.call.id);
      assert.equal(status.data.status, 'active');
      assert.equal(status.data.translationReady, false);
      assert.equal(caption.data.sessionId, f.call.id);
      assert.equal(caption.data.state, 'failed');
      assert.equal(f.manager.hasEndIntent(f.call.id), false);
      assert.deepEqual(f.hungup, []);
      assert.equal(f.local.closed, 0);
      assert.equal(f.remote.closed, 0);
      assert([...f.models.values()].every((supplier) => supplier.closed === 1));
      const refreshed = await server.refresh();
      assert.equal(refreshed.translationStopped, true);
      assert.equal(refreshed.status, 'active');
      const reconnected = await server.read();
      const snapshot = await reconnected.next(
        (frame) => frame.event === 'snapshot',
      );
      assert.equal(snapshot.data.activeSession.translationStopped, true);
      const inputs = [...f.models.values()].map((supplier) =>
        supplier.inputCount(),
      );
      const stoppedAudioBytes = f.remote.audio().length;
      const originalBytes = f.local.audio().length;
      const eventsAtStop = f.events.length;
      model.receive(conflict);
      model.receive(firstDelta);
      for (const supplier of f.models.values()) {
        supplier.receive({
          type: 'response.created',
          response: { id: 'synthetic-late', status: 'in_progress' },
        });
      }
      f.local.media('local', Buffer.alloc(160, 0xff));
      const original = Buffer.from([0x91, 0x10, 0xff]);
      f.remote.media('remote', original);
      await flush();
      assert.deepEqual(
        [...f.models.values()].map((supplier) => supplier.inputCount()),
        inputs,
      );
      assert.equal(f.remote.audio().length, stoppedAudioBytes);
      assert.deepEqual(f.local.audio().subarray(originalBytes), original);
      assert.equal(f.models.size, 2);
      assert.equal(f.created.length, 1);
      assert.equal(
        f.events.filter(
          (event) =>
            event.event === 'translation-live' && event.data.stage === 'failed',
        ).length,
        1,
      );
      assert.equal(
        f.events
          .slice(eventsAtStop)
          .some((event) => event.event === 'conversation'),
        false,
      );
      await f.manager.end(f.call.id);
      await flush();
      assert.deepEqual(new Set(f.hungup), new Set([localSid, remoteSid]));
      assert.equal(f.hungup.length, 2);
      assert.equal(f.manager.activeSession, null);
      assert.equal(f.manager.isCleanupConfirmed(f.call.id), true);
      assert.equal(f.local.closed, 1);
      assert.equal(f.remote.closed, 1);
      assert([...f.models.values()].every((supplier) => supplier.closed === 1));
      const endedBytes = [f.local.audio().length, f.remote.audio().length];
      model.receive(conflict);
      f.local.media('local', Buffer.alloc(160));
      f.remote.media('remote', Buffer.alloc(160));
      await flush();
      assert.deepEqual(
        [f.local.audio().length, f.remote.audio().length],
        endedBytes,
      );
      assert.equal(f.hungup.length, 2);
      reader.close();
      reconnected.close();
    },
  );
}
