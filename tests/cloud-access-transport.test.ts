import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import {
  setImmediate as tick,
  setTimeout as delay,
} from 'node:timers/promises';
import { test as nodeTest, type TestContext } from 'node:test';
import fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';

import {
  CLOUD_SESSION_COOKIE,
  CloudAccessPolicy,
  type CloudAccessContext,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import {
  CLOUD_BROWSER_WS_MAX_PAYLOAD,
  createCloudAccessTransport,
  type CloudBrowserMessage,
  type CloudHttpScope,
} from '../src/solo/cloud-access-transport';

const test = (name: string, fn: (t: TestContext) => Promise<void>) =>
  nodeTest(name, { timeout: 5000 }, fn);

const origin = 'https://phone.example.test';
const tokenA = Buffer.alloc(32, 1).toString('base64url');
const tokenB = Buffer.alloc(32, 2).toString('base64url');
const tokenA2 = Buffer.alloc(32, 3).toString('base64url');
const csrf = Buffer.alloc(32, 4).toString('base64url');
const callA = 'call-a';
const callB = 'call-b';
function session(id: string, owner: string): CloudAuthSession {
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
/** Only tests implement identity. The source adapter has no mock/default login. */
class MemoryMockIdentity {
  sessions = new Map([
    [tokenA, session('auth-a', 'owner-a')],
    [tokenB, session('auth-b', 'owner-b')],
    [tokenA2, session('auth-a2', 'owner-a')],
  ]);

  now = 1000;
  failure = false;
  resolve = (token: string) => {
    if (this.failure) throw new Error('private-resolver-secret');
    const current = this.sessions.get(token);
    return current ? { ...current } : null;
  };
}
const headersFor = (token = tokenA) => ({
  host: 'phone.example.test',
  origin,
  cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
  'x-phone-csrf': csrf,
});
// Matches the same-origin Fetch/EventSource GET headers captured by Chromium.
// Metadata is source evidence only; it never replaces the current session cookie.
const chromeReadHeaders = (token = tokenA) => ({
  host: 'phone.example.test',
  cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
});
function assertPrivateHeaders(
  headers: Record<string, unknown>,
  existing?: string,
) {
  assert.equal(headers['cache-control'], 'private, no-store');
  const vary = String(headers.vary).toLowerCase().split(/,\s*/);
  for (const field of [
    'origin',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'cookie',
    ...(existing ? [existing.toLowerCase()] : []),
  ])
    assert.ok(vary.includes(field), `Vary includes ${field}`);
  assert.equal(vary.length, new Set(vary).size);
}
const params = (request: FastifyRequest) =>
  request.params as { callId: string };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(
  t: TestContext,
  options: {
    maxSockets?: number;
    maxSocketsPerSession?: number;
    onMessage?: (
      message: CloudBrowserMessage,
      context: CloudAccessContext,
    ) => void;
  } = {},
) {
  const identity = new MemoryMockIdentity();
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    resolveSession: identity.resolve,
    now: () => identity.now,
  });
  for (const [token, callId] of [
    [tokenA, callA],
    [tokenB, callB],
  ] as const)
    policy.registerCall(
      policy.authenticate(headersFor(token), 'mutate'),
      callId,
    );
  const transport = createCloudAccessTransport(policy, options);
  const backend = {
    read: t.mock.fn((context: CloudAccessContext, callId: string) => ({
      callId,
      owner: context.browserOwnerId,
      privateText: 'owner-private-subtitle',
    })),
    mutate: t.mock.fn((context: CloudAccessContext, callId: string) => ({
      callId,
      owner: context.browserOwnerId,
      changed: true,
    })),
    message: t.mock.fn(
      (_message: CloudBrowserMessage, _context: CloudAccessContext) =>
        undefined,
    ),
  };
  const preparation = deferred();
  const prepared = deferred();
  const responseReady = deferred();
  const releaseResponse = deferred();
  const streams: Readable[] = [];
  const channels = new Map<
    string,
    ReturnType<typeof transport.bindBrowserSocket>
  >();
  const app = fastify({ logger: false, bodyLimit: 16 * 1024 });
  await app.register(websocket, {
    options: { maxPayload: CLOUD_BROWSER_WS_MAX_PAYLOAD },
  });
  const readScope = (request: FastifyRequest): CloudHttpScope => ({
    callId: params(request).callId,
    action: 'read',
  });
  const writeScope = (request: FastifyRequest): CloudHttpScope => ({
    callId: params(request).callId,
    action: 'mutate',
  });
  app.get(
    '/fixture/calls/:callId',
    transport.httpRoute(readScope),
    (request, reply) => {
      reply.header('vary', 'Accept');
      // The final response boundary must keep private results out of caches even
      // if a handler supplied a weaker header after its authentication hook.
      reply.header('cache-control', 'public, max-age=60');
      return transport.executeHttp(request, (context) =>
        backend.read(context, params(request).callId),
      );
    },
  );
  for (const action of ['audio', 'transcript'] as const) {
    app.get(
      `/fixture/${action}/:callId`,
      transport.httpRoute((request) => ({
        callId: params(request).callId,
        action,
      })),
      (request) =>
        transport.executeHttp(request, (context) =>
          backend.read(context, params(request).callId),
        ),
    );
  }
  app.get(
    '/fixture/unsafe/:callId',
    transport.httpRoute(writeScope),
    (request) =>
      transport.executeHttp(request, (context) =>
        backend.mutate(context, params(request).callId),
      ),
  );
  app.post('/fixture/read/:callId', transport.httpRoute(readScope), (request) =>
    transport.executeHttp(request, (context) =>
      backend.read(context, params(request).callId),
    ),
  );
  app.post(
    '/fixture/calls/:callId',
    transport.httpRoute(writeScope),
    (request) =>
      transport.executeHttp(request, (context) =>
        backend.mutate(context, params(request).callId),
      ),
  );
  app.post(
    '/fixture/prepared/:callId',
    transport.httpRoute(writeScope),
    async (request) => {
      prepared.resolve();
      await preparation.promise;
      return transport.executeHttp(request, (context) =>
        backend.mutate(context, params(request).callId),
      );
    },
  );
  app.get(
    '/fixture/response/:callId',
    transport.httpRoute(readScope),
    async (request) => {
      const result = await transport.executeHttp(request, (context) =>
        backend.read(context, params(request).callId),
      );
      responseReady.resolve();
      await releaseResponse.promise;
      return result;
    },
  );
  app.get('/fixture/stream/:callId', transport.httpRoute(readScope), () => {
    const stream = Readable.from(['stream-private-subtitle']);
    streams.push(stream);
    return stream;
  });
  app.get('/fixture/error/:callId', transport.httpRoute(readScope), (request) =>
    transport.executeHttp(request, () => {
      throw new Error('private-backend-secret');
    }),
  );
  const wsOptions = {
    websocket: true as const,
    preHandler: transport.browserSocketGuard(
      (request) => params(request).callId,
    ),
  };
  app.get('/fixture/browser/:callId', wsOptions, (socket, request) => {
    const channel = transport.bindBrowserSocket(socket, request, {
      onMessage:
        options.onMessage ||
        ((message, context) => {
          backend.message(message, context);
        }),
      revalidationIntervalMs: 10,
    });
    channels.set(params(request).callId, channel);
  });
  app.get('/voice/browser/:callId', wsOptions, (socket, request) => {
    transport.bindBrowserSocket(socket, request, {
      onMessage: () => undefined,
    });
  });
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });
  async function open(
    callId = callA,
    headers: Record<string, string> = headersFor(),
    path = '/fixture/browser',
  ) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}/${callId}`, {
      headers,
      handshakeTimeout: 2000,
    });
    socket.on('error', () => undefined);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return socket;
  }
  return {
    app,
    policy,
    transport,
    identity,
    backend,
    open,
    channels,
    preparation,
    prepared,
    responseReady,
    releaseResponse,
    streams,
  };
}
async function closed(socket: WebSocket) {
  if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close');
  assert.equal(socket.readyState, WebSocket.CLOSED);
}

// Fastify injection exercises the shipped hook chain and backend boundary.
test('HTTP exact source and current identity are required before reading or mutating a call', async (t) => {
  const f = await fixture(t);
  const good = await f.app.inject({
    url: `/fixture/calls/${callA}`,
    headers: headersFor(),
  });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().owner, 'owner-a');
  assertPrivateHeaders(good.headers, 'Accept');
  const changed = await f.app.inject({
    method: 'POST',
    url: `/fixture/calls/${callA}`,
    headers: headersFor(),
    payload: { ownerId: 'owner-b', principalId: 'forged' },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().owner, 'owner-a');
  const reads = f.backend.read.mock.callCount();
  const writes = f.backend.mutate.mock.callCount();
  for (const headers of [
    { ...headersFor(), origin: 'https://evil.test' },
    { ...headersFor(), origin: 'null' },
    { ...headersFor(), origin: undefined },
    { ...headersFor(), host: 'evil.test' },
    { ...headersFor(), cookie: undefined },
    {
      ...headersFor(),
      cookie: `${CLOUD_SESSION_COOKIE}=${tokenA}; ${CLOUD_SESSION_COOKIE}=${tokenB}`,
    },
    { ...headersFor(), 'x-forwarded-host': 'phone.example.test' },
  ]) {
    const result = await f.app.inject({
      url: `/fixture/calls/${callA}`,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([, value]) => value !== undefined),
      ),
    });
    assert.ok([401, 403].includes(result.statusCode));
    assert.ok(!result.body.includes('owner-private-subtitle'));
    assertPrivateHeaders(result.headers);
  }
  for (const token of ['', 'wrong']) {
    const result = await f.app.inject({
      method: 'POST',
      url: `/fixture/calls/${callA}`,
      headers: { ...headersFor(), 'x-phone-csrf': token },
    });
    assert.equal(result.statusCode, 403);
  }
  assert.equal(f.backend.read.mock.callCount(), reads);
  assert.equal(f.backend.mutate.mock.callCount(), writes);
});

test('HTTP Chrome-style no-Origin GET and HEAD read only their current owner call with private cache headers', async (t) => {
  const f = await fixture(t);
  for (const [token, callId, owner] of [
    [tokenA, callA, 'owner-a'],
    [tokenB, callB, 'owner-b'],
  ] as const) {
    for (const path of ['calls', 'audio', 'transcript']) {
      for (const mode of ['cors', 'same-origin']) {
        for (const method of ['GET', 'HEAD'] as const) {
          const response = await f.app.inject({
            method,
            url: `/fixture/${path}/${callId}`,
            headers: { ...chromeReadHeaders(token), 'sec-fetch-mode': mode },
          });
          assert.equal(response.statusCode, 200);
          assertPrivateHeaders(
            response.headers,
            path === 'calls' ? 'Accept' : undefined,
          );
          if (method === 'GET') assert.equal(response.json().owner, owner);
          else assert.equal(response.body, '');
          assert.equal(
            f.backend.read.mock.calls.at(-1)!.arguments[0].browserOwnerId,
            owner,
          );
        }
      }
    }
  }
  assert.equal(f.backend.read.mock.callCount(), 24);
  assert.equal(f.backend.mutate.mock.callCount(), 0);
});

test('HTTP no-Origin metadata cannot replace identity or disclose another session call', async (t) => {
  const f = await fixture(t);
  for (const path of ['calls', 'audio', 'transcript']) {
    for (const [token, target] of [
      [tokenA, callB],
      [tokenB, callA],
      [tokenA2, callA],
      [tokenA, 'missing-call'],
    ] as const) {
      const response = await f.app.inject({
        url: `/fixture/${path}/${target}`,
        headers: chromeReadHeaders(token),
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: 'NOT_FOUND' });
      assertPrivateHeaders(response.headers);
    }
    const { cookie: _cookie, ...forgedMetadata } = chromeReadHeaders();
    const anonymous = await f.app.inject({
      url: `/fixture/${path}/${callA}`,
      headers: forgedMetadata,
    });
    assert.equal(anonymous.statusCode, 401);
    assertPrivateHeaders(anonymous.headers);
  }
  f.identity.sessions.get(tokenA)!.revoked = true;
  assert.equal(
    (
      await f.app.inject({
        url: `/fixture/transcript/${callA}`,
        headers: chromeReadHeaders(),
      })
    ).statusCode,
    401,
  );
  assert.equal(f.backend.read.mock.callCount(), 0);
  assert.equal(f.backend.mutate.mock.callCount(), 0);
});

test('HTTP source fallback never authorizes writes, method spoofing, wrong Origin or invalid metadata', async (t) => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD'] as const) {
    for (const headers of [
      headersFor(),
      { ...chromeReadHeaders(), 'x-phone-csrf': csrf },
    ]) {
      const response = await f.app.inject({
        method,
        url: `/fixture/unsafe/${callA}?method=POST&surface=browser-ws`,
        headers,
      });
      assert.equal(response.statusCode, 403);
      assertPrivateHeaders(response.headers);
    }
  }
  for (const path of ['calls', 'read']) {
    const response = await f.app.inject({
      method: 'POST',
      url: `/fixture/${path}/${callA}?method=GET&surface=http&action=read`,
      headers: { ...chromeReadHeaders(), 'x-phone-csrf': csrf },
      payload: {
        source: { surface: 'http', method: 'GET' },
        ownerId: 'owner-b',
      },
    });
    assert.equal(response.statusCode, 403);
    assertPrivateHeaders(response.headers);
  }
  const postRead = await f.app.inject({
    method: 'POST',
    url: `/fixture/read/${callA}`,
    headers: headersFor(),
  });
  assert.equal(postRead.statusCode, 403);
  for (const changes of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'none' },
    { 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-mode': 'no-cors' },
    { 'sec-fetch-mode': 'websocket' },
    { 'sec-fetch-dest': 'document' },
    { 'sec-fetch-dest': '' },
    { origin: 'null' },
    { origin: 'https://evil.test' },
  ]) {
    for (const includeOrigin of [false, true]) {
      const response = await f.app.inject({
        url: `/fixture/calls/${callA}`,
        headers: {
          ...chromeReadHeaders(),
          ...(includeOrigin ? { origin } : {}),
          ...changes,
        },
      });
      assert.equal(response.statusCode, 403);
      assertPrivateHeaders(response.headers);
    }
  }
  for (const omit of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) {
    const headers: Record<string, string> = { ...chromeReadHeaders(), origin };
    delete headers[omit];
    assert.equal(
      (await f.app.inject({ url: `/fixture/calls/${callA}`, headers }))
        .statusCode,
      403,
    );
  }
  assert.equal(f.backend.read.mock.callCount(), 0);
  assert.equal(f.backend.mutate.mock.callCount(), 0);
});

test('HTTP foreign and unknown calls share 404, including another login for the same owner', async (t) => {
  const f = await fixture(t);
  for (const [token, callId] of [
    [tokenA, callB],
    [tokenB, callA],
    [tokenA2, callA],
    [tokenA, 'missing-call'],
  ]) {
    for (const method of ['GET', 'POST'] as const) {
      const response = await f.app.inject({
        method,
        url: `/fixture/calls/${callId}`,
        headers: headersFor(token),
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: 'NOT_FOUND' });
    }
  }
  assert.equal(f.backend.read.mock.callCount(), 0);
  assert.equal(f.backend.mutate.mock.callCount(), 0);
});

test('HTTP expiry, revocation and resolver failures reject without backend calls or private error text', async (t) => {
  const f = await fixture(t);
  f.identity.now = 50000;
  assert.equal(
    (
      await f.app.inject({
        url: `/fixture/calls/${callA}`,
        headers: headersFor(),
      })
    ).statusCode,
    401,
  );
  f.identity.now = 1000;
  f.identity.sessions.get(tokenA)!.revoked = true;
  assert.equal(
    (
      await f.app.inject({
        url: `/fixture/calls/${callA}`,
        headers: headersFor(),
      })
    ).statusCode,
    401,
  );
  f.identity.sessions.get(tokenA)!.revoked = false;
  f.identity.failure = true;
  const failure = await f.app.inject({
    url: `/fixture/calls/${callA}`,
    headers: headersFor(),
  });
  assert.equal(failure.statusCode, 401);
  assert.ok(!failure.body.includes('private-resolver-secret'));
  assert.equal(f.backend.read.mock.callCount(), 0);
});

test('HTTP async preparation cannot commit after authentication is revoked', async (t) => {
  const f = await fixture(t);
  const response = f.app.inject({
    method: 'POST',
    url: `/fixture/prepared/${callA}`,
    headers: headersFor(),
  });
  await f.prepared.promise;
  f.identity.sessions.get(tokenA)!.revoked = true;
  f.preparation.resolve();
  const result = await response;
  assert.equal(result.statusCode, 401);
  assert.equal(f.backend.mutate.mock.callCount(), 0);
});

test('HTTP response authorization suppresses prepared subtitles after revocation', async (t) => {
  const f = await fixture(t);
  const response = f.app.inject({
    url: `/fixture/response/${callA}`,
    headers: headersFor(),
  });
  await f.responseReady.promise;
  f.identity.sessions.get(tokenA)!.revoked = true;
  f.releaseResponse.resolve();
  const result = await response;
  assert.equal(
    f.backend.read.mock.callCount(),
    1,
    'the initial read happened while authorized',
  );
  assert.equal(result.statusCode, 401);
  assert.ok(!result.body.includes('owner-private-subtitle'));
});

test('HTTP boundary rejects streaming responses rather than claiming per-chunk authorization', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    url: `/fixture/stream/${callA}`,
    headers: headersFor(),
  });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes('stream-private-subtitle'));
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].destroyed, true);
});

test('HTTP backend commit exceptions are sanitized through the actual Fastify response', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    url: `/fixture/error/${callA}`,
    headers: headersFor(),
  });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes('private-backend-secret'));
  assert.match(response.body, /CLOUD_ACCESS_UNAVAILABLE/);
});

test('real Node HTTP rejects raw duplicate Host and Fetch Metadata before any backend read', async (t) => {
  const f = await fixture(t);
  const address = f.app.server.address();
  assert.ok(address && typeof address !== 'string');
  for (const duplicate of [
    'Host: evil.test',
    'Sec-Fetch-Site: same-origin',
    'Sec-Fetch-Mode: cors',
    'Sec-Fetch-Dest: empty',
    'Sec-Fetch-User: ?1\r\nSec-Fetch-User: ?1',
  ]) {
    const socket = connect({ host: '127.0.0.1', port: address.port });
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    const completed = once(socket, 'end');
    socket.write(
      `GET /fixture/calls/${callA} HTTP/1.1\r\nHost: phone.example.test\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\n${duplicate}\r\nCookie: ${CLOUD_SESSION_COOKIE}=${tokenA}\r\nConnection: close\r\n\r\n`,
    );
    await completed;
    assert.match(response, /^HTTP\/1\.1 403/);
    assert.match(response, /cache-control: private, no-store/i);
  }
  assert.equal(f.backend.read.mock.callCount(), 0);
});

// Real ws clients connect only to an ephemeral loopback fixture, never a provider.
test('browser WS rejects missing source/identity, foreign call and Twilio-path cookie upgrades', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { host: 'phone.example.test', origin },
    { ...headersFor(), origin: 'https://evil.test' },
    { ...headersFor(), origin: 'null' },
    { host: 'phone.example.test', cookie: headersFor().cookie },
    chromeReadHeaders(),
    { ...chromeReadHeaders(), 'sec-fetch-mode': 'websocket' },
    { ...chromeReadHeaders(), origin },
    {
      ...chromeReadHeaders(),
      origin,
      'sec-fetch-mode': 'websocket',
      'sec-fetch-site': 'cross-site',
    },
  ])
    await assert.rejects(f.open(callA, headers), /401|403/);
  await assert.rejects(f.open(callB), /404/);
  await assert.rejects(f.open(callA, headersFor(tokenA2)), /404/);
  await assert.rejects(f.open(callA, headersFor(), '/voice/browser'), /403/);
  assert.equal(f.backend.message.mock.callCount(), 0);
  assert.equal(f.channels.size, 0);
});

test('browser WS also rejects expired or revoked sessions at upgrade', async (t) => {
  const f = await fixture(t);
  f.identity.now = 50000;
  await assert.rejects(f.open(), /401/);
  f.identity.now = 1000;
  f.identity.sessions.get(tokenA)!.revoked = true;
  await assert.rejects(f.open(), /401/);
  assert.equal(f.channels.size, 0);
  assert.equal(f.backend.message.mock.callCount(), 0);
});

test('browser WS cannot switch its bound call, including another own call', async (t) => {
  const f = await fixture(t);
  f.policy.registerCall(
    f.policy.authenticate(headersFor(), 'mutate'),
    'another-owned-call',
  );
  for (const target of [callB, 'another-owned-call']) {
    const socket = await f.open();
    socket.send(
      JSON.stringify({
        callId: target,
        action: 'audio-write',
        csrfToken: csrf,
        payload: 'AA==',
      }),
    );
    await closed(socket);
  }
  assert.equal(f.backend.message.mock.callCount(), 0);
});

test('browser WS authorized mutation uses message CSRF and ignores payload identity claims', async (t) => {
  const f = await fixture(t);
  const headers = headersFor();
  delete (headers as Partial<typeof headers>)['x-phone-csrf'];
  const socket = await f.open(callA, headers);
  socket.send(
    JSON.stringify({
      callId: callA,
      action: 'audio-write',
      csrfToken: csrf,
      payload: { ownerId: 'owner-b', audio: 'AA==' },
    }),
  );
  await tick();
  await tick();
  assert.equal(f.backend.message.mock.callCount(), 1);
  assert.equal(
    f.backend.message.mock.calls[0].arguments[1].browserOwnerId,
    'owner-a',
  );
  socket.send(
    JSON.stringify({
      callId: callA,
      action: 'mutate',
      csrfToken: 'wrong',
      payload: {},
    }),
  );
  await closed(socket);
  assert.equal(f.backend.message.mock.callCount(), 1);
});

test('browser WS permits authorized read frames without a CSRF field', async (t) => {
  const f = await fixture(t);
  const headers = {
    ...chromeReadHeaders(),
    origin,
    'sec-fetch-mode': 'websocket',
  };
  const socket = await f.open(callA, headers);
  socket.send(JSON.stringify({ callId: callA, action: 'read' }));
  await tick();
  await tick();
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(f.backend.message.mock.callCount(), 1);
  socket.close();
  await closed(socket);
});

test('browser WS takeover remains denied for its authenticated owner', async (t) => {
  const f = await fixture(t);
  const socket = await f.open();
  socket.send(
    JSON.stringify({ callId: callA, action: 'takeover', csrfToken: csrf }),
  );
  await closed(socket);
  assert.equal(f.backend.message.mock.callCount(), 0);
});

test('browser WS sends owner audio/subtitles, then closes and blocks both after revocation', async (t) => {
  const f = await fixture(t);
  const socket = await f.open();
  const received: string[] = [];
  socket.on('message', (data) => received.push(data.toString()));
  const channel = f.channels.get(callA)!;
  const audioReceived = once(socket, 'message');
  assert.equal(
    await channel.send({ callId: callA, kind: 'audio', payload: 'AA==' }),
    true,
  );
  await audioReceived;
  const transcriptReceived = once(socket, 'message');
  assert.equal(
    await channel.send({
      callId: callA,
      kind: 'transcript',
      payload: 'owner subtitle',
    }),
    true,
  );
  await transcriptReceived;
  assert.equal(received.length, 2);
  f.identity.sessions.get(tokenA)!.revoked = true;
  assert.equal(
    await channel.send({
      callId: callA,
      kind: 'audio',
      payload: 'must not leave',
    }),
    false,
  );
  assert.equal(
    await channel.send({
      callId: callA,
      kind: 'transcript',
      payload: 'must not leave',
    }),
    false,
  );
  await closed(socket);
  assert.equal(received.length, 2);
});

test('browser WS outgoing events for a different call never expose audio or subtitle payload', async (t) => {
  const f = await fixture(t);
  for (const kind of ['audio', 'transcript'] as const) {
    const socket = await f.open();
    const received: string[] = [];
    socket.on('message', (data) => received.push(data.toString()));
    assert.equal(
      await f.channels
        .get(callA)!
        .send({ callId: callB, kind, payload: 'foreign payload' }),
      false,
    );
    await closed(socket);
    assert.deepEqual(received, []);
  }
});

test('browser WS expiry or changed login epoch rejects incoming messages, and idle revocation closes it', async (t) => {
  const f = await fixture(t);
  let socket = await f.open();
  f.identity.now = 50000;
  socket.send(
    JSON.stringify({
      callId: callA,
      action: 'audio-write',
      csrfToken: csrf,
      payload: 'AA==',
    }),
  );
  await closed(socket);
  f.identity.now = 1000;
  socket = await f.open();
  f.identity.sessions.get(tokenA)!.epoch += 1;
  socket.send(JSON.stringify({ callId: callA, action: 'read' }));
  await closed(socket);
  assert.equal(f.backend.message.mock.callCount(), 0);
  f.identity.sessions.get(tokenA)!.epoch = 1;
  socket = await f.open();
  f.identity.sessions.get(tokenA)!.revoked = true;
  await closed(socket);
  assert.equal(f.backend.message.mock.callCount(), 0);
});

test('browser WS queued send rechecks identity after another task revokes the session', async (t) => {
  const f = await fixture(t);
  const socket = await f.open();
  const received: string[] = [];
  socket.on('message', (data) => received.push(data.toString()));
  const sent = f.channels
    .get(callA)!
    .send({ callId: callA, kind: 'audio', payload: 'queued but revoked' });
  f.identity.sessions.get(tokenA)!.revoked = true;
  assert.equal(await sent, false);
  await closed(socket);
  assert.deepEqual(received, []);
});

test('browser WS per-session/global caps reject upgrade and release capacity on close', async (t) => {
  const f = await fixture(t, { maxSockets: 2, maxSocketsPerSession: 1 });
  const first = await f.open();
  await assert.rejects(f.open(), /403/);
  const second = await f.open(callB, headersFor(tokenB));
  f.policy.registerCall(
    f.policy.authenticate(headersFor(tokenA2), 'mutate'),
    'call-a2',
  );
  await assert.rejects(f.open('call-a2', headersFor(tokenA2)), /403/);
  first.close();
  await closed(first);
  const replacement = await f.open('call-a2', headersFor(tokenA2));
  replacement.close();
  second.close();
  await Promise.all([closed(replacement), closed(second)]);
});

test('browser WS refuses oversized frames and declared async dispatch callbacks', async (t) => {
  const f = await fixture(t);
  const socket = await f.open();
  socket.send('x'.repeat(16 * 1024 + 1));
  await closed(socket);
  assert.equal(f.backend.message.mock.callCount(), 0);
  let invoked = false;
  const other = await fixture(t, {
    onMessage: async () => {
      invoked = true;
      throw new Error('private-async-secret');
    },
  });
  const rejected = await other.open();
  await closed(rejected);
  assert.equal(invoked, false);
  await delay(10);
});

test('browser WS consumes a noncompliant callback promise and closes without an unhandled rejection', async (t) => {
  const f = await fixture(t, {
    onMessage: () => Promise.reject(new Error('private-callback-secret')),
  });
  const socket = await f.open();
  socket.send(JSON.stringify({ callId: callA, action: 'read' }));
  await closed(socket);
  await delay(10);
});
