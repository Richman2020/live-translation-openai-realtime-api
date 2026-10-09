import assert from 'node:assert/strict';
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import fastify from 'fastify';

import {
  CLOUD_SESSION_COOKIE,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import { createCloudAccessTransport } from '../src/solo/cloud-access-transport';
import { CloudPhoneAccess } from '../src/solo/cloud-phone-access';
import type { SoloConfig } from '../src/solo/config';
import { createOwnedPhoneEventStreams } from '../src/solo/phone-event-stream';
import { SessionManager } from '../src/solo/session-manager';

const origin = 'https://phone.example.test';
const tokenA = Buffer.alloc(32, 1).toString('base64url');
const tokenB = Buffer.alloc(32, 2).toString('base64url');
const tokenA2 = Buffer.alloc(32, 3).toString('base64url');
const csrf = Buffer.alloc(32, 4).toString('base64url');
const config = {
  PUBLIC_BASE_URL: origin,
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_CALLER_NUMBER: '+12125550123',
  OPENAI_API_KEY: 'synthetic-no-api',
  OPENAI_REALTIME_MODEL: 'synthetic-no-model',
  OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
} as SoloConfig;
function auth(id: string, owner: string): CloudAuthSession {
  return {
    authSessionId: id,
    principalId: 'same-account',
    browserOwnerId: owner,
    epoch: 1,
    issuedAt: 100,
    absoluteExpiresAt: 100000,
    idleExpiresAt: 50000,
    revoked: false,
    csrfToken: csrf,
  };
}
async function eventually(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await delay(5);
  }
  assert.fail(message);
}
async function fixture(
  t: TestContext,
  streamOptions: {
    maxStreams?: number;
    maxStreamsPerSession?: number;
    maxFrameBytes?: number;
    maxBufferedBytes?: number;
    revalidationIntervalMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
) {
  // Identity and readiness exist only in this offline fixture. Provider seams
  // throw if invoked: these tests never connect a browser leg or a phone.
  const sessions = new Map([
    [tokenA, auth('auth-a', 'owner-a')],
    [tokenB, auth('auth-b', 'owner-b')],
    [tokenA2, auth('auth-a2', 'owner-a')],
  ]);
  let now = 1000;
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    resolveSession: (token) => sessions.get(token),
    now: () => now,
  });
  const manager = new SessionManager({
    now: () => now,
    providerFactory: () => ({
      create: async () => {
        throw new Error('NO_PROVIDER_CALL');
      },
      hangup: async () => {
        throw new Error('NO_PROVIDER_CALL');
      },
    }),
    bridgeFactory: () => {
      throw new Error('NO_MODEL_OR_MEDIA');
    },
  });
  const access = new CloudPhoneAccess({
    policy,
    manager,
    publicReadinessChecker: async () => ({
      status: 'ready',
      code: 'PUBLIC_CALLBACK_READY',
    }),
    translationReadinessChecker: async () => {
      throw new Error('NO_MODEL_CHECK');
    },
  });
  const transport = createCloudAccessTransport(policy);
  const streams = createOwnedPhoneEventStreams({
    access,
    transport,
    manager,
    ...streamOptions,
  });
  const app = fastify({ logger: false });
  const outputs: IncomingMessage[] = [];
  const rawOutputs: ServerResponse[] = [];
  app.addHook('onRequest', async (_request, reply) => {
    rawOutputs.push(reply.raw);
  });
  app.get('/api/events', { preHandler: streams.guard }, streams.handler);
  app.addHook('preClose', async () => streams.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    streams.close();
    for (const response of outputs) response.destroy();
    access.close();
    await manager.close();
    await app.close();
  });
  const port = (app.server.address() as import('node:net').AddressInfo).port;
  const headers = (token: string) => ({
    host: 'phone.example.test',
    cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  });
  async function reader(
    token = tokenA,
    customHeaders: Record<string, string> = headers(token),
  ) {
    return new Promise<{
      response: IncomingMessage;
      frames: { event: string; data: any }[];
      comments: string[];
      body: () => string;
      closed: () => boolean;
    }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/events',
          headers: customHeaders,
        },
        (response) => {
          outputs.push(response);
          const frames: { event: string; data: any }[] = [];
          const comments: string[] = [];
          let body = '',
            partial = '',
            closed = false;
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
            partial += chunk;
            let boundary = partial.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = partial.slice(0, boundary);
              partial = partial.slice(boundary + 2);
              if (frame.startsWith(':')) comments.push(frame);
              else if (frame.startsWith('event: ')) {
                const [event, data] = frame.split('\n');
                frames.push({
                  event: event.slice(7),
                  data: JSON.parse(data.slice(6)),
                });
              }
              boundary = partial.indexOf('\n\n');
            }
          });
          response.on('end', () => {
            closed = true;
          });
          response.on('close', () => {
            closed = true;
          });
          response.on('error', () => {
            closed = true;
          });
          resolve({
            response,
            frames,
            comments,
            body: () => body,
            closed: () => closed,
          });
        },
      );
      request.once('error', reject);
      request.end();
    });
  }
  async function create(token = tokenA) {
    const context = policy.authenticate(
      { ...headers(token), origin, 'x-phone-csrf': csrf },
      'mutate',
      { surface: 'http', method: 'POST' },
    );
    manager.setPresence(true);
    return access.createPrepared(
      await access.prepareCreate(context, config, '+14155550123'),
    );
  }
  return {
    sessions,
    policy,
    manager,
    access,
    streams,
    app,
    outputs,
    rawOutputs,
    reader,
    create,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test(
  'owner SSE snapshot and late events remain scoped to immutable call ownership',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const a = await f.reader();
    await eventually(() => a.frames.length === 1, 'Initial snapshot missing');
    assert.deepEqual(a.frames[0], {
      event: 'snapshot',
      data: { activeSession: null },
    });
    assert.equal(a.response.headers['cache-control'], 'private, no-store');
    for (const field of [
      'origin',
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'cookie',
    ])
      assert.ok(
        String(a.response.headers.vary)
          .toLowerCase()
          .split(/,\s*/)
          .includes(field),
      );
    const callA = await f.create();
    await eventually(
      () => a.frames.some((event) => event.data?.id === callA.id),
      'Own call event missing',
    );
    await f.manager.end(callA.id);
    const callB = await f.create(tokenB);
    const b = await f.reader(tokenB);
    await eventually(() => b.frames.length === 1, 'Owner B snapshot missing');
    assert.equal(b.frames[0].data.activeSession.id, callB.id);
    const a2 = await f.reader(tokenA2);
    await eventually(
      () => a2.frames.length === 1,
      'Second login snapshot missing',
    );
    assert.equal(a2.frames[0].data.activeSession, null);
    let unauthorizedSerialization = 0;
    f.manager.emit('event', {
      event: 'unknown',
      data: {
        sessionId: callA.id,
        get text() {
          unauthorizedSerialization += 1;
          return 'hidden';
        },
      },
    });
    f.manager.emit('event', {
      event: 'transcript',
      data: {
        sessionId: 'unknown-call',
        get text() {
          unauthorizedSerialization += 1;
          return 'hidden';
        },
      },
    });
    f.manager.emit('event', {
      event: 'transcript',
      data: { text: 'missing-id' },
    });
    for (const event of ['conversation', 'caption-input', 'error'])
      f.manager.emit('event', {
        event,
        data: { sessionId: callA.id, marker: 'late-a-cancel-or-unconfirmed' },
      });
    f.manager.emit('event', {
      event: 'call',
      data: { ...callA, cleanupUnconfirmed: true },
    });
    f.manager.emit('event', {
      event: 'transcript',
      data: { sessionId: callB.id, marker: 'owner-b' },
    });
    await eventually(
      () =>
        a.frames.some(
          (event) => event.data?.marker === 'late-a-cancel-or-unconfirmed',
        ) && b.frames.some((event) => event.data?.marker === 'owner-b'),
      'Scoped events missing',
    );
    assert.equal(unauthorizedSerialization, 0);
    assert.equal(
      a.frames.some(
        (event) =>
          event.data?.id === callB.id || event.data?.sessionId === callB.id,
      ),
      false,
    );
    assert.equal(
      b.frames.some(
        (event) =>
          event.data?.id === callA.id || event.data?.sessionId === callA.id,
      ),
      false,
    );
    assert.equal(
      a2.frames.length,
      1,
      'Same owner field does not merge different logins',
    );
    assert.equal(
      a.closed(),
      false,
      'Foreign events must not close an authorized reader',
    );
  },
);

test(
  'owner SSE denies missing identity/source before headers and stops revoked or expired sessions',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { revalidationIntervalMs: 10 });
    const missingCookie = await f.reader(tokenA, {
      host: 'phone.example.test',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(missingCookie.response.statusCode, 401);
    assert.notEqual(
      missingCookie.response.headers['content-type'],
      'text/event-stream',
    );
    const wrongSource = await f.reader(tokenA, {
      host: 'phone.example.test',
      cookie: `${CLOUD_SESSION_COOKIE}=${tokenA}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(wrongSource.response.statusCode, 403);
    const a = await f.reader();
    const b = await f.reader(tokenB);
    await eventually(
      () => a.frames.length === 1 && b.frames.length === 1,
      'Snapshots missing',
    );
    f.sessions.get(tokenA)!.revoked = true;
    await eventually(
      a.closed,
      'Quiet revoked stream was not closed independently of heartbeat',
    );
    assert.equal(b.closed(), false);
    f.setNow(50000);
    await eventually(b.closed, 'Idle-expired stream was not closed');
    assert.equal(f.manager.listenerCount('event'), 0);
  },
);

test(
  'owner SSE performs fresh authorization after serialization and before every heartbeat',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { heartbeatIntervalMs: 20 });
    const a = await f.reader();
    const call = await f.create();
    await eventually(
      () => a.frames.some((event) => event.data?.id === call.id),
      'Call event missing',
    );
    await eventually(() => a.comments.length > 0, 'Heartbeat missing');
    const commentsBefore = a.comments.length;
    f.manager.emit('event', {
      event: 'transcript',
      data: {
        sessionId: call.id,
        get text() {
          f.sessions.get(tokenA)!.revoked = true;
          return 'must-not-cross-final-check';
        },
      },
    });
    await eventually(
      a.closed,
      'Serialization-time revocation did not close stream',
    );
    assert.equal(a.body().includes('must-not-cross-final-check'), false);
    await delay(30);
    assert.equal(a.comments.length, commentsBefore);
    assert.equal(f.manager.listenerCount('event'), 0);
  },
);

test(
  'owner SSE connection limits count exact sessions and release slots on disconnect and shutdown',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { maxStreams: 2, maxStreamsPerSession: 1 });
    const a = await f.reader();
    const deniedA = await f.reader();
    assert.equal(deniedA.response.statusCode, 429);
    const a2 = await f.reader(tokenA2);
    assert.equal(a2.response.statusCode, 200);
    const deniedB = await f.reader(tokenB);
    assert.equal(deniedB.response.statusCode, 429);
    a.response.destroy();
    await eventually(
      () => f.manager.listenerCount('event') === 1,
      'Disconnect did not unsubscribe/release slot',
    );
    const b = await f.reader(tokenB);
    assert.equal(b.response.statusCode, 200);
    const closing = f.app.close();
    await eventually(
      () => a2.closed() && b.closed(),
      'App preClose did not close streams',
    );
    await closing;
    assert.equal(f.manager.listenerCount('event'), 0);
  },
);

test(
  'owner SSE rejects oversized frames and projected slow-client buffering before write',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { maxFrameBytes: 512, maxBufferedBytes: 1024 });
    const a = await f.reader();
    const call = await f.create();
    await eventually(
      () => a.frames.some((event) => event.data?.id === call.id),
      'Call event missing',
    );
    f.manager.emit('event', {
      event: 'transcript',
      data: { sessionId: call.id, text: 'large'.repeat(200) },
    });
    await eventually(a.closed, 'Oversized frame was not rejected');
    assert.equal(a.body().includes('large'.repeat(200)), false);
    const next = await f.reader();
    await eventually(
      () => next.frames.length === 1,
      'Replacement stream snapshot missing',
    );
    const raw = f.rawOutputs.at(-1)!;
    Object.defineProperty(raw, 'writableLength', {
      configurable: true,
      get: () => 1000,
    });
    f.manager.emit('event', {
      event: 'transcript',
      data: { sessionId: call.id, text: 'buffered-do-not-write' },
    });
    await eventually(next.closed, 'Projected buffer overflow was not rejected');
    assert.equal(next.body().includes('buffered-do-not-write'), false);
    assert.equal(f.manager.listenerCount('event'), 0);
  },
);
