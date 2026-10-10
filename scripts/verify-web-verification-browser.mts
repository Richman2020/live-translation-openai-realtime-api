/** Actual web-verification page and login-only cloud service, entirely offline.
 * Chrome's Google navigation is intercepted before network access. A synthetic
 * RSA provider validates PKCE during the real asynchronous token exchange.
 * No auth cookie is preinstalled, and no Google account, secret or call is used.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { CLOUD_SESSION_COOKIE } from '../src/solo/cloud-access';
import { GOOGLE_LOGIN_COOKIE } from '../src/solo/google-login';
import { createCloudWebVerificationService } from '../src/solo/cloud-web-verification-service';
import {
  parseCloudWebVerificationConfig,
  selectCloudServiceMode,
} from '../src/solo/cloud-web-verification-config';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable =
  process.env.CHROME_BIN ||
  [
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].find(existsSync);
if (!executable)
  throw new Error('Set CHROME_BIN to an installed Chromium executable.');
const directory = await mkdtemp(join(tmpdir(), 'web-verification-offline-'));
const profile = join(directory, 'chrome');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'offline-browser-rsa',
  alg: 'RS256',
  use: 'sig',
};
const clientId = 'offline-fixture.apps.googleusercontent.com';
const syntheticEmail = 'owner@workspace.example.test';
const syntheticSecret = 'explicit-offline-client-secret';
const providerCodes = new Map<string, { nonce: string; challenge: string }>();
const checks: string[] = [];
const faults: string[] = [];
const cancelledNetworkRequests = new Set<string>();
const blockedExternalOrigins = new Set<string>();
const clients: CdpPage[] = [];
const upstreamRequests = new Set<http.ClientRequest>();
const callbackHeaders: {
  site: string | undefined;
  mode: string | undefined;
  dest: string | undefined;
  originPresent: boolean;
  temporaryCookiePresent: boolean;
  sessionCookiePresent: boolean;
}[] = [];
const callbackStatuses: number[] = [];
const authWrites: {
  path: string;
  originMatches: boolean;
  site: string | undefined;
  mode: string | undefined;
  dest: string | undefined;
  loginHeader: string | undefined;
}[] = [];
let loginCookieBounds: Record<string, unknown> | undefined;
let interceptedAuthorizations = 0;
let providerTokenExchanges = 0;
let providerKeyFetches = 0;
let supplierCalls = 0;
let clockOffset = 0;
let tokenVariant: 'valid' | 'wrong-nonce' | 'wrong-identity' = 'valid';
const clock = () => Date.now() + clockOffset;
let privateApiUnavailable = false;
const requestedPaths: string[] = [];
const apiProvenance: {
  path: string;
  method: string;
  origin: string | null;
  site: string | null;
  mode: string | null;
  dest: string | null;
}[] = [];
let backendPort = 0;
let origin = '';
let lastCallback = '';
let chrome: ReturnType<typeof spawn> | undefined;
let browserStderr = '';
let signedOutScreenshot: string | undefined;
let signedInScreenshot: string | undefined;
let service:
  | Awaited<ReturnType<typeof createCloudWebVerificationService>>
  | undefined;

function check(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  checks.push(label);
}
async function eventually<T>(
  action: () => Promise<T> | T,
  label: string,
  timeout = 12000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch {
      // A real top-level navigation briefly retires the previous JS context.
      // Readiness retries inspect the new document without capturing auth URLs.
    }
    if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null))
      throw new Error(`${label}: Chromium exited.`);
    await pause(40);
  }
  throw new Error(`${label}: timed out.`);
}

// The only accepted asynchronous provider transport is explicitly substituted.
// It validates the app's PKCE exchange, then signs an expiring synthetic ID token.
const fakeProviderFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input
        : input.url,
  );
  if (
    url.origin === 'https://oauth2.googleapis.com' &&
    url.pathname === '/token'
  ) {
    providerTokenExchanges++;
    const body = new URLSearchParams(String(init?.body || ''));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_id'), clientId);
    assert.equal(body.get('client_secret'), syntheticSecret);
    assert.equal(body.get('redirect_uri'), `${origin}/auth/google/callback`);
    const code = body.get('code') || '';
    const issued = providerCodes.get(code);
    assert.ok(
      issued,
      'Only intercepted offline authorization codes can exchange',
    );
    providerCodes.delete(code);
    const verifier = body.get('code_verifier') || '';
    assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(
      createHash('sha256').update(verifier).digest('base64url'),
      issued.challenge,
    );
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: publicKey.kid, typ: 'JWT' }),
    ).toString('base64url');
    const now = Math.floor(clock() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'offline-browser-subject',
        iat: now,
        exp: now + 300,
        nonce:
          tokenVariant === 'wrong-nonce'
            ? 'unmatched-fixture-nonce'
            : issued.nonce,
        email:
          tokenVariant === 'wrong-identity'
            ? 'other@workspace.example.test'
            : syntheticEmail,
        email_verified: true,
        hd: 'workspace.example.test',
      }),
    ).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(unsigned),
      keys.privateKey,
    ).toString('base64url');
    return new Response(
      JSON.stringify({
        access_token: 'explicit-offline-unused-access-token',
        id_token: `${unsigned}.${signature}`,
        token_type: 'Bearer',
        expires_in: 300,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (
    url.origin === 'https://www.googleapis.com' &&
    url.pathname === '/oauth2/v3/certs'
  ) {
    providerKeyFetches++;
    return new Response(JSON.stringify({ keys: [publicKey] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60',
      },
    });
  }
  throw new Error('Unexpected provider endpoint in offline login fixture');
};

class CdpPage {
  socket: WebSocket;
  nextId = 0;
  pending = new Map<
    number,
    { done: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      const value = JSON.parse(String(data));
      if (value.id) {
        const pending = this.pending.get(value.id);
        this.pending.delete(value.id);
        value.error
          ? pending?.reject(
              Object.assign(new Error(value.error.message), {
                protocolCode: value.error.code,
              }),
            )
          : pending?.done(value.result);
      } else if (value.method === 'Runtime.exceptionThrown')
        faults.push('Unexpected browser exception');
      else if (
        value.method === 'Network.loadingFailed' &&
        value.params.canceled === true
      )
        cancelledNetworkRequests.add(value.params.requestId);
      else if (value.method === 'Fetch.requestPaused')
        void this.intercept(value.params).catch((error) => {
          const url = new URL(value.params.request.url);
          const local = url.origin === origin;
          const category = [
            '/favicon.ico',
            '/favicon.svg',
            '/controlled',
            '/auth/status',
            '/auth/logout',
            '/auth/google/start',
            '/auth/google/callback',
            '/api/browser-session',
            '/api/events',
          ].includes(url.pathname)
            ? url.pathname
            : 'asset-or-other';
          const code = /Invalid InterceptionId/.test(String(error?.message))
            ? 'INVALID_INTERCEPTION_ID'
            : error?.name === 'AssertionError'
              ? 'FIXTURE_ASSERTION'
              : 'CDP_COMMAND_FAILURE';
          const resource = [
            'Document',
            'Script',
            'Stylesheet',
            'Image',
            'Fetch',
            'XHR',
            'EventSource',
            'Other',
          ].includes(value.params.resourceType)
            ? value.params.resourceType
            : 'OTHER_RESOURCE';
          const protocolCode =
            typeof error?.protocolCode === 'number'
              ? error.protocolCode
              : 'none';
          faults.push(
            `Offline interception failed: ${code}/${protocolCode}/${local ? 'same-origin' : 'provider'}/${resource}/${category}/hasNetworkId=${Boolean(value.params.networkId)}/cancelled=${cancelledNetworkRequests.has(value.params.networkId)}`,
          );
        });
    });
  }
  async ready() {
    await once(this.socket, 'open');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Page.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
      window.__webVerificationProbe={microphones:0,devices:0,webSockets:0};
      const probe=window.__webVerificationProbe;
      if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{probe.microphones++;return Promise.reject(new Error('Verification cannot open a microphone'));};
      window.Twilio={Device:class{constructor(){probe.devices++;throw new Error('Verification cannot instantiate Voice');}}};
      const OriginalWebSocket=window.WebSocket;
      window.WebSocket=class extends OriginalWebSocket {constructor(...args){probe.webSockets++;super(...args);}};
    `,
    });
    // Intercept every request so a missing fixture cannot contact Google or a
    // supplier. Continue only the native same-origin application requests.
    await this.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  }
  async intercept(event: any) {
    const url = new URL(event.request.url);
    if (
      url.origin === origin ||
      url.protocol === 'data:' ||
      url.protocol === 'about:'
    ) {
      await this.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    if (
      url.origin === 'https://accounts.google.com' &&
      url.pathname === '/o/oauth2/v2/auth' &&
      event.resourceType === 'Document'
    ) {
      const cookie = (
        await this.send('Network.getCookies', { urls: [origin] })
      ).cookies.find((item: any) => item.name === GOOGLE_LOGIN_COOKIE);
      assert.ok(cookie);
      loginCookieBounds = {
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        path: cookie.path,
        domain: cookie.domain,
        session: cookie.session,
      };
      assert.equal(url.searchParams.get('client_id'), clientId);
      assert.equal(
        url.searchParams.get('redirect_uri'),
        `${origin}/auth/google/callback`,
      );
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('scope'), 'openid email');
      const state = url.searchParams.get('state') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const challenge = url.searchParams.get('code_challenge') || '';
      assert.match(state, /^[A-Za-z0-9_-]{43}$/);
      assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      const code = `offline-intercepted-code-${++interceptedAuthorizations}`;
      providerCodes.set(code, { nonce, challenge });
      lastCallback = `${origin}/auth/google/callback?${new URLSearchParams({ code, state })}`;
      // A real document at the Google origin initiates the native cross-site
      // callback. No fake cookie or forged Fetch Metadata is supplied.
      const html = `<!doctype html><meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><script>location.replace(${JSON.stringify(lastCallback)})</script>`;
      await this.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(html).toString('base64'),
      });
      return;
    }
    blockedExternalOrigins.add(url.origin);
    await this.send('Fetch.failRequest', {
      requestId: event.requestId,
      errorReason: 'BlockedByClient',
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    const value = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (value.exceptionDetails) throw new Error('Browser expression failed');
    return value.result.value;
  }
  async click(id: string) {
    await this.send('Page.bringToFront');
    await eventually(
      () =>
        this.evaluate(
          `Boolean(document.getElementById(${JSON.stringify(id)}) && !document.getElementById(${JSON.stringify(id)}).disabled)`,
        ),
      `Enabled ${id}`,
    );
    await this.evaluate(
      `document.getElementById(${JSON.stringify(id)}).click()`,
    );
  }
  async state() {
    return this.evaluate(
      `({ready:document.documentElement.dataset.webVerificationReady, phase:document.documentElement.dataset.webVerificationPhase, authenticated:document.documentElement.dataset.authenticated==='true', loginVisible:document.getElementById('google-login') && !document.getElementById('google-login').hidden, callsDisabled:document.getElementById('calls-disabled')?.disabled, notice:document.getElementById('calls-disabled-notice')?.textContent,error:document.getElementById('app-error')?.textContent})`,
    );
  }
}

const proxy = https.createServer((request, response) => {
  const path = new URL(
    request.url || '/',
    origin || 'https://phone.example.test',
  ).pathname;
  requestedPaths.push(path);
  if (path.startsWith('/api/'))
    apiProvenance.push({
      path,
      method: request.method!,
      origin: request.headers.origin || null,
      site: (request.headers['sec-fetch-site'] as string) || null,
      mode: (request.headers['sec-fetch-mode'] as string) || null,
      dest: (request.headers['sec-fetch-dest'] as string) || null,
    });
  // A genuine local transport failure, never a fabricated successful API response.
  if (
    privateApiUnavailable &&
    (path.startsWith('/api/') || path === '/auth/status')
  ) {
    request.destroy();
    return;
  }
  if (path === '/auth/google/callback')
    callbackHeaders.push({
      site: request.headers['sec-fetch-site'] as string | undefined,
      mode: request.headers['sec-fetch-mode'] as string | undefined,
      dest: request.headers['sec-fetch-dest'] as string | undefined,
      originPresent: request.headers.origin !== undefined,
      temporaryCookiePresent: /(?:^|;\s*)__Host-ai-phone-login=/.test(
        request.headers.cookie || '',
      ),
      sessionCookiePresent: (request.headers.cookie || '').includes(
        `${CLOUD_SESSION_COOKIE}=`,
      ),
    });
  if (path.startsWith('/auth/') && request.method === 'POST')
    authWrites.push({
      path,
      originMatches: request.headers.origin === origin,
      site: request.headers['sec-fetch-site'] as string | undefined,
      mode: request.headers['sec-fetch-mode'] as string | undefined,
      dest: request.headers['sec-fetch-dest'] as string | undefined,
      loginHeader: request.headers['x-phone-login'] as string | undefined,
    });
  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: backendPort,
      method: request.method,
      path: request.url,
      // This owned HTTPS listener is the fixture's platform TLS terminator.
      // Browser Origin and Fetch Metadata remain native and untouched.
      headers: { ...request.headers, 'x-forwarded-proto': 'https' },
    },
    (stream) => {
      if (path === '/auth/google/callback')
        callbackStatuses.push(stream.statusCode!);
      response.writeHead(stream.statusCode!, stream.headers);
      stream.pipe(response);
      response.once('close', () => stream.destroy());
    },
  );
  upstreamRequests.add(upstream);
  upstream.once('close', () => upstreamRequests.delete(upstream));
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  response.once('close', () => upstream.destroy());
  request.pipe(upstream);
});

async function reserveFreePort() {
  const server = http.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
async function deniedUpgrade(path: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${backendPort}${path}`, {
      headers: { host: new URL(origin).host, origin },
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Denied upgrade timed out'));
    }, 5000);
    socket.on('error', () => undefined);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.destroy();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.once('open', () => {
      clearTimeout(timer);
      socket.terminate();
      resolve(101);
    });
  });
}

try {
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=phone.example.test',
      '-keyout',
      join(directory, 'test.key'),
      '-out',
      join(directory, 'test.crt'),
    ],
    { timeout: 10000 },
  );
  proxy.setSecureContext({
    key: await readFile(join(directory, 'test.key')),
    cert: await readFile(join(directory, 'test.crt')),
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  origin = `https://phone.example.test:${address.port}`;
  const runtimePort = await reserveFreePort();
  const environment = {
    CLOUD_SERVICE_MODE: 'web-verification',
    AI_PHONE_RUNTIME_MODE: 'cloud',
    PORT: String(runtimePort),
    CLOUD_PUBLIC_ORIGIN: origin,
    PUBLIC_BASE_URL: origin,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: syntheticSecret,
    GOOGLE_ALLOWED_EMAIL: syntheticEmail,
    GOOGLE_HOSTED_DOMAIN: 'workspace.example.test',
    CLOUD_TEST_DEADLINE: new Date(clock() + 3600000).toISOString(),
  };
  for (const name of [
    'TWILIO_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'CLOUD_JOURNAL_DIRECTORY',
  ])
    Object.defineProperty(environment, name, {
      get() {
        supplierCalls++;
        throw new Error(
          'Web verification must never read supplier configuration',
        );
      },
    });
  const configuration = parseCloudWebVerificationConfig(environment, clock());
  check(
    configuration.mode,
    'web-verification',
    'explicit web-only configuration selects the independent service',
  );
  for (const value of ['', 'web-verification ', 'PHONE', 'unknown'])
    assert.throws(
      () => selectCloudServiceMode({ CLOUD_SERVICE_MODE: value }),
      /CLOUD_SERVICE_MODE_INVALID/,
    );
  checks.push(
    'empty or unknown mode cannot silently fall back to phone service',
  );
  assert.throws(
    () =>
      parseCloudWebVerificationConfig(
        { ...environment, GOOGLE_CLIENT_ID: '' },
        clock(),
      ),
    /CLOUD_CONFIG_INVALID:GOOGLE_CLIENT_ID/,
  );
  checks.push(
    'incomplete web login configuration fails instead of selecting phone',
  );
  service = await createCloudWebVerificationService(configuration, {
    googleFetch: fakeProviderFetch,
    now: clock,
    publicDir: join(repo, 'public'),
  });
  const backend = service.ingress.server.address();
  assert.ok(backend && typeof backend !== 'string');
  backendPort = backend.port;
  chrome = spawn(
    executable,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP phone.example.test 127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  chrome.stderr!.on('data', (bytes) => {
    browserStderr = (browserStderr + String(bytes)).slice(-4000);
  });
  chrome.on('error', () => faults.push('Chromium process failure'));
  const port = await eventually(
    async () => {
      try {
        return Number(
          (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(
            '\n',
          )[0],
        );
      } catch {
        return 0;
      }
    },
    'Chromium startup',
    30000,
  );
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
    })
  ).json();
  const page = new CdpPage(target.webSocketDebuggerUrl);
  clients.push(page);
  await page.ready();
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Page.navigate', { url: `${origin}/controlled` });
  try {
    await eventually(
      async () =>
        (await page.state()).ready === 'true' &&
        (await page.state()).loginVisible,
      'Actual anonymous web verification',
    );
  } catch (error) {
    throw new Error(
      `${String(error)} Safe diagnostic: ${JSON.stringify(await page.evaluate('({path:location.pathname,body:document.body?.innerText.slice(0,180),state:document.documentElement.dataset})'))}; requested paths: ${JSON.stringify(requestedPaths)}; faults:${JSON.stringify(faults)}`,
    );
  }
  check(
    (await page.state()).authenticated,
    false,
    'anonymous shell never claims verified login',
  );
  check(
    (await page.state()).callsDisabled,
    true,
    'anonymous page explicitly disables telephone functions',
  );
  check(
    await page.evaluate(
      `document.getElementById('start-call')===null && document.getElementById('phone-number')===null`,
    ),
    true,
    'verification page exposes no dialing controls',
  );
  check(
    await page.evaluate(
      `document.getElementById('calls-disabled-notice').textContent.includes('关闭')`,
    ),
    true,
    'page clearly says telephone features are closed',
  );
  check(
    await page.evaluate(`fetch('/api/status').then(r=>r.status)`),
    401,
    'private status rejects an anonymous native browser request',
  );
  check(
    (await page.send('Network.getCookies', { urls: [origin] })).cookies.some(
      (cookie: any) => cookie.name === CLOUD_SESSION_COOKIE,
    ),
    false,
    'no authentication cookie is preinstalled',
  );
  signedOutScreenshot = (
    await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
  ).data;
  await page.evaluate(
    `document.getElementById('google-login').click();document.getElementById('google-login').click();`,
  );
  await eventually(
    async () =>
      (await page.state()).ready === 'true' &&
      (await page.state()).authenticated,
    'Strict Google callback returns verification page',
  );
  check(
    interceptedAuthorizations,
    1,
    'duplicate login click starts one intercepted authorization',
  );
  check(
    providerTokenExchanges,
    1,
    'real token exchange validates the one-use code and PKCE',
  );
  check(
    providerKeyFetches,
    1,
    'actual OIDC validator verifies synthetic RSA provider keys',
  );
  check(
    await page.evaluate('location.href'),
    `${origin}/controlled`,
    'callback returns a clean fixed verification URL',
  );
  check(
    callbackHeaders[0],
    {
      site: 'cross-site',
      mode: 'navigate',
      dest: 'document',
      originPresent: false,
      temporaryCookiePresent: true,
      sessionCookiePresent: false,
    },
    'native cross-site callback uses Lax login binding without an auth cookie',
  );
  check(
    loginCookieBounds,
    {
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      domain: 'phone.example.test',
      session: false,
    },
    'short-lived login cookie is Secure HttpOnly host-only Lax',
  );
  const cookies = (await page.send('Network.getCookies', { urls: [origin] }))
    .cookies;
  const session = cookies.find(
    (cookie: any) => cookie.name === CLOUD_SESSION_COOKIE,
  );
  assert.ok(session);
  check(
    {
      secure: session.secure,
      httpOnly: session.httpOnly,
      sameSite: session.sameSite,
      path: session.path,
      domain: session.domain,
      session: session.session,
    },
    {
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      domain: 'phone.example.test',
      session: true,
    },
    'verified session cookie is Secure HttpOnly host-only Strict',
  );
  check(
    await page.evaluate(
      `document.cookie.includes(${JSON.stringify(CLOUD_SESSION_COOKIE)})`,
    ),
    false,
    'page JavaScript cannot read the session credential',
  );
  const status = await page.evaluate(`fetch('/api/status').then(r=>r.json())`);
  check(
    status,
    {
      mode: 'web-verification',
      authenticated: true,
      callsEnabled: false,
      phoneStatus: 'disabled',
    },
    'authenticated status explicitly preserves web-only mode',
  );
  check(
    (await page.state()).callsDisabled,
    true,
    'a verified login never enables phone controls',
  );
  check(
    await page.evaluate('window.__webVerificationProbe'),
    { microphones: 0, devices: 0, webSockets: 0 },
    'successful login opens no microphone Voice SDK or WebSocket',
  );
  signedInScreenshot = (
    await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
  ).data;
  const prohibited = [
    ['POST', '/api/calls'],
    ['POST', '/api/controller/acquire'],
    ['POST', '/api/controller/renew'],
    ['POST', '/api/controller/revoke'],
    ['POST', '/api/calls/offline-call/voice'],
    ['POST', '/api/calls/offline-call/hangup'],
    ['POST', '/voice/client'],
    ['POST', '/voice/connect'],
    ['POST', '/voice/status'],
    ['POST', '/voice/stream-status'],
    ['GET', '/voice/media'],
  ];
  const denied = await page.evaluate(
    `Promise.all(${JSON.stringify(prohibited)}.map(async([method,path])=>{const response=await fetch(path,{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:'{}'}:{})});return {path,status:response.status};}))`,
  );
  check(
    denied.every((item: any) => item.status === 404),
    true,
    'public web-only ingress exposes no telephone controller grant callback or media routes',
  );
  const internalDenied = await Promise.all(
    prohibited.map(async ([method, path]) => {
      const response = await service!.app.inject({
        method: method as 'GET' | 'POST',
        url: path,
        headers: {
          host: new URL(origin).host,
          origin,
          cookie: `${CLOUD_SESSION_COOKIE}=${session.value}`,
        },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      return { status: response.statusCode, error: response.json().error };
    }),
  );
  check(
    internalDenied,
    prohibited.map(() => ({ status: 403, error: 'CALLS_DISABLED' })),
    'private application also explicitly denies every telephone route for a verified session',
  );
  check(
    await Promise.all(
      ['/voice/media', '/api/events', '/anything'].map(deniedUpgrade),
    ),
    [403, 403, 403],
    'all actual server WebSocket upgrades are disabled',
  );
  check(
    await page.evaluate(`fetch('/api/events').then(r=>r.status>=400)`),
    true,
    'verification service provides no phone event stream',
  );
  check(
    await page.evaluate(
      `fetch('/vendor/twilio.min.js').then(r=>r.status>=400)`,
    ),
    true,
    'verification service serves no Voice SDK',
  );
  const bootstrap = await page.evaluate(
    `fetch('/api/browser-session').then(r=>r.json())`,
  );
  assert.ok(bootstrap.csrfToken);
  check(
    await page.evaluate(
      `fetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`,
    ),
    403,
    'logout requires current session CSRF',
  );
  check(
    await page.evaluate(`fetch('/api/status').then(r=>r.status)`),
    200,
    'rejected logout leaves the verified session current',
  );
  const renewBefore = authWrites.filter(
    (item) => item.path === '/auth/session/renew',
  ).length;
  await page.click('renew-session');
  await eventually(
    () =>
      authWrites.filter((item) => item.path === '/auth/session/renew')
        .length ===
      renewBefore + 1,
    'Explicit login session renewal',
  );
  check(
    (await page.state()).callsDisabled,
    true,
    'session renewal never grants a telephone capability',
  );
  // The shell receives a genuine failed local transport, not a fake response.
  privateApiUnavailable = true;
  await page.click('refresh-status');
  await eventually(
    async () => ['offline', 'unavailable'].includes((await page.state()).phase),
    'Read transport failure retires verified UI state',
  );
  check(
    (await page.state()).authenticated,
    false,
    'a failed read is displayed as unconfirmed rather than authenticated',
  );
  check(
    (await page.state()).callsDisabled,
    true,
    'connection failure keeps all phone functions closed',
  );
  privateApiUnavailable = false;
  await page.click('refresh-status');
  await eventually(
    async () => (await page.state()).authenticated,
    'Native status retry restores the current login',
  );
  check(
    authWrites.filter((item) => item.path === '/auth/session/renew').length,
    renewBefore + 1,
    'read reconnect never renews the authenticated session',
  );
  const logoutBefore = authWrites.filter(
    (item) => item.path === '/auth/logout',
  ).length;
  await page.evaluate(
    `document.getElementById('google-logout').click();document.getElementById('google-logout').click();`,
  );
  await eventually(
    async () =>
      !(await page.state()).authenticated && (await page.state()).loginVisible,
    'Actual logout retires session',
  );
  check(
    authWrites.filter((item) => item.path === '/auth/logout').length -
      logoutBefore,
    1,
    'duplicate logout click sends a single authenticated action',
  );
  check(
    (await page.send('Network.getCookies', { urls: [origin] })).cookies.some(
      (cookie: any) => cookie.name === CLOUD_SESSION_COOKIE,
    ),
    false,
    'logout clears the private session cookie',
  );
  const old = await service.app.inject({
    url: '/api/status',
    headers: {
      host: new URL(origin).host,
      origin,
      cookie: `${CLOUD_SESSION_COOKIE}=${session.value}`,
    },
  });
  check(
    old.statusCode,
    401,
    'revoked old credential cannot read private status',
  );
  await page.send('Page.reload');
  await eventually(
    async () =>
      (await page.state()).ready === 'true' &&
      (await page.state()).loginVisible,
    'Signed-out refresh',
  );
  check(
    (await page.state()).authenticated,
    false,
    'refresh never restores an expired credential',
  );
  await page.send('Page.navigate', { url: lastCallback });
  await eventually(
    () => callbackStatuses.length === 2,
    'Real replayed callback',
  );
  await eventually(
    () =>
      page.evaluate(
        `location.pathname==='/auth/google/callback'&&document.readyState==='complete'&&document.body.textContent.includes('LOGIN_FAILED')`,
      ),
    'Rendered callback rejection',
  );
  check(
    callbackStatuses[1],
    401,
    'a replayed callback cannot reuse its state or exchange code',
  );
  check(
    providerTokenExchanges,
    1,
    'callback replay contacts no provider exchange',
  );
  await page.send('Page.navigate', { url: `${origin}/controlled` });
  await eventually(
    async () =>
      (await page.state()).ready === 'true' &&
      (await page.state()).loginVisible,
    'Shell after callback replay',
  );
  tokenVariant = 'wrong-nonce';
  await page.click('google-login');
  await eventually(
    () => callbackStatuses.length === 3,
    'Signed token with wrong nonce rejected',
  );
  await eventually(
    () =>
      page.evaluate(
        `document.readyState==='complete'&&document.body.textContent.includes('LOGIN_FAILED')`,
      ),
    'Wrong nonce callback rejection rendered',
  );
  check(
    callbackStatuses[2],
    401,
    'valid RSA signature cannot bypass nonce binding',
  );
  check(
    await page.evaluate(`fetch('/api/status').then(r=>r.status)`),
    401,
    'rejected nonce creates no private session',
  );
  tokenVariant = 'wrong-identity';
  await page.send('Page.navigate', { url: `${origin}/controlled` });
  await eventually(
    async () =>
      (await page.state()).ready === 'true' &&
      (await page.state()).loginVisible,
    'Shell after wrong nonce',
  );
  await page.click('google-login');
  await eventually(
    () => callbackStatuses.length === 4,
    'Unconfigured identity denied',
  );
  await eventually(
    () =>
      page.evaluate(
        `document.readyState==='complete'&&document.body.textContent.includes('LOGIN_FAILED')`,
      ),
    'Wrong identity rejection rendered',
  );
  check(
    callbackStatuses[3],
    401,
    'a verified provider identity outside the single configured account is rejected',
  );
  tokenVariant = 'valid';
  await page.send('Page.navigate', { url: `${origin}/controlled` });
  await eventually(
    async () =>
      (await page.state()).ready === 'true' &&
      (await page.state()).loginVisible,
    'Shell after identity denial',
  );
  await page.click('google-login');
  await eventually(
    async () =>
      (await page.state()).ready === 'true' &&
      (await page.state()).authenticated,
    'Second valid login',
  );
  clockOffset += 16 * 60 * 1000;
  await page.click('refresh-status');
  await eventually(
    async () => !(await page.state()).authenticated,
    'Current session idle expiry',
  );
  await eventually(
    async () => (await page.state()).phase === 'expired',
    'Idle expiry explicitly displayed',
  );
  check(
    await page.evaluate(`fetch('/api/status').then(r=>r.status)`),
    401,
    'expired login loses access without restarting the service',
  );
  check(
    (await page.state()).callsDisabled,
    true,
    'expired login leaves no dial control',
  );
  check(
    await page.evaluate('window.__webVerificationProbe'),
    { microphones: 0, devices: 0, webSockets: 0 },
    'all rejection logout and expiry paths create no phone browser resources',
  );
  check(
    requestedPaths.some((path) =>
      [
        '/app.js',
        '/controlled-workbench.js',
        '/controller-client.js',
        '/call-lifecycle.js',
      ].includes(path),
    ),
    false,
    'verification document imports no phone workbench modules',
  );
  check(
    blockedExternalOrigins.size,
    0,
    'all Google authorization navigation is intercepted before external network',
  );
  check(
    supplierCalls,
    0,
    'web verification never invokes a telephone or translation supplier',
  );
  check(faults, [], 'web verification has zero browser and fixture exceptions');
  const provenance = apiProvenance.find((item) => item.path === '/api/status')!;
  check(
    {
      method: provenance.method,
      origin: provenance.origin,
      site: provenance.site,
      mode: provenance.mode,
      dest: provenance.dest,
    },
    {
      method: 'GET',
      origin: null,
      site: 'same-origin',
      mode: 'cors',
      dest: 'empty',
    },
    'private native status request uses real same-origin Fetch Metadata',
  );
  const output = join(repo, '.runtime', 'web-verification-browser');
  await mkdir(output, { recursive: true });
  assert.ok(signedOutScreenshot && signedInScreenshot);
  await writeFile(
    join(output, 'signed-out.png'),
    Buffer.from(signedOutScreenshot, 'base64'),
  );
  await writeFile(
    join(output, 'signed-in.png'),
    Buffer.from(signedInScreenshot, 'base64'),
  );
  const screenshot = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile(
    join(output, 'expired.png'),
    Buffer.from(screenshot.data, 'base64'),
  );
  const result = {
    passed: true,
    checkCount: checks.length,
    checks,
    externalRequests: 0,
    interceptedAuthorizations,
    providerTokenExchanges,
    providerKeyFetches,
    realSupplierCalls: supplierCalls,
    exceptions: faults,
    artifacts: [
      '.runtime/web-verification-browser/signed-out.png',
      '.runtime/web-verification-browser/signed-in.png',
      '.runtime/web-verification-browser/expired.png',
    ],
    browser: await page.send('Browser.getVersion'),
  };
  await writeFile(
    join(output, 'acceptance.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
} finally {
  privateApiUnavailable = false;
  for (const client of clients) client.socket.close();
  const stopBrowser = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && chrome?.pid)
        process.kill(-chrome.pid, signal);
      else chrome?.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit');
    stopBrowser('SIGTERM');
    await Promise.race([exited, pause(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      stopBrowser('SIGKILL');
      await exited;
    }
  }
  if (chrome?.pid && process.platform !== 'win32') stopBrowser('SIGKILL');
  for (const request of upstreamRequests) request.destroy();
  await service?.close();
  await new Promise<void>((done) => proxy.close(() => done()));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
