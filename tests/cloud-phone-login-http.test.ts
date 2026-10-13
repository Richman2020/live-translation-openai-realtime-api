import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import { test, type TestContext } from 'node:test';
import twilio from 'twilio';
import WebSocket from 'ws';
import { createControllerClient } from '../public/controller-client.js';

import { CLOUD_SESSION_COOKIE } from '../src/solo/cloud-access';
import { parseCloudServiceConfig } from '../src/solo/cloud-service-config';
import { createCloudService } from '../src/solo/cloud-service';
import { parseCloudWebWorkbenchConfig } from '../src/solo/cloud-web-verification-config';
import { createCloudWebWorkbenchService } from '../src/solo/cloud-web-verification-service';
import { GOOGLE_LOGIN_COOKIE } from '../src/solo/google-login';
import { GOOGLE_OIDC } from '../src/solo/google-oidc';
import type { BridgeOptions } from '../src/solo/session-manager';

const origin = 'https://phone.example.test';
const clientId = 'offline-http.apps.googleusercontent.com';
const email = 'owner@workspace.example.test';
const domain = 'workspace.example.test';
const subject = 'offline-http-subject';
const initialTime = 1_800_000_000_000;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'offline-http-key',
  alg: 'RS256',
  use: 'sig',
};
const readHeaders = (cookie?: string) => ({
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  ...(cookie ? { cookie } : {}),
});
const writeHeaders = (cookie?: string, csrf?: string) => ({
  ...readHeaders(cookie),
  origin,
  'x-phone-login': 'start',
  ...(csrf ? { 'x-phone-csrf': csrf } : {}),
});
const navigationHeaders = (site: string, cookie?: string) => ({
  'sec-fetch-site': site,
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  ...(cookie ? { cookie } : {}),
});
type HttpResult = {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
};
function httpCall(
  port: number,
  path: string,
  headers: Record<string, string> | string[] = {},
  method = 'GET',
  body?: Record<string, unknown> | string,
): Promise<HttpResult> {
  const encoded =
    typeof body === 'string'
      ? body
      : body === undefined
        ? undefined
        : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: Array.isArray(headers)
          ? {}
          : {
              host: new URL(origin).host,
              'x-forwarded-proto': 'https',
              ...(encoded === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(encoded)),
                  }),
              ...headers,
            },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    if (Array.isArray(headers)) {
      const values = new Map<string, string[]>();
      for (let index = 0; index < headers.length; index += 2) {
        const name = headers[index];
        const repeated = values.get(name) || [];
        repeated.push(headers[index + 1]);
        values.set(name, repeated);
      }
      for (const [name, repeated] of values)
        req.setHeader(name, repeated.length === 1 ? repeated[0] : repeated);
    }
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('offline HTTP timeout')));
    req.end(encoded);
  });
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function environment(port: number) {
  return {
    CLOUD_SERVICE_MODE: 'phone',
    AI_PHONE_RUNTIME_MODE: 'cloud',
    CLOUD_PUBLIC_CALLBACK_CONFIRMED: 'true',
    CLOUD_WARM_INSTANCES: '1',
    PORT: String(port),
    CLOUD_PUBLIC_ORIGIN: origin,
    PUBLIC_BASE_URL: origin,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: 'offline-http-not-a-secret',
    GOOGLE_ALLOWED_EMAIL: email,
    GOOGLE_HOSTED_DOMAIN: domain,
    GOOGLE_SUBJECT: subject,
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: '4'.repeat(32),
    TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'offline-http-not-a-secret-123456',
    TWILIO_TWIML_APP_SID: `AP${'3'.repeat(32)}`,
    TWILIO_CALLER_NUMBER: '+12025550100',
    OPENAI_API_KEY: 'sk-offline-http-not-a-real-key',
    CLOUD_TEST_TARGET_NUMBER: '+12025550101',
  };
}
async function fixture(
  t: TestContext,
  offlineVoice = false,
  allowFakeLeg = false,
) {
  // The production Twilio JWT signer uses the SDK's wall clock independently.
  let now = offlineVoice ? Date.now() : initialTime;
  const port = await unusedPort();
  const config = parseCloudServiceConfig(environment(port), initialTime);
  const calls = {
    provider: 0,
    bridge: 0,
    token: 0,
    jwks: 0,
    fakeCreates: 0,
    fakeHangups: [] as string[],
    fakeCreateRequests: [] as Record<string, unknown>[],
    fakeAttaches: [] as string[],
    fakeBridgeCloses: 0,
  };
  let bridgeSettings: BridgeOptions | undefined;
  const codes = new Map<string, string>();
  const exchanges: { code: string; verifier: string }[] = [];
  let codeId = 0;
  const service = await createCloudService(config, {
    now: () => (offlineVoice ? Date.now() : now),
    providerFactory: () => {
      calls.provider += 1;
      if (offlineVoice)
        return {
          create: async (options) => {
            calls.fakeCreates += 1;
            calls.fakeCreateRequests.push(options);
            return { sid: `CA${'7'.repeat(32)}` };
          },
          hangup: async (sid) => {
            calls.fakeHangups.push(sid);
          },
        };
      throw new Error('offline phone provider MUST NOT be created');
    },
    bridgeFactory: (settings) => {
      calls.bridge += 1;
      if (offlineVoice) {
        bridgeSettings = settings;
        return {
          attach(role) {
            calls.fakeAttaches.push(role);
          },
          close() {
            calls.fakeBridgeCloses += 1;
          },
        };
      }
      throw new Error('offline model bridge MUST NOT be opened');
    },
    // This explicit dependency is tests-only. It never performs network I/O.
    googleFetch: async (input, init) => {
      const url = String(input);
      if (url === GOOGLE_OIDC.jwksUri) {
        calls.jwks += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      assert.equal(url, GOOGLE_OIDC.tokenEndpoint);
      calls.token += 1;
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('client_id'), clientId);
      assert.equal(
        params.get('redirect_uri'),
        `${origin}/auth/google/callback`,
      );
      const code = params.get('code')!;
      assert.ok(
        codes.has(code),
        'Only codes issued by this offline flow exist',
      );
      exchanges.push({ code, verifier: params.get('code_verifier')! });
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: GOOGLE_OIDC.issuer,
          sub: subject,
          aud: clientId,
          iat: Math.floor(now / 1000),
          exp: Math.floor(now / 1000) + 300,
          nonce: codes.get(code),
          email,
          email_verified: true,
          hd: domain,
        }),
      ).toString('base64url');
      const data = `${header}.${payload}`;
      const jwt = `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
      return new Response(
        JSON.stringify({
          id_token: jwt,
          access_token: 'offline-unused-token',
          token_type: 'Bearer',
          expires_in: 300,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  t.after(async () => {
    await service.close();
    if (!offlineVoice) {
      assert.equal(calls.provider, 0);
      assert.equal(calls.bridge, 0);
    }
    if (allowFakeLeg)
      assert.ok(
        calls.fakeCreates <= 1,
        'Only one explicit fake remote leg is permitted',
      );
    else
      assert.equal(
        calls.fakeCreates,
        0,
        'No real or fake PSTN leg is created by this callback-only fixture',
      );
  });
  const read = (path: string, cookie?: string) =>
    httpCall(port, path, readHeaders(cookie));
  const write = (
    path: string,
    cookie?: string,
    csrf?: string,
    body: Record<string, unknown> = {},
  ) => httpCall(port, path, writeHeaders(cookie, csrf), 'POST', body);
  const start = async (cookie?: string) => {
    const result = await write('/auth/google/start', cookie);
    assert.equal(result.status, 200, result.body);
    const url = new URL(JSON.parse(result.body).authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      `${origin}/auth/google/callback`,
    );
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const flow = {
      cookie: result.headers['set-cookie']![0].split(';')[0],
      state: url.searchParams.get('state')!,
      nonce: url.searchParams.get('nonce')!,
      challenge: url.searchParams.get('code_challenge')!,
      code: `offline-http-code-${++codeId}`,
    };
    assert.ok(flow.cookie.startsWith(`${GOOGLE_LOGIN_COOKIE}=`));
    codes.set(flow.code, flow.nonce);
    return flow;
  };
  type Flow = Awaited<ReturnType<typeof start>>;
  const callback = (flow: Flow, extra = '', cookie = flow.cookie) =>
    httpCall(
      port,
      `/auth/google/callback?state=${flow.state}&code=${flow.code}${extra}`,
      navigationHeaders('cross-site', cookie),
    );
  const signIn = async (cookie?: string) => {
    const flow = await start(cookie);
    const result = await callback(
      flow,
      `&iss=${encodeURIComponent(GOOGLE_OIDC.issuer)}`,
    );
    assert.equal(result.status, 200, result.body);
    const sessionHeader = result.headers['set-cookie']!.find((value) =>
      value.startsWith(`${CLOUD_SESSION_COOKIE}=`),
    )!;
    assert.ok(sessionHeader);
    const session = sessionHeader.split(';')[0];
    const current = await read('/api/browser-session', session);
    assert.equal(current.status, 200, current.body);
    return {
      flow,
      result,
      sessionHeader,
      session,
      csrf: JSON.parse(current.body).csrfToken as string,
    };
  };
  return {
    port,
    service,
    config,
    calls,
    exchanges,
    read,
    write,
    start,
    callback,
    signIn,
    readyBridge: (role: 'local' | 'remote') => {
      assert.ok(
        allowFakeLeg,
        'Only full-chain fixtures can simulate supplier readiness',
      );
      assert.ok(bridgeSettings);
      bridgeSettings.onConnection?.({ role, state: 'ready' });
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function browserVoiceFlow(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  transportHeaders: Record<string, string> = {},
) {
  const login = await f.signIn();
  let prepared: any;
  const client = createControllerClient({
    randomTabId: () => 'offline-chain-tab',
    fetchImpl: async (path: string, options: any) => {
      const result = await httpCall(
        f.port,
        path,
        {
          ...readHeaders(login.session),
          ...(options.method === 'POST' ? { origin } : {}),
          ...options.headers,
        },
        options.method,
        options.body,
      );
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => JSON.parse(result.body),
      };
    },
  });
  t.after(() => client.dispose());
  await client.boot();
  client.setConnectionState(true);
  await client.dial('+12025550101', {
    connectVoice: async (voice: any) => {
      prepared = voice;
      return { disconnect() {} };
    },
  });
  const localSid = `CA${'5'.repeat(32)}`;
  const fields = {
    AccountSid: f.config.providers.TWILIO_ACCOUNT_SID,
    ApplicationSid: f.config.providers.TWILIO_TWIML_APP_SID,
    CallSid: localSid,
    From: `client:${prepared.grant.identity}`,
    ...prepared.params,
  };
  const signed = async (
    url: string,
    body: Record<string, string>,
    extra: Record<string, string> = {},
  ) => {
    const target = new URL(url);
    return httpCall(
      f.port,
      target.pathname + target.search,
      {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          f.config.providers.TWILIO_AUTH_TOKEN,
          url,
          body,
        ),
        ...extra,
      },
      'POST',
      new URLSearchParams(body).toString(),
    );
  };
  const joined = await signed(
    `${origin}/voice/client`,
    fields,
    transportHeaders,
  );
  assert.equal(joined.status, 200, joined.body);
  const streamStatus = joined.body
    .match(/statusCallback="([^"]+)"/)![1]
    .replaceAll('&amp;', '&');
  return {
    client,
    login,
    prepared,
    localSid,
    fields,
    signed,
    joined,
    streamStatus,
    callId: client.state.call!.id,
  };
}

function openMedia(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  headers: Record<string, string> = {},
  path = '/voice/media',
) {
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}${path}`, {
    headers: {
      host: new URL(origin).host,
      'x-forwarded-proto': 'https',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(
        f.config.providers.TWILIO_AUTH_TOKEN,
        `${origin}/voice/media`,
        {},
      ),
      ...headers,
    },
  });
  socket.on('error', () => {});
  t.after(() => socket.terminate());
  return new Promise<{ status: number; socket: WebSocket }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('offline media handshake timeout'));
      }, 3000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve({ status: 101, socket });
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        response.resume();
        resolve({ status: response.statusCode!, socket });
        socket.terminate();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    },
  );
}

const voiceTransportHeaders = {
  duplicate: { accept: ['application/xml', '*/*'] as unknown as string },
  proxy: {
    forwarded: 'for="192.0.2.42:443";proto=https;host=internal-proxy',
    'x-forwarded-for': '192.0.2.42:443, unknown',
    'x-forwarded-host': 'internal-proxy',
    'x-forwarded-proto': 'https, http',
  },
};

for (const [transport, headers] of Object.entries(voiceTransportHeaders)) {
  test(`production callback chain accepts ${transport} headers on generated signed stream-status URL`, async (t) => {
    const f = await fixture(t, true);
    const flow = await browserVoiceFlow(t, f);
    const result = await flow.signed(
      flow.streamStatus,
      {
        AccountSid: f.config.providers.TWILIO_ACCOUNT_SID,
        CallSid: flow.localSid,
        StreamEvent: 'stream-started',
      },
      headers,
    );
    assert.equal(result.status, 204, result.body);
  });
  test(`production callback chain accepts ${transport} headers on actual signed public media upgrade`, async (t) => {
    const f = await fixture(t, true);
    const flow = await browserVoiceFlow(t, f);
    assert.match(flow.joined.body, /<Connect><Stream/);
    const media = await openMedia(t, f, headers);
    assert.equal(media.status, 101);
    media.socket.close();
  });
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `offline timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function streamCallback(twiml: string) {
  return twiml.match(/statusCallback="([^"]+)"/)![1].replaceAll('&amp;', '&');
}
function mediaStart(
  callId: string,
  sid: string,
  role: 'local' | 'remote',
  nonce: string,
) {
  return {
    accountSid: `AC${'1'.repeat(32)}`,
    callSid: sid,
    streamSid: `MZ${(role === 'local' ? '3' : '4').repeat(32)}`,
    customParameters: { sessionId: callId, role, nonce },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  };
}
async function fullVoiceChain(
  t: TestContext,
  headers: Record<string, string> = {},
) {
  const f = await fixture(t, true, true);
  const flow = await browserVoiceFlow(t, f, headers);
  const local = await openMedia(t, f, headers);
  assert.equal(local.status, 101);
  local.socket.send(
    JSON.stringify({
      event: 'start',
      start: mediaStart(
        flow.callId,
        flow.localSid,
        'local',
        flow.prepared.params.nonce,
      ),
    }),
  );
  await waitFor(
    () => f.calls.fakeAttaches.includes('local'),
    'local real ingress media reaches fake bridge',
  );
  assert.equal(
    f.calls.fakeCreates,
    0,
    'An attached local stream cannot dial before fake translation readiness',
  );
  f.readyBridge('local');
  f.readyBridge('local');
  await waitFor(
    () => f.calls.fakeCreates === 1,
    'one explicitly fake PSTN leg',
  );
  await new Promise((resolve) => setImmediate(resolve));
  const remote = f.calls.fakeCreateRequests[0];
  assert.equal(remote.method, 'POST');
  assert.equal(remote.statusCallbackMethod, 'POST');
  const connectUrl = new URL(String(remote.url));
  const statusUrl = new URL(String(remote.statusCallback));
  assert.equal(connectUrl.origin, origin);
  assert.equal(connectUrl.pathname, '/voice/connect');
  assert.equal(statusUrl.origin, origin);
  assert.equal(statusUrl.pathname, '/voice/status');
  for (const url of [connectUrl, statusUrl]) {
    assert.equal(url.searchParams.get('sessionId'), flow.callId);
    assert.equal(url.searchParams.get('role'), 'remote');
    assert.match(url.searchParams.get('nonce')!, /^[a-f0-9]{48}$/);
  }
  assert.equal(connectUrl.search, statusUrl.search);
  const remoteSid = `CA${'7'.repeat(32)}`;
  const remoteFields = {
    AccountSid: f.config.providers.TWILIO_ACCOUNT_SID,
    CallSid: remoteSid,
    CallStatus: 'ringing',
  };
  const connected = await flow.signed(connectUrl.href, remoteFields, headers);
  assert.equal(connected.status, 200, connected.body);
  assert.match(connected.body, /<Connect><Stream/);
  const remoteStreamStatus = streamCallback(connected.body);
  assert.equal(new URL(remoteStreamStatus).search, connectUrl.search);
  const ringing = await flow.signed(statusUrl.href, remoteFields, headers);
  assert.equal(ringing.status, 204, ringing.body);
  const remoteMedia = await openMedia(t, f, headers);
  assert.equal(remoteMedia.status, 101);
  remoteMedia.socket.send(
    JSON.stringify({
      event: 'start',
      start: mediaStart(
        flow.callId,
        remoteSid,
        'remote',
        connectUrl.searchParams.get('nonce')!,
      ),
    }),
  );
  await waitFor(
    () =>
      f.calls.fakeAttaches.includes('remote') &&
      f.service.manager.activeSession?.status === 'active',
    'both real media tunnels establish the fake two-leg call',
  );
  f.readyBridge('remote');
  assert.equal(f.calls.fakeCreates, 1);
  assert.equal(f.calls.bridge, 1);
  assert.equal(f.service.manager.activeSession?.translationReady, true);
  return {
    f,
    flow,
    local,
    remoteMedia,
    remoteSid,
    remoteFields,
    connectUrl,
    statusUrl,
    remoteStreamStatus,
  };
}
async function finishVoiceChain(
  chain: Awaited<ReturnType<typeof fullVoiceChain>>,
) {
  const { f, flow, local, remoteMedia, remoteSid } = chain;
  const closed = [local.socket, remoteMedia.socket].map(
    (socket) =>
      new Promise<void>((resolve) => socket.once('close', () => resolve())),
  );
  await flow.client.cancel({ releaseControl: false });
  await Promise.all(closed);
  assert.equal(f.service.manager.isCleanupConfirmed(flow.callId), true);
  assert.equal(f.service.manager.activeSession, null);
  assert.deepEqual(
    [...f.calls.fakeHangups].sort(),
    [flow.localSid, remoteSid].sort(),
  );
  assert.equal(f.calls.fakeBridgeCloses, 1);
  assert.equal(f.calls.fakeCreates, 1);
  const repeated = await f.write(
    `/api/calls/${flow.callId}/hangup`,
    flow.login.session,
    flow.login.csrf,
    { controller: flow.prepared.grant.controller },
  );
  assert.equal(repeated.status, 200, repeated.body);
  assert.equal(
    f.calls.fakeHangups.length,
    2,
    'Repeated authenticated hangup cannot clear either leg twice',
  );
}
for (const [transport, headers] of Object.entries(voiceTransportHeaders)) {
  test(`production full callback chain and both media legs accept ${transport} transport and clean both fake legs`, async (t) => {
    const chain = await fullVoiceChain(t, headers);
    const { flow, connectUrl, statusUrl, remoteStreamStatus, remoteFields, f } =
      chain;
    const callbacks = [
      [connectUrl.href, remoteFields, 200],
      [statusUrl.href, remoteFields, 204],
      [
        remoteStreamStatus,
        { ...remoteFields, StreamEvent: 'stream-started' },
        204,
      ],
      [
        flow.streamStatus,
        {
          ...remoteFields,
          CallSid: flow.localSid,
          StreamEvent: 'stream-started',
        },
        204,
      ],
    ] as const;
    for (const [url, fields, status] of callbacks) {
      const result = await flow.signed(url, fields, headers);
      assert.equal(
        result.status,
        status,
        `${new URL(url).pathname}: ${result.body}`,
      );
      if (status === 200) assert.match(result.body, /<Connect><Stream/);
    }
    assert.equal(f.calls.fakeCreates, 1);
    await finishVoiceChain(chain);
  });
}

test('production generated connect/status/stream-status callbacks preserve transport compatibility across the complete signed query', async (t) => {
  const chain = await fullVoiceChain(t);
  const { flow, connectUrl, statusUrl, remoteStreamStatus, remoteFields } =
    chain;
  const statuses: {
    route: string;
    transport: string;
    actual: number;
    expected: number;
  }[] = [];
  for (const [transport, headers] of Object.entries(voiceTransportHeaders)) {
    for (const [url, fields, expected] of [
      [connectUrl.href, remoteFields, 200],
      [statusUrl.href, remoteFields, 204],
      [
        remoteStreamStatus,
        { ...remoteFields, StreamEvent: 'stream-started' },
        204,
      ],
    ] as const) {
      const result = await flow.signed(url, fields, headers);
      statuses.push({
        route: new URL(url).pathname,
        transport,
        actual: result.status,
        expected,
      });
    }
  }
  t.diagnostic(JSON.stringify({ callbackTransportStatuses: statuses }));
  assert.ok(statuses.every((result) => result.actual === result.expected));
  await finishVoiceChain(chain);
});

function rawWire(
  port: number,
  path: string,
  method: string,
  headers: string[],
  body = '',
) {
  return new Promise<{ status: number; raw: string }>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let received = '',
      settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(received)?.[1]),
        raw: received,
      });
    };
    socket.setTimeout(3000, () =>
      socket.destroy(new Error('offline raw callback timeout')),
    );
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (
        received.startsWith('HTTP/1.1 101 ') &&
        received.includes('\r\n\r\n')
      ) {
        finish();
        socket.destroy();
      }
    });
    socket.on('end', finish);
    socket.on('connect', () =>
      socket.end(
        `${method} ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body}`,
      ),
    );
  });
}

test('production query callbacks reject forged HMAC, changed full URLs, account/nonce/SID mismatches and critical duplicate headers', async (t) => {
  const chain = await fullVoiceChain(t);
  const { f, flow, connectUrl, statusUrl, remoteStreamStatus, remoteFields } =
    chain;
  for (const url of [connectUrl.href, statusUrl.href, remoteStreamStatus]) {
    const target = new URL(url);
    const fields = { ...remoteFields, StreamEvent: 'stream-started' };
    const encoded = new URLSearchParams(fields).toString();
    const signature = twilio.getExpectedTwilioSignature(
      f.config.providers.TWILIO_AUTH_TOKEN,
      url,
      fields,
    );
    const changed = new URL(url);
    changed.searchParams.set('nonce', 'wrong-nonce');
    for (const [label, requestUrl, extra] of [
      ['forged', url, { 'x-twilio-signature': 'offline-forged-signature' }],
      [
        'signature excludes query',
        url,
        {
          'x-twilio-signature': twilio.getExpectedTwilioSignature(
            f.config.providers.TWILIO_AUTH_TOKEN,
            target.origin + target.pathname,
            fields,
          ),
        },
      ],
      [
        'signature for other public Host',
        url,
        {
          'x-twilio-signature': twilio.getExpectedTwilioSignature(
            f.config.providers.TWILIO_AUTH_TOKEN,
            'https://other.example.test' + target.pathname + target.search,
            fields,
          ),
        },
      ],
      [
        'query changed after signing',
        changed.href,
        { 'x-twilio-signature': signature },
      ],
      ['wrong ingress Host', url, { host: 'other.example.test' }],
      [
        'duplicate signature',
        url,
        { 'x-twilio-signature': [signature, signature] as unknown as string },
      ],
    ] as const) {
      const result = await flow.signed(requestUrl, fields, extra);
      assert.equal(
        result.status,
        403,
        `${target.pathname} ${label}: ${result.body}`,
      );
    }
    for (const [label, requestUrl, changedFields] of [
      [
        'signed wrong account',
        url,
        { ...fields, AccountSid: `AC${'8'.repeat(32)}` },
      ],
      ['signed wrong nonce', changed.href, fields],
      ['signed wrong SID', url, { ...fields, CallSid: `CA${'6'.repeat(32)}` }],
    ] as const) {
      const result = await flow.signed(requestUrl, changedFields);
      assert.equal(
        result.status,
        403,
        `${target.pathname} ${label}: ${result.body}`,
      );
    }
    for (const name of [
      'content-type',
      'connection',
      'origin',
      'authorization',
      'x-phone-csrf',
      'sec-fetch-site',
    ]) {
      const result = await flow.signed(url, fields, {
        [name]: ['offline-one', 'offline-two'] as unknown as string,
      });
      assert.equal(result.status, 403, `${target.pathname} duplicate ${name}`);
    }
    const wireHeaders = [
      `Host: ${new URL(origin).host}`,
      'Content-Type: application/x-www-form-urlencoded',
      `X-Twilio-Signature: ${signature}`,
      `Content-Length: ${Buffer.byteLength(encoded)}`,
      'Connection: close',
    ];
    for (const [extra, expected] of [
      [['Cookie: offline=1', 'Cookie: offline=1'], 403],
      [[`Host: ${new URL(origin).host}`], 403],
      [[`Content-Length: ${Buffer.byteLength(encoded)}`], 400],
    ] as const) {
      const result = await rawWire(
        f.port,
        target.pathname + target.search,
        'POST',
        [...wireHeaders, ...extra],
        encoded,
      );
      assert.equal(
        result.status,
        expected,
        `${target.pathname} wire-level security/framing duplicate`,
      );
    }
  }
  const incoming = await flow.signed(
    `${origin}/voice/incoming`,
    remoteFields,
    voiceTransportHeaders.proxy,
  );
  assert.equal(incoming.status, 404);
  await finishVoiceChain(chain);
});

test('production media upgrades reject wrong URL HMAC, unknown/query paths and wire-level critical duplicates', async (t) => {
  const f = await fixture(t, true);
  const flow = await browserVoiceFlow(t, f);
  const signature = twilio.getExpectedTwilioSignature(
    f.config.providers.TWILIO_AUTH_TOKEN,
    `${origin}/voice/media`,
    {},
  );
  for (const [path, headers, expected] of [
    ['/voice/media', { 'x-twilio-signature': 'offline-forged-signature' }, 403],
    [
      '/voice/media',
      {
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          f.config.providers.TWILIO_AUTH_TOKEN,
          `${origin}/voice/media?ignored=1`,
          {},
        ),
      },
      403,
    ],
    ['/voice/media', { host: 'other.example.test' }, 403],
    ['/voice/media?sessionId=offline', {}, 404],
    ['/api/events', {}, 404],
    ['/unknown', {}, 404],
  ] as const) {
    const result = await openMedia(t, f, headers, path);
    assert.equal(result.status, expected, path);
  }
  const key = Buffer.alloc(16, 4).toString('base64');
  const headers = [
    `Host: ${new URL(origin).host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `X-Twilio-Signature: ${signature}`,
  ];
  for (const duplicate of [
    `Host: ${new URL(origin).host}`,
    `X-Twilio-Signature: ${signature}`,
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Cookie: offline=1\r\nCookie: offline=1',
    'Content-Length: 1',
  ]) {
    const result = await rawWire(f.port, '/voice/media', 'GET', [
      ...headers,
      duplicate,
    ]);
    assert.equal(result.status, 403, duplicate.split(':')[0]);
  }
  assert.equal(f.calls.bridge, 0);
  assert.equal(f.calls.fakeCreates, 0);
  assert.equal(f.service.manager.activeSession?.id, flow.callId);
});

test('production media start cannot bind wrong account, SID, session, role, nonce or format despite a valid upgrade signature', async (t) => {
  const f = await fixture(t, true);
  const flow = await browserVoiceFlow(t, f);
  const valid = mediaStart(
    flow.callId,
    flow.localSid,
    'local',
    flow.prepared.params.nonce,
  );
  for (const [label, start] of [
    ['account', { ...valid, accountSid: `AC${'8'.repeat(32)}` }],
    ['SID', { ...valid, callSid: `CA${'6'.repeat(32)}` }],
    [
      'session',
      {
        ...valid,
        customParameters: {
          ...valid.customParameters,
          sessionId: 'unknown-call',
        },
      },
    ],
    [
      'role',
      {
        ...valid,
        customParameters: { ...valid.customParameters, role: 'other' },
      },
    ],
    [
      'nonce',
      {
        ...valid,
        customParameters: { ...valid.customParameters, nonce: 'wrong-nonce' },
      },
    ],
    [
      'format',
      { ...valid, mediaFormat: { ...valid.mediaFormat, sampleRate: 16000 } },
    ],
  ] as const) {
    const media = await openMedia(t, f, voiceTransportHeaders.proxy);
    assert.equal(media.status, 101);
    const closed = new Promise<number>((resolve) =>
      media.socket.once('close', (code) => resolve(code)),
    );
    media.socket.send(JSON.stringify({ event: 'start', start }));
    assert.equal(await closed, 1008, label);
    assert.equal(f.calls.bridge, 0);
    assert.equal(f.calls.fakeCreates, 0);
    assert.equal(f.service.manager.activeSession?.id, flow.callId);
  }
});

test('production signed terminal status confirms its own leg and cleans the remaining fake leg without duplicate cleanup', async (t) => {
  const chain = await fullVoiceChain(t, voiceTransportHeaders.proxy);
  const { f, flow, statusUrl, remoteFields, local, remoteMedia } = chain;
  for (const [url, fields] of [
    [
      flow.streamStatus,
      {
        ...remoteFields,
        CallSid: flow.localSid,
        StreamEvent: 'stream-started',
      },
    ],
    [
      chain.remoteStreamStatus,
      { ...remoteFields, StreamEvent: 'stream-started' },
    ],
  ] as const)
    assert.equal(
      (await flow.signed(url, fields, voiceTransportHeaders.duplicate)).status,
      204,
    );
  const closed = [local.socket, remoteMedia.socket].map(
    (socket) =>
      new Promise<void>((resolve) => socket.once('close', () => resolve())),
  );
  const result = await flow.signed(
    statusUrl.href,
    { ...remoteFields, CallStatus: 'completed' },
    voiceTransportHeaders.proxy,
  );
  assert.equal(result.status, 204, result.body);
  await Promise.all(closed);
  await waitFor(
    () => f.service.manager.isCleanupConfirmed(flow.callId),
    'signed terminal callback completes all cleanup',
  );
  assert.equal(f.service.manager.activeSession, null);
  assert.deepEqual(f.calls.fakeHangups, [flow.localSid]);
  assert.equal(f.calls.fakeBridgeCloses, 1);
  assert.equal(
    (
      await flow.signed(
        statusUrl.href,
        { ...remoteFields, CallStatus: 'completed' },
        voiceTransportHeaders.duplicate,
      )
    ).status,
    204,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.fakeHangups.length, 1);
});

for (const site of ['cross-site', 'same-site'])
  test(`phone public document accepts ${site} navigation without granting login or control`, async (t) => {
    const f = await fixture(t);
    const page = await httpCall(f.port, '/controlled', navigationHeaders(site));
    assert.equal(page.status, 200, page.body);
    assert.match(page.body, /data-phone-surface="controlled"/);
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal(
      (await httpCall(f.port, '/api/browser-session', readHeaders())).status,
      401,
    );
    assert.equal(
      (
        await httpCall(
          f.port,
          '/api/controller/acquire',
          writeHeaders(),
          'POST',
          { tabId: 'offline-tab' },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.write('/api/calls', undefined, undefined, {
          targetNumber: '+12025550101',
        })
      ).status,
      401,
    );
  });

test('existing web-workbench public shell accepts the same external navigation metadata', async (t) => {
  const port = await unusedPort();
  const config = parseCloudWebWorkbenchConfig(
    { ...environment(port), CLOUD_SERVICE_MODE: 'web-workbench' },
    initialTime,
  );
  const service = await createCloudWebWorkbenchService(config, {
    now: () => initialTime,
    googleFetch: async () => {
      throw new Error('offline Google MUST NOT be contacted');
    },
  });
  t.after(() => service.close());
  for (const site of ['cross-site', 'same-site']) {
    const page = await httpCall(port, '/controlled', navigationHeaders(site));
    assert.equal(page.status, 200, page.body);
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal(
      (await httpCall(port, '/api/browser-session', readHeaders())).status,
      401,
    );
  }
});

test('production phone HTTP Google callback verifies RSA/PKCE and returns a shell that survives provider navigation and refresh', async (t) => {
  const f = await fixture(t);
  assert.equal(f.config.runtime.mode, 'cloud');
  assert.equal(f.config.runtime.warmInstances, 1);
  assert.equal(Object.hasOwn(f.service, 'journal'), false);
  assert.equal(Object.hasOwn(f.service, 'deadline'), false);
  const status = await f.read('/auth/status');
  assert.equal(status.status, 200, status.body);
  assert.deepEqual(JSON.parse(status.body), {
    provider: 'google',
    enabled: true,
  });
  assert.equal((await f.read('/api/status')).status, 401);
  const login = await f.signIn();
  assert.equal(f.calls.token, 1);
  assert.equal(f.calls.jwks, 1);
  assert.equal(
    createHash('sha256').update(f.exchanges[0].verifier).digest('base64url'),
    login.flow.challenge,
  );
  assert.notEqual(login.flow.state, login.flow.nonce);
  assert.match(
    login.sessionHeader,
    /Path=\/; Secure; HttpOnly; SameSite=Strict$/,
  );
  assert.doesNotMatch(login.sessionHeader, /Domain|Expires|Max-Age/);
  assert.match(login.result.body, /url=\/controlled/);
  assert.equal(login.result.headers.location, undefined);
  assert.doesNotMatch(
    login.result.body,
    new RegExp(`${login.flow.code}|${login.flow.state}|${email}`),
  );
  for (const site of ['none', 'same-origin', 'same-site', 'cross-site']) {
    // A Strict cookie can be absent during the external navigation. The public
    // document must still load; later same-origin API reads check the session.
    const page = await httpCall(f.port, '/controlled', navigationHeaders(site));
    assert.equal(page.status, 200, page.body);
    assert.match(page.body, /data-phone-surface="controlled"/);
    assert.equal(page.headers['set-cookie'], undefined);
  }
  const refresh = await httpCall(
    f.port,
    '/controlled',
    navigationHeaders('same-origin', login.session),
  );
  assert.equal(refresh.status, 200, refresh.body);
  assert.equal(refresh.headers['set-cookie'], undefined);
  const current = await f.read('/api/browser-session', login.session);
  assert.equal(current.status, 200, current.body);
  assert.equal(JSON.parse(current.body).csrfToken, login.csrf);
  assert.equal((await f.read('/api/status', login.session)).status, 200);
  assert.equal((await f.read('/api/status')).status, 401);
  assert.equal((await f.callback(login.flow)).status, 401);
  assert.equal(
    f.calls.token,
    1,
    'Consumed state cannot trigger another exchange',
  );
});

test('real HTTP callback rejects wrong issuer, state, duplicate parameters and unbound cookies before any token exchange', async (t) => {
  const f = await fixture(t);
  const wrongIssuer = await f.start();
  const deniedIssuer = await f.callback(
    wrongIssuer,
    '&iss=https%3A%2F%2Fevil.example.test',
  );
  assert.equal(deniedIssuer.status, 401);
  assert.deepEqual(JSON.parse(deniedIssuer.body), { error: 'LOGIN_FAILED' });
  assert.equal((await f.callback(wrongIssuer)).status, 401);
  const flow = await f.start();
  assert.equal(
    (await f.callback({ ...flow, state: 'A'.repeat(43) })).status,
    401,
  );
  assert.equal((await f.callback(flow, '', '')).status, 401);
  const duplicate = await f.start();
  assert.equal(
    (await f.callback(duplicate, `&state=${duplicate.state}`)).status,
    401,
  );
  assert.equal((await f.read('/api/browser-session')).status, 401);
  assert.equal(f.calls.token, 0);
  assert.equal(f.calls.jwks, 0);
});

test('public document navigation leaves hostile Origin, asset fetches and API provenance denied', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  for (const site of ['same-site', 'cross-site']) {
    const evilOrigin = await httpCall(f.port, '/controlled', {
      ...navigationHeaders(site, login.session),
      origin: 'https://evil.example.test',
    });
    assert.equal(evilOrigin.status, 403);
    assert.deepEqual(JSON.parse(evilOrigin.body), {
      error: 'LOCAL_ACCESS_ONLY',
    });
    const asset = await httpCall(f.port, '/app.js', {
      'sec-fetch-site': site,
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'script',
      cookie: login.session,
    });
    assert.equal(asset.status, 403);
    assert.deepEqual(JSON.parse(asset.body), { error: 'LOCAL_ACCESS_ONLY' });
    for (const path of [
      '/api/status',
      '/api/browser-session',
      '/auth/status',
    ]) {
      const api = await httpCall(f.port, path, {
        ...readHeaders(login.session),
        'sec-fetch-site': site,
      });
      assert.equal(api.status, 403, `${path}: ${api.body}`);
    }
    const write = await httpCall(
      f.port,
      '/api/controller/acquire',
      {
        ...writeHeaders(login.session, login.csrf),
        'sec-fetch-site': site,
      },
      'POST',
      { tabId: 'offline-tab' },
    );
    assert.equal(write.status, 403, write.body);
  }
  for (const [mode, dest] of [
    ['cors', 'empty'],
    ['no-cors', 'iframe'],
    ['navigate', 'iframe'],
  ]) {
    const denied = await httpCall(f.port, '/controlled', {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': mode,
      'sec-fetch-dest': dest,
    });
    assert.equal(denied.status, 403, denied.body);
  }
  const script = await httpCall(f.port, '/app.js', {
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'script',
  });
  assert.equal(script.status, 200, script.body);
});

test('existing HTTP session survives a cancelled login and successful replacement retires the old cookie', async (t) => {
  const f = await fixture(t);
  const first = await f.signIn();
  const pending = await f.start(first.session);
  assert.equal((await f.read('/api/status', first.session)).status, 200);
  assert.equal(
    (
      await f.write(
        '/auth/google/cancel',
        `${first.session}; ${pending.cookie}`,
      )
    ).status,
    200,
  );
  assert.equal((await f.callback(pending)).status, 401);
  assert.equal((await f.read('/api/status', first.session)).status, 200);
  const replacement = await f.signIn(first.session);
  assert.notEqual(replacement.session, first.session);
  assert.equal(
    (await f.read('/api/browser-session', first.session)).status,
    401,
  );
  assert.equal(
    (await f.read('/api/browser-session', replacement.session)).status,
    200,
  );
  assert.equal(f.calls.token, 2);
});

test('HTTP renewal and logout retain current Origin/CSRF checks and immediately revoke the session', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  for (const path of ['/auth/session/renew', '/auth/logout']) {
    assert.equal((await f.write(path, login.session)).status, 403);
    assert.equal((await f.write(path, login.session, 'invalid')).status, 403);
    const evilOrigin = await httpCall(
      f.port,
      path,
      {
        ...writeHeaders(login.session, login.csrf),
        origin: 'https://evil.example.test',
      },
      'POST',
      {},
    );
    assert.equal(evilOrigin.status, 403);
    assert.equal(
      (await f.read('/api/browser-session', login.session)).status,
      200,
    );
  }
  f.setNow(initialTime + 14 * 60 * 1000);
  const renewed = await f.write(
    '/auth/session/renew',
    login.session,
    login.csrf,
  );
  assert.equal(renewed.status, 200, renewed.body);
  assert.equal(renewed.headers['set-cookie'], undefined);
  f.setNow(initialTime + 16 * 60 * 1000);
  assert.equal((await f.read('/api/status', login.session)).status, 200);
  const logout = await f.write('/auth/logout', login.session, login.csrf);
  assert.equal(logout.status, 200, logout.body);
  assert.deepEqual(JSON.parse(logout.body), { ok: true });
  assert.equal((await f.read('/api/status', login.session)).status, 401);
  assert.equal(
    (await f.write('/auth/session/renew', login.session, login.csrf)).status,
    401,
  );
  assert.equal(
    (
      await f.write('/api/controller/acquire', login.session, login.csrf, {
        tabId: 'offline-tab',
      })
    ).status,
    401,
  );
});

test('HTTP polling and page refresh cannot extend phone idle expiry or restore expired authority', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  f.setNow(initialTime + 14 * 60 * 1000);
  assert.equal((await f.read('/api/status', login.session)).status, 200);
  assert.equal(
    (
      await httpCall(
        f.port,
        '/controlled',
        navigationHeaders('same-origin', login.session),
      )
    ).status,
    200,
  );
  f.setNow(initialTime + 15 * 60 * 1000);
  assert.equal(
    (await f.read('/api/browser-session', login.session)).status,
    401,
  );
  assert.equal(
    (await f.write('/auth/session/renew', login.session, login.csrf)).status,
    401,
  );
  assert.equal(
    (
      await f.write('/api/controller/acquire', login.session, login.csrf, {
        tabId: 'offline-tab',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.write('/auth/session/page', login.session, login.csrf, {
        pageId: 'offline-page',
        operation: 'open',
        sequence: 1,
      })
    ).status,
    404,
  );
});

test('explicit HTTP renewal cannot cross the unchanged phone absolute session deadline', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  for (let step = 1; step <= 34; step += 1) {
    f.setNow(initialTime + step * 14 * 60 * 1000);
    const renewed = await f.write(
      '/auth/session/renew',
      login.session,
      login.csrf,
    );
    assert.equal(renewed.status, 200, renewed.body);
  }
  f.setNow(initialTime + 8 * 60 * 60 * 1000);
  assert.equal(
    (await f.read('/api/browser-session', login.session)).status,
    401,
  );
  assert.equal(
    (await f.write('/auth/session/renew', login.session, login.csrf)).status,
    401,
  );
});

test('HTTP controller acquire, refresh, renew, revoke and expiry preserve one holder and proof binding', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  assert.equal(
    (
      await f.write('/api/controller/acquire', login.session, undefined, {
        tabId: 'offline-tab',
      })
    ).status,
    403,
  );
  const acquired = await f.write(
    '/api/controller/acquire',
    login.session,
    login.csrf,
    { tabId: 'offline-tab' },
  );
  assert.equal(acquired.status, 200, acquired.body);
  const lease = JSON.parse(acquired.body);
  const proof = {
    tabId: lease.tabId,
    leaseId: lease.leaseId,
    epoch: lease.epoch,
  };
  assert.equal(
    (
      await f.write('/api/controller/acquire', login.session, login.csrf, {
        tabId: 'other-tab',
      })
    ).status,
    409,
  );
  const current = await f.read(
    '/api/browser-session?tabId=offline-tab',
    login.session,
  );
  assert.equal(current.status, 200, current.body);
  assert.deepEqual(JSON.parse(current.body).controller, {
    mode: 'held',
    ownSession: true,
    tabMatches: true,
    epoch: lease.epoch,
    expiresAt: lease.expiresAt,
  });
  f.setNow(initialTime + 10000);
  const refreshed = await f.read(
    '/api/browser-session?tabId=offline-tab',
    login.session,
  );
  assert.equal(
    JSON.parse(refreshed.body).controller.expiresAt,
    lease.expiresAt,
  );
  assert.equal(
    (
      await f.write('/api/controller/renew', login.session, login.csrf, {
        ...proof,
        tabId: 'other-tab',
      })
    ).status,
    403,
  );
  const renewed = await f.write(
    '/api/controller/renew',
    login.session,
    login.csrf,
    proof,
  );
  assert.equal(renewed.status, 200, renewed.body);
  assert.equal(JSON.parse(renewed.body).expiresAt, lease.expiresAt + 10000);
  assert.equal(
    (await f.write('/api/controller/revoke', login.session, login.csrf, proof))
      .status,
    200,
  );
  assert.equal(
    (await f.write('/api/controller/renew', login.session, login.csrf, proof))
      .status,
    403,
  );
  const next = await f.write(
    '/api/controller/acquire',
    login.session,
    login.csrf,
    { tabId: 'other-tab' },
  );
  assert.equal(next.status, 200, next.body);
  const nextLease = JSON.parse(next.body);
  assert.ok(nextLease.epoch > lease.epoch);
  f.setNow(nextLease.expiresAt);
  assert.equal(
    (
      await f.write('/api/controller/renew', login.session, login.csrf, {
        tabId: nextLease.tabId,
        leaseId: nextLease.leaseId,
        epoch: nextLease.epoch,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.write('/api/controller/acquire', login.session, login.csrf, {
        tabId: 'offline-tab',
      })
    ).status,
    200,
  );
});

test('authenticated real HTTP ingress still rejects local management, configuration, unscoped Voice tokens and unsigned Twilio callbacks', async (t) => {
  const f = await fixture(t);
  const login = await f.signIn();
  for (const path of [
    '/api/config',
    '/api/settings',
    '/api/connection-maintenance',
    '/api/token',
    '/health',
    '/controlled?admin=true',
  ]) {
    const result = await f.read(path, login.session);
    assert.equal(result.status, 404, `${path}: ${result.body}`);
  }
  for (const path of [
    '/api/config',
    '/api/settings',
    '/api/presence',
    '/api/connection-maintenance',
    '/api/verify',
    '/api/shutdown',
  ]) {
    const result = await f.write(path, login.session, login.csrf);
    assert.equal(result.status, 404, `${path}: ${result.body}`);
  }
  for (const path of [
    '/voice/client',
    '/voice/connect',
    '/voice/status',
    '/voice/stream-status',
  ]) {
    const result = await f.write(path, login.session, login.csrf, {
      CallSid: `CA${'5'.repeat(32)}`,
    });
    assert.equal(result.status, 403, `${path}: ${result.body}`);
    assert.deepEqual(JSON.parse(result.body), {
      error: 'INVALID_TWILIO_SIGNATURE',
    });
  }
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.bridge, 0);
});

// Standard Voice webhook fields and SDK-supplied per-call parameters traverse
// the real production ingress; the official locked SDK signs the exact URL.
test('production signed Twilio form passes real ingress and per-call Voice authorization and returns stream TwiML', async (t) => {
  const f = await fixture(t, true);
  const login = await f.signIn();
  const requests: string[] = [];
  let prepared: any;
  const client = createControllerClient({
    randomTabId: () => 'offline-voice-tab',
    fetchImpl: async (path: string, options: any) => {
      requests.push(`${options.method} ${path}`);
      const result = await httpCall(
        f.port,
        path,
        {
          ...readHeaders(login.session),
          ...(options.method === 'POST' ? { origin } : {}),
          ...options.headers,
        },
        options.method,
        options.body,
      );
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => JSON.parse(result.body),
      };
    },
  });
  t.after(() => client.dispose());
  await client.boot();
  client.setConnectionState(true);
  assert.equal(client.state.canStart, false);
  assert.equal(client.state.canDial, true);
  assert.equal(requests.filter((value) => value.startsWith('POST ')).length, 0);
  await client.dial('+12025550101', {
    connectVoice: async (voice: any) => {
      prepared = voice;
      return { disconnect() {} };
    },
  });
  const callId = client.state.call!.id;
  assert.equal(
    requests.filter((value) => value === 'POST /api/controller/acquire').length,
    1,
  );
  assert.equal(
    requests.filter((value) => value === 'POST /api/calls').length,
    1,
  );
  assert.equal(prepared.params.sessionId, callId);
  const fields = {
    AccountSid: f.config.providers.TWILIO_ACCOUNT_SID,
    ApiVersion: '2010-04-01',
    ApplicationSid: f.config.providers.TWILIO_TWIML_APP_SID,
    CallSid: `CA${'5'.repeat(32)}`,
    CallStatus: 'ringing',
    Caller: `client:${prepared.grant.identity}`,
    From: `client:${prepared.grant.identity}`,
    Direction: 'inbound',
    Called: '',
    To: '',
    ...prepared.params,
  };
  const headers = {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'user-agent': 'TwilioProxy/1.1',
    'x-forwarded-for': '192.0.2.42',
    'x-forwarded-host': new URL(origin).host,
    'x-twilio-signature': twilio.getExpectedTwilioSignature(
      f.config.providers.TWILIO_AUTH_TOKEN,
      `${origin}/voice/client`,
      fields,
    ),
  };
  const ordinaryHeaders = ['accept', 'user-agent', 'x-request-id'];
  let ordinaryHeadersAbsent = false;
  f.service.app.server.prependListener('request', (req) => {
    if (req.url === '/voice/client')
      ordinaryHeadersAbsent = ordinaryHeaders.every(
        (name) => req.headers[name] === undefined,
      );
  });
  const result = await httpCall(
    f.port,
    '/voice/client',
    headers,
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(result.status, 200, result.body);
  assert.match(result.headers['content-type']!, /text\/xml/);
  assert.match(result.body, /<Connect><Stream/);
  assert.match(result.body, /wss:\/\/phone\.example\.test\/voice\/media/);
  assert.equal(f.calls.fakeCreates, 0);
  const replay = await httpCall(
    f.port,
    '/voice/client',
    headers,
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(replay.status, 200, replay.body);
  assert.equal(f.calls.fakeCreates, 0);
  // These forwarded values are transport metadata, not Twilio identity or
  // the signature URL. The pinned Host and backend signature still decide.
  const proxyChain = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      forwarded: 'for="192.0.2.42:443";proto=https;host=internal-proxy',
      'x-forwarded-for': '192.0.2.42:443, unknown',
      'x-forwarded-host': 'internal-proxy',
      'x-forwarded-proto': 'https, http',
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(proxyChain.status, 200, proxyChain.body);
  const duplicateProxy = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      'x-forwarded-proto': ['https', 'http'] as unknown as string,
      'x-forwarded-for': ['192.0.2.42:443', 'unknown'] as unknown as string,
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(duplicateProxy.status, 200, duplicateProxy.body);
  for (const ordinary of ordinaryHeaders) {
    const duplicated = await httpCall(
      f.port,
      '/voice/client',
      {
        ...headers,
        [ordinary]: ['offline-one', 'offline-two'] as unknown as string,
      },
      'POST',
      new URLSearchParams(fields).toString(),
    );
    assert.equal(duplicated.status, 200, `${ordinary}: ${duplicated.body}`);
    assert.match(duplicated.body, /<Connect><Stream/);
    assert.equal(ordinaryHeadersAbsent, true);
  }
  // Compatibility is specific to the signed Voice form. Browser/API headers
  // retain their original duplicate rejection before cookie/Origin/CSRF checks.
  const duplicateBrowserHeader = await httpCall(
    f.port,
    '/api/browser-session',
    {
      ...readHeaders(login.session),
      accept: ['application/json', '*/*'] as unknown as string,
    },
  );
  assert.equal(duplicateBrowserHeader.status, 403);
  assert.deepEqual(JSON.parse(duplicateBrowserHeader.body), {
    error: 'CLOUD_INGRESS_FORBIDDEN',
  });
  for (const [name, value] of [
    ['content-type', headers['content-type']],
    ['connection', 'close'],
    ['te', 'trailers'],
    ['origin', origin],
    ['authorization', 'Bearer offline'],
    ['x-phone-csrf', 'offline'],
    ['sec-fetch-site', 'same-origin'],
    ['sec-websocket-key', 'offline'],
  ]) {
    const duplicated = await httpCall(
      f.port,
      '/voice/client',
      { ...headers, [name]: [value, value] as unknown as string },
      'POST',
      new URLSearchParams(fields).toString(),
    );
    assert.equal(duplicated.status, 403, name);
    assert.deepEqual(JSON.parse(duplicated.body), {
      error: 'CLOUD_INGRESS_FORBIDDEN',
    });
  }
  const duplicateSignature = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      'x-twilio-signature': [
        headers['x-twilio-signature'],
        headers['x-twilio-signature'],
      ] as unknown as string,
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(duplicateSignature.status, 403);
  assert.deepEqual(JSON.parse(duplicateSignature.body), {
    error: 'CLOUD_INGRESS_FORBIDDEN',
  });
  const encodedForm = new URLSearchParams(fields).toString();
  // Node's HTTP client joins Cookie arrays into one header. Send wire-level
  // duplicates directly so the test reaches the real ingress rawHeaders gate.
  for (const [duplicate, expectedStatus] of [
    ['Cookie: offline=1\r\nCookie: offline=1', 403],
    [`Content-Length: ${Buffer.byteLength(encodedForm)}`, 400],
  ] as const) {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: f.port });
      let received = '';
      socket.setTimeout(3000, () =>
        socket.destroy(new Error('offline raw HTTP timeout')),
      );
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
      });
      socket.on('end', () => resolve(received));
      socket.on('connect', () => {
        socket.write(
          `POST /voice/client HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n` +
            `Content-Type: ${headers['content-type']}\r\n` +
            `X-Twilio-Signature: ${headers['x-twilio-signature']}\r\n` +
            `Content-Length: ${Buffer.byteLength(encodedForm)}\r\n` +
            `${duplicate}\r\nConnection: close\r\n\r\n${encodedForm}`,
        );
      });
    });
    assert.match(response, new RegExp(`^HTTP/1.1 ${expectedStatus} `));
    if (expectedStatus === 403)
      assert.match(response, /CLOUD_INGRESS_FORBIDDEN/);
  }
  const duplicateHost = await httpCall(
    f.port,
    '/voice/client',
    [
      'Host',
      new URL(origin).host,
      'Host',
      new URL(origin).host,
      'X-Forwarded-Proto',
      'https',
      'Content-Type',
      headers['content-type'],
      'X-Twilio-Signature',
      headers['x-twilio-signature'],
      'Content-Length',
      String(Buffer.byteLength(encodedForm)),
    ],
    'POST',
    encodedForm,
  );
  assert.equal(duplicateHost.status, 403);
  const framing = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      'transfer-encoding': 'chunked',
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(framing.status, 400, framing.body);
  const connection = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      connection: 'close, x-twilio-signature',
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(connection.status, 403);
  const forgedProxy = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      forwarded: 'for=unknown;proto=http',
      'x-forwarded-proto': 'http',
      accept: ['application/xml', '*/*'] as unknown as string,
      'x-twilio-signature': 'offline-forged-signature',
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(forgedProxy.status, 403);
  assert.deepEqual(JSON.parse(forgedProxy.body), {
    error: 'INVALID_TWILIO_SIGNATURE',
  });
  const signedRejected = async (
    override: Record<string, string>,
    code: string,
  ) => {
    const changedFields = { ...fields, ...override };
    const rejected = await httpCall(
      f.port,
      '/voice/client',
      {
        ...headers,
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          f.config.providers.TWILIO_AUTH_TOKEN,
          `${origin}/voice/client`,
          changedFields,
        ),
      },
      'POST',
      new URLSearchParams(changedFields).toString(),
    );
    assert.equal(rejected.status, 403, rejected.body);
    assert.deepEqual(JSON.parse(rejected.body), { error: code });
  };
  await signedRejected(
    { AccountSid: `AC${'8'.repeat(32)}` },
    'INVALID_TWILIO_SIGNATURE',
  );
  await signedRejected({ sessionId: 'unknown-call' }, 'INVALID_SESSION');
  await signedRejected({ nonce: 'wrong-nonce' }, 'INVALID_SESSION');
  await signedRejected(
    { From: 'client:wrong-identity' },
    'INVALID_BROWSER_CALL',
  );
  await signedRejected({ join: 'wrong-join' }, 'INVALID_VOICE_JOIN');
  await signedRejected({ CallSid: `CA${'6'.repeat(32)}` }, 'CALL_SID_MISMATCH');
  const wrongUrl = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      'x-twilio-signature': twilio.getExpectedTwilioSignature(
        f.config.providers.TWILIO_AUTH_TOKEN,
        'https://other.example.test/voice/client',
        fields,
      ),
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(wrongUrl.status, 403);
  assert.deepEqual(JSON.parse(wrongUrl.body), {
    error: 'INVALID_TWILIO_SIGNATURE',
  });
  const wrongIngress = await httpCall(
    f.port,
    '/voice/client',
    {
      ...headers,
      host: 'other.example.test',
    },
    'POST',
    new URLSearchParams(fields).toString(),
  );
  assert.equal(wrongIngress.status, 403);
  assert.deepEqual(JSON.parse(wrongIngress.body), {
    error: 'CLOUD_INGRESS_FORBIDDEN',
  });
  const changed = new URLSearchParams({
    ...fields,
    From: 'client:wrong-identity',
  }).toString();
  const tampered = await httpCall(
    f.port,
    '/voice/client',
    headers,
    'POST',
    changed,
  );
  assert.equal(tampered.status, 403, tampered.body);
  assert.deepEqual(JSON.parse(tampered.body), {
    error: 'INVALID_TWILIO_SIGNATURE',
  });
  await client.cancel();
  assert.equal(f.service.manager.isCleanupConfirmed(callId), true);
  client.dispose();
  assert.deepEqual(f.calls.fakeHangups, [fields.CallSid]);
});
