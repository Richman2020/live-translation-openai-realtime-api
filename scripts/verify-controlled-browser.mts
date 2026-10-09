/** Actual controlled workbench + real routes, with explicit offline suppliers.
 * Temporary TLS key, auth session and signature values belong to this fixture.
 * No JWT, real credentials, model, microphone or telephone is used.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import twilio from 'twilio';
import WebSocket from 'ws';

import {
  CLOUD_SESSION_COOKIE,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import { CloudPhoneAccess } from '../src/solo/cloud-phone-access';
import { CloudControllerLeases } from '../src/solo/controller-lease';
import {
  CloudVoiceJoin,
  type CloudVoiceGrant,
} from '../src/solo/cloud-voice-join';
import { ConfigStore, type SoloConfig } from '../src/solo/config';
import { buildSoloServer } from '../src/solo/server';
import {
  SessionManager,
  type BridgeOptions,
} from '../src/solo/session-manager';

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
const directory = await mkdtemp(join(tmpdir(), 'controlled-phone-offline-'));
const profile = join(directory, 'chrome');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let chrome: ReturnType<typeof spawn> | undefined;
let browserStderr = '';
const faults: string[] = [];
const requests: string[] = [];
const checks: string[] = [];
let conversationScreenshot: string | undefined;
let remoteScreenshot: string | undefined;
const clients: CdpPage[] = [];
const mediaSockets = new Set<WebSocket>();
const eventResponses = new Set<http.ServerResponse>();
const upstreamRequests = new Set<http.ClientRequest>();
const apiRequests: {
  path: string;
  method: string;
  origin: string | null;
  site: string | null;
  mode: string | null;
  dest: string | null;
}[] = [];
const issuedGrants = new Map<string, CloudVoiceGrant>();
const bridges: BridgeOptions[] = [];
const providerCreates: Record<string, unknown>[] = [];
const providerHangups: string[] = [];
const preparations = { voice: 0, public: 0 };
let completedControllerRevocations = 0;
let refreshRevokeGate: ReturnType<typeof deferred> | undefined;
let heldRefreshRevocations = 0;
let refreshHangupReplyGate: ReturnType<typeof deferred> | undefined;
let heldRefreshHangupReplies = 0;
let voiceGate: ReturnType<typeof deferred> | undefined;
let publicGate: ReturnType<typeof deferred> | undefined;
let failHangup = false;
let recoverOnBrowserHangup = false;
let clockOffset = 0;
let sidSequence = 0;
const nextSid = () => `CA${(++sidSequence).toString(16).padStart(32, '0')}`;
const token = Buffer.alloc(32, 81).toString('base64url');
const csrf = Buffer.alloc(32, 82).toString('base64url');
const identity: CloudAuthSession = {
  authSessionId: 'explicit-offline-session',
  principalId: 'explicit-offline-person',
  browserOwnerId: 'explicit-offline-browser',
  epoch: 1,
  issuedAt: Date.now() - 1000,
  absoluteExpiresAt: Date.now() + 3600000,
  idleExpiresAt: Date.now() + 3600000,
  revoked: false,
  csrfToken: csrf,
};
const now = () => Date.now() + clockOffset;
let app: Awaited<ReturnType<typeof buildSoloServer>> | undefined;
let backendPort = 0;
let origin = '';
let config: SoloConfig;

// An explicitly substituted Voice SDK, served at the page's normal SDK URL.
// Its connect travels through the real signed callback and media application.
const fakeSdk = `(() => {
  const fixture = window.__offlineVoice = { devices: 0, connects: 0, disconnects: 0, registers: 0, muted: false, hold: false, waiting: null, deferAccept: false, pendingAccept: null, rejectNext: false, mediaTransfers: 0, streams: [] };
  class Emitter { constructor() { this.listeners = new Map(); } on(name, fn) { const all=this.listeners.get(name)||[]; all.push(fn); this.listeners.set(name,all); return this; } off(name, fn) { this.listeners.set(name,(this.listeners.get(name)||[]).filter(item=>item!==fn)); return this; } removeListener(name, fn) { return this.off(name,fn); } emit(name,...args) { for(const fn of this.listeners.get(name)||[]) fn(...args); } }
  class Call extends Emitter { constructor(stream){super();this.stream=stream;} disconnect() { if(this.closed)return;this.closed=true;for(const track of this.stream?.getTracks()||[])track.stop();fixture.disconnects++;this.emit('disconnect'); } mute(value) { fixture.muted=value;this.emit('mute',value); } status() { return this.closed?'closed':'open'; } }
  class Device extends Emitter {
    constructor(token,options={}) { super(); if(!token.startsWith('offline-browser-fake-'))throw new Error('Only fixture tokens are accepted');this.token=token;this.options=options;fixture.devices++;fixture.lastDevice=this; }
    async register() { fixture.registers++;throw new Error('Global registration must not occur'); }
    async connect(options) {
      fixture.connects++;
      if(fixture.rejectNext){fixture.rejectNext=false;throw new Error('Explicit offline SDK failure');}
      this.stream=await this.options.getUserMedia({audio:true});fixture.mediaTransfers++;fixture.streams.push(this.stream);
      const response=await fetch('/__offline_fixture/voice-client',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:this.token,params:options.params})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Fixture join rejected');
      if(fixture.hold)await new Promise(done=>{fixture.waiting=done;});
      const call=new Call(this.stream);fixture.lastCall=call;if(fixture.deferAccept)fixture.pendingAccept=()=>call.emit('accept');else setTimeout(()=>call.emit('accept'),20);return call;
    }
    destroy() { this.destroyed=true;for(const track of this.stream?.getTracks()||[])track.stop(); }
    disconnectAll() { fixture.lastCall?.disconnect(); }
  }
  window.Twilio={Device};
})();`;

class CdpPage {
  targetId: string;
  socket: WebSocket;
  nextId = 0;
  pending = new Map<
    number,
    { done: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(url: string, targetId: string) {
    this.targetId = targetId;
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      const value = JSON.parse(String(data));
      if (value.id) {
        const pending = this.pending.get(value.id);
        this.pending.delete(value.id);
        value.error
          ? pending?.reject(new Error(value.error.message))
          : pending?.done(value.result);
      } else if (value.method === 'Runtime.exceptionThrown')
        faults.push(
          value.params.exceptionDetails.exception?.description ||
            value.params.exceptionDetails.text,
        );
      else if (value.method === 'Network.requestWillBeSent')
        requests.push(value.params.request.url);
    });
  }
  async ready() {
    await once(this.socket, 'open');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Page.enable');
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
    if (value.exceptionDetails)
      throw new Error(
        value.exceptionDetails.exception?.description ||
          value.exceptionDetails.text,
      );
    return value.result.value;
  }
  async foreground() {
    await this.send('Page.bringToFront');
    await eventually(
      () => this.evaluate('!document.hidden'),
      'Visible test tab',
    );
    await pause(30);
  }
  async click(id: string) {
    await this.foreground();
    try {
      await eventually(
        () =>
          this.evaluate(
            `!document.getElementById(${JSON.stringify(id)}).disabled`,
          ),
        `Enabled DOM action: ${id}`,
      );
    } catch (error) {
      throw new Error(
        `${String(error)} Public page state: ${JSON.stringify(await this.state())}`,
      );
    }
    await this.evaluate(
      `document.getElementById(${JSON.stringify(id)}).click()`,
    );
  }
  async state() {
    return this.evaluate(
      `({ready:document.documentElement.dataset.phoneReady, acquire:!document.getElementById('enable-device').disabled, acquireText:document.getElementById('enable-device').textContent, start:!document.getElementById('start-call').disabled, end:!document.getElementById('end-call').disabled, mute:!document.getElementById('mute-button').disabled, error:document.getElementById('app-error').textContent, connection:document.getElementById('connection-text').textContent, engine:document.getElementById('translation-engine').value, title:document.getElementById('readiness-title').textContent})`,
    );
  }
}

async function eventually<T>(
  action: () => Promise<T> | T,
  label: string,
  timeout = 12000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) {
      last = String(error);
    }
    if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null))
      throw new Error(`${label}: Chromium exited. ${browserStderr}`);
    await pause(40);
  }
  throw new Error(`${label}: timed out. ${last} ${browserStderr}`);
}
function check(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  checks.push(label);
}
async function signed(path: string, fields: Record<string, string>) {
  const body = { AccountSid: config.TWILIO_ACCOUNT_SID, ...fields };
  return app!.inject({
    method: 'POST',
    url: path,
    headers: {
      host: new URL(origin).host,
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(
        config.TWILIO_AUTH_TOKEN,
        `${origin}${path}`,
        body,
      ),
    },
    payload: new URLSearchParams(body).toString(),
  });
}
async function attach(xml: string, sid: string) {
  if (!xml.includes('<Stream') && /<(?:Hangup|Reject)\b/.test(xml)) return;
  const parameters = Object.fromEntries(
    [...xml.matchAll(/<Parameter name="([^"]+)" value="([^"]+)"\s*\/>/g)].map(
      (item) => [item[1], item[2]],
    ),
  );
  assert.ok(
    parameters.sessionId && parameters.role && parameters.nonce,
    'Real TwiML contains stream correlation',
  );
  const socket = new WebSocket(`ws://127.0.0.1:${backendPort}/voice/media`, {
    headers: {
      host: new URL(origin).host,
      'x-twilio-signature': twilio.getExpectedTwilioSignature(
        config.TWILIO_AUTH_TOKEN,
        `${origin}/voice/media`,
        {},
      ),
    },
  });
  mediaSockets.add(socket);
  socket.on('error', () => undefined);
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      event: 'start',
      start: {
        accountSid: config.TWILIO_ACCOUNT_SID,
        callSid: sid,
        streamSid: `MZ${sid.slice(2)}`,
        customParameters: parameters,
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
      },
    }),
  );
  await pause(25);
}

const proxy = https.createServer(async (request, response) => {
  const path = new URL(
    request.url || '/',
    origin || 'https://phone.example.test',
  ).pathname;
  if (path === '/vendor/twilio.min.js') {
    response
      .writeHead(200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'no-store',
      })
      .end(fakeSdk);
    return;
  }
  if (path === '/__offline_fixture/voice-client') {
    try {
      let payload = '';
      for await (const bytes of request) {
        payload += bytes.toString();
        assert.ok(payload.length < 16000);
      }
      const input = JSON.parse(payload);
      const grant = issuedGrants.get(input.token);
      assert.ok(grant, 'Explicit fake signer issued this token');
      const sid = nextSid();
      const joined = await signed('/voice/client', {
        ...input.params,
        From: `client:${grant.identity}`,
        CallSid: sid,
      });
      if (joined.statusCode !== 200) {
        response
          .writeHead(joined.statusCode, { 'Content-Type': 'application/json' })
          .end(joined.body);
        return;
      }
      await attach(joined.body, sid);
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"ok":true}');
    } catch (error) {
      faults.push(`Offline Voice fixture: ${String(error)}`);
      response
        .writeHead(500, { 'Content-Type': 'application/json' })
        .end('{"error":"OFFLINE_JOIN_FAILED"}');
    }
    return;
  }
  if (path.startsWith('/api/'))
    apiRequests.push({
      path: request.url!,
      method: request.method!,
      origin: request.headers.origin || null,
      site: (request.headers['sec-fetch-site'] as string) || null,
      mode: (request.headers['sec-fetch-mode'] as string) || null,
      dest: (request.headers['sec-fetch-dest'] as string) || null,
    });
  const refreshGate =
    path === '/api/controller/revoke' ? refreshRevokeGate : undefined;
  if (refreshGate) {
    // Only the refresh scenario delays forwarding the real pagehide revoke.
    // Hangup, the new document's bootstrap and every backend response stay real.
    heldRefreshRevocations += 1;
    await refreshGate.promise;
  }
  // The supplier recovers only when the real retry request reaches the proxy.
  // Background cleanup attempts keep failing until then; no API response is replaced.
  if (
    recoverOnBrowserHangup &&
    request.method === 'POST' &&
    /^\/api\/calls\/[^/]+\/hangup$/.test(path)
  ) {
    failHangup = false;
    recoverOnBrowserHangup = false;
  }
  if (path === '/api/events') {
    eventResponses.add(response);
    response.once('close', () => eventResponses.delete(response));
  }
  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: backendPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    async (stream) => {
      if (path === '/api/controller/revoke' && stream.statusCode === 200)
        stream.once('end', () => {
          completedControllerRevocations += 1;
        });
      const replyGate = /\/hangup$/.test(path)
        ? refreshHangupReplyGate
        : undefined;
      if (replyGate) {
        heldRefreshHangupReplies += 1;
        await replyGate.promise;
      }
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
  config = {
    API_HOST: '127.0.0.1',
    API_PORT: '5050',
    PUBLIC_BASE_URL: origin,
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'b'.repeat(32),
    TWILIO_API_KEY_SID: `SK${'c'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'd'.repeat(32),
    TWILIO_TWIML_APP_SID: `AP${'e'.repeat(32)}`,
    TWILIO_CALLER_NUMBER: '+12125550123',
    OPENAI_API_KEY: `sk-offline-${'f'.repeat(32)}`,
    OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
    OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
    OPENAI_PROXY_URL: '',
    LOCAL_ACCESS_TOKEN: 't'.repeat(64),
  };
  const manager = new SessionManager({
    providerFactory: () => ({
      create: async (parameters) => {
        providerCreates.push(parameters);
        const sid = nextSid();
        setTimeout(async () => {
          try {
            const url = new URL(parameters.url as string);
            const connected = await signed(url.pathname + url.search, {
              CallSid: sid,
            });
            assert.equal(connected.statusCode, 200);
            await attach(connected.body, sid);
          } catch (error) {
            faults.push(`Offline remote provider: ${String(error)}`);
          }
        }, 25);
        return { sid };
      },
      hangup: async (sid) => {
        providerHangups.push(sid);
        if (failHangup) throw new Error('Explicit offline cleanup failure');
      },
    }),
    bridgeFactory: (parameters) => {
      bridges.push(parameters);
      return {
        attach: (role) => {
          parameters.onConnection?.({ role, state: 'ready' });
          if (role === 'remote')
            parameters.onCaptionState?.({ state: 'ready' });
        },
        close() {},
      };
    },
    setupTimeoutMs: 30000,
  });
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    now,
    resolveSession: (credential) =>
      credential === token ? { ...identity } : null,
  });
  const leases = new CloudControllerLeases({ policy, now, ttlMs: 30000 });
  const voiceJoin = new CloudVoiceJoin({
    policy,
    now,
    outgoingApplicationSid: config.TWILIO_TWIML_APP_SID,
    signer: async (grant) => {
      const fake = `offline-browser-fake-${issuedGrants.size + 1}`;
      issuedGrants.set(fake, grant);
      return fake;
    },
    admission: {
      reserve: async () => {
        preparations.voice++;
        const gate = voiceGate;
        if (gate) await gate.promise;
        return { assertCurrent() {}, release: async () => undefined };
      },
    },
  });
  const access = new CloudPhoneAccess({
    policy,
    manager,
    controllerLeases: leases,
    voiceJoin,
    publicReadinessChecker: async () => {
      preparations.public++;
      const gate = publicGate;
      if (gate) await gate.promise;
      return { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
    },
    translationReadinessChecker: async () => ({
      name: 'explicit-offline-translation',
      status: 'passed',
      code: 'OFFLINE_READY',
    }),
    revalidationIntervalMs: 1000,
  });
  app = await buildSoloServer({
    configStore: new ConfigStore({
      envPath: join(directory, '.env'),
      values: config,
      generateToken: false,
    }),
    sessionManager: manager,
    browserControl: access,
    publicDir: join(repo, 'public'),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const backend = app.server.address();
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
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
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
    browserStderr = (
      browserStderr +
      String(bytes).replace(
        /DevTools listening on[^\r\n]*/g,
        '[DevTools ready]',
      )
    ).slice(-4000);
  });
  chrome.on('error', (error) => faults.push(String(error)));
  const port = await eventually(
    async () =>
      Number(
        (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(
          '\n',
        )[0],
      ),
    'Chromium startup',
    30000,
  );
  async function openPage() {
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
      })
    ).json();
    const page = new CdpPage(target.webSocketDebuggerUrl, target.id);
    clients.push(page);
    await page.ready();
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Network.setCookie', {
      name: CLOUD_SESSION_COOKIE,
      value: token,
      url: `${origin}/`,
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    await page.send('Page.navigate', { url: `${origin}/controlled` });
    await eventually(
      async () => (await page.state()).ready === 'true',
      'Actual controlled page bootstrap',
    );
    return page;
  }
  const page = await openPage();
  check(
    await page.evaluate(`document.documentElement.dataset.phoneSurface`),
    'controlled',
    'real index serves the isolated controlled entry',
  );
  check(
    (await page.state()).start,
    false,
    'initial page has read access and no dialing controls',
  );
  check(
    (await page.state()).engine,
    'pocket-prefix',
    'controlled page defaults to fixed Pocket outgoing voice and original-English return',
  );
  await page.click('enable-device');
  await eventually(
    async () => (await page.state()).start,
    'Controller acquired',
  );
  const observer = await openPage();
  check(
    (await observer.state()).start,
    false,
    'second real tab remains read-only while the first controls',
  );
  check(
    (await observer.state()).acquire,
    false,
    'read-only tab cannot offer acquisition while another tab holds control',
  );
  check(
    await page.evaluate('window.__offlineVoice.devices'),
    0,
    'controller acquire creates no global Voice token or SDK registration',
  );
  const renewBefore = apiRequests.filter(
    (item) => item.path === '/api/controller/renew',
  ).length;
  await page.click('renew-control');
  await eventually(
    () =>
      apiRequests.filter((item) => item.path === '/api/controller/renew')
        .length ===
      renewBefore + 1,
    'Explicit controller renew',
  );
  check(
    await page.evaluate('window.__offlineVoice.registers'),
    0,
    'renew performs no global SDK registration',
  );
  async function dial(target = page) {
    await target.foreground();
    await target.evaluate(
      `document.getElementById('phone-number').value='+12125550124'; document.getElementById('phone-number').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('start-call').click();document.getElementById('start-call').click();`,
    );
  }
  const createBefore = apiRequests.filter(
    (item) => item.path === '/api/calls' && item.method === 'POST',
  ).length;
  await dial();
  await eventually(
    () => manager.activeSession?.status === 'active' && bridges.length > 0,
    'Real signed two-leg call',
  );
  await eventually(
    async () => (await page.state()).mute,
    'Page accepts real call state',
  );
  check(
    apiRequests.filter(
      (item) => item.path === '/api/calls' && item.method === 'POST',
    ).length - createBefore,
    1,
    'duplicate DOM click creates only one server reservation',
  );
  check(
    providerCreates.length,
    1,
    'actual join and bridge readiness trigger one fake dial',
  );
  check(
    await page.evaluate('window.__offlineVoice.connects'),
    1,
    'per-call permit drives a single SDK connect',
  );
  check(
    await page.evaluate('window.__offlineVoice.mediaTransfers'),
    1,
    'fake SDK consumes the actual page prepared synthetic stream once',
  );
  await page.evaluate(
    'window.__offlineVoice.lastDevice.emit("tokenWillExpire")',
  );
  await pause(30);
  check(
    manager.activeSession?.status,
    'active',
    'short join token expiry notification cannot end an already joined call',
  );
  check(
    (await observer.state()).start,
    false,
    'observer cannot take control of an active call',
  );
  const bridge = bridges.at(-1)!;
  const at = Date.now();
  bridge.onConversationTranscript?.({
    id: 'browser-local',
    utteranceId: 'browser-local',
    role: 'local',
    kind: 'original',
    text: '不是十五美元，是五十美元以内。',
    final: true,
    at,
    pairing: 'explicit',
    boundary: 'semantic',
  });
  bridge.onConversationTranscript?.({
    id: 'browser-local',
    utteranceId: 'browser-local',
    role: 'local',
    kind: 'translation',
    text: 'Not fifteen dollars; under fifty dollars.',
    final: true,
    at,
    pairing: 'explicit',
    boundary: 'semantic',
  });
  bridge.onTranscript?.({
    id: 'browser-remote',
    utteranceId: 'browser-remote',
    role: 'remote',
    kind: 'original',
    text: 'We can do that.',
    final: true,
    at: at + 1,
    pairing: 'explicit',
  });
  bridge.onTranscript?.({
    id: 'browser-remote',
    utteranceId: 'browser-remote',
    role: 'remote',
    kind: 'translation',
    text: '我们可以做到。',
    final: true,
    at: at + 1,
    pairing: 'explicit',
  });
  await eventually(
    () =>
      page.evaluate(
        `document.querySelectorAll('article[data-utterance-id]').length===2`,
      ),
    'Native SSE paired captions',
  );
  check(
    await page.evaluate(
      `[...document.querySelectorAll('article[data-utterance-id]')].map(row=>({id:row.dataset.utteranceId,original:row.querySelector('.conversation-original .transcript-text').textContent,translation:row.querySelector('.conversation-translation .transcript-text').textContent}))`,
    ),
    [
      {
        id: 'browser-local',
        original: '不是十五美元，是五十美元以内。',
        translation: 'Not fifteen dollars; under fifty dollars.',
      },
      {
        id: 'browser-remote',
        original: 'We can do that.',
        translation: '我们可以做到。',
      },
    ],
    'actual alternating conversation cards pair each original and translation',
  );
  const screenshotScroll = await page.evaluate('window.scrollY');
  await page.evaluate(
    `document.getElementById('transcript-scroll').scrollTop=0; document.querySelector('.transcript-card').scrollIntoView({block:'center'});`,
  );
  await pause(50);
  conversationScreenshot = (
    await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
  ).data;
  await page.click('conversation-latest');
  await pause(50);
  remoteScreenshot = (
    await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
  ).data;
  await page.evaluate(`window.scrollTo(0,${screenshotScroll})`);
  const readonlyWrites = apiRequests.filter(
    (item) =>
      item.method === 'POST' &&
      (item.path === '/api/controller/revoke' || /\/hangup$/.test(item.path)),
  ).length;
  await observer.foreground();
  await observer.evaluate(
    `document.querySelector('[data-view="history"]').click();`,
  );
  await pause(80);
  check(
    apiRequests.filter(
      (item) =>
        item.method === 'POST' &&
        (item.path === '/api/controller/revoke' || /\/hangup$/.test(item.path)),
    ).length,
    readonlyWrites,
    'read-only history navigation sends no hangup or revoke requests',
  );
  check(
    manager.activeSession?.status,
    'active',
    'observer navigation cannot end the controller call',
  );
  await observer.evaluate(
    `document.querySelector('[data-view="workspace"]').click();`,
  );
  await page.foreground();
  await page.click('mute-button');
  check(
    await page.evaluate('window.__offlineVoice.muted'),
    true,
    'page mute controls only its current SDK call',
  );
  await page.click('end-call');
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Real two-leg hangup',
  );
  await eventually(async () => !(await page.state()).end, 'Hangup UI settles');
  check(
    new Set(providerHangups).size,
    2,
    'both fake provider legs are cleaned by actual hangup',
  );
  check(
    (await page.state()).mute,
    false,
    'finished call has no usable microphone control',
  );
  check(
    await page.evaluate(
      'window.__offlineVoice.streams[0].getTracks().every(track=>track.readyState==="ended")',
    ),
    true,
    'SDK and page cleanup stop the owned synthetic capture tracks',
  );
  const renewCount = apiRequests.filter(
    (item) => item.path === '/api/controller/renew',
  ).length;
  const eventsCount = apiRequests.filter(
    (item) => item.path === '/api/events',
  ).length;
  for (const response of eventResponses) response.destroy();
  await eventually(
    () =>
      apiRequests.filter((item) => item.path === '/api/events').length >
      eventsCount,
    'Native EventSource reconnect',
    10000,
  );
  check(
    apiRequests.filter((item) => item.path === '/api/controller/renew').length,
    renewCount,
    'SSE reconnect never renews controller lease',
  );
  // Reserve is delayed in the injected real admission port, rather than fake API responses.
  voiceGate = deferred();
  const voiceBefore = preparations.voice;
  const sdkBefore = await page.evaluate('window.__offlineVoice.connects');
  await dial();
  await eventually(
    () => preparations.voice > voiceBefore,
    'Voice preparation pending',
  );
  await page.click('end-call');
  voiceGate.resolve();
  voiceGate = undefined;
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Cancelled preparation cleanup',
  );
  await eventually(
    async () => !(await page.state()).end,
    'Cancelled preparation UI settles',
  );
  check(
    await page.evaluate('window.__offlineVoice.connects'),
    sdkBefore,
    'cancelled async Voice preparation cannot call SDK',
  );
  check(
    providerCreates.length,
    1,
    'cancel before join dials no additional provider call',
  );
  await eventually(
    async () => (await page.state()).start,
    'Controller ready after cancellation',
  );
  await page.evaluate('window.__offlineVoice.hold=true');
  const lateCreates = providerCreates.length;
  await dial();
  await eventually(
    () => page.evaluate('typeof window.__offlineVoice.waiting === "function"'),
    'SDK connect pending after actual join',
  );
  await page.click('end-call');
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Late SDK call cleanup',
  );
  await page.evaluate(
    'window.__offlineVoice.hold=false;window.__offlineVoice.waiting();window.__offlineVoice.waiting=null',
  );
  await eventually(
    () => page.evaluate('window.__offlineVoice.lastCall?.closed===true'),
    'Late SDK result disconnected',
  );
  check(
    providerCreates.length - lateCreates,
    1,
    'late SDK response cannot create another provider call',
  );
  check(
    (await page.state()).mute,
    false,
    'late SDK result never restores a microphone control',
  );
  // A short, real SSE outage during pending SDK work must permanently fence
  // that attempt, even if the native read connection resumes before SDK returns.
  await eventually(
    async () => (await page.state()).start,
    'Controller before pending SDK outage',
  );
  await page.evaluate('window.__offlineVoice.hold=true');
  await dial();
  await eventually(
    () => page.evaluate('typeof window.__offlineVoice.waiting === "function"'),
    'SDK pending before actual stream outage',
  );
  const interruptedHangups = providerHangups.length;
  const interruptedEvents = apiRequests.filter(
    (item) => item.path === '/api/events',
  ).length;
  const interruptedRenewals = apiRequests.filter(
    (item) => item.path === '/api/controller/renew',
  ).length;
  for (const response of eventResponses) response.destroy();
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Pending SDK outage cleanup',
  );
  await eventually(
    () =>
      apiRequests.filter((item) => item.path === '/api/events').length >
      interruptedEvents,
    'Native reconnect after pending SDK outage',
  );
  await page.evaluate(
    'window.__offlineVoice.hold=false;window.__offlineVoice.waiting();window.__offlineVoice.waiting=null',
  );
  await eventually(
    () => page.evaluate('window.__offlineVoice.lastCall?.closed===true'),
    'Interrupted SDK late return discarded',
  );
  const interrupted = await page.state();
  check(
    { start: interrupted.start, mute: interrupted.mute },
    { start: false, mute: false },
    'short read outage cannot revive pending SDK controls after reconnect',
  );
  check(
    providerHangups.length - interruptedHangups,
    2,
    'pending SDK connection loss cleans both joined fake legs',
  );
  check(
    apiRequests.filter((item) => item.path === '/api/controller/renew').length,
    interruptedRenewals,
    'pending SDK reconnect performs no implicit controller renewal',
  );
  await page.click('enable-device');
  await eventually(
    async () => (await page.state()).start,
    'Explicit controller after pending SDK outage',
  );
  await dial();
  await eventually(
    async () =>
      manager.activeSession?.status === 'active' && (await page.state()).mute,
    'Accepted SDK call before hiding',
  );
  const hiddenHangups = providerHangups.length;
  await observer.foreground();
  await eventually(
    () => page.evaluate('document.hidden'),
    'Accepted owner tab hidden',
  );
  await page.evaluate('window.__offlineVoice.lastCall.disconnect()');
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Hidden accepted SDK disconnect cleanup',
  );
  await page.foreground();
  await eventually(
    async () => !(await page.state()).mute && !(await page.state()).start,
    'Hidden SDK disconnect controls retired',
  );
  check(
    providerHangups.length - hiddenHangups,
    2,
    'accepted SDK disconnect while hidden still cleans both provider legs',
  );
  check(
    (await page.state()).mute,
    false,
    'returning to a disconnected SDK tab cannot revive mute',
  );
  await page.click('enable-device');
  await eventually(
    async () => (await page.state()).start,
    'Explicit controller after hidden SDK disconnect',
  );
  // A real navigation while create readiness awaits revokes the captured lease.
  await eventually(
    async () => (await page.state()).start,
    'Controller ready before navigation',
  );
  publicGate = deferred();
  const readinessBefore = preparations.public;
  const navigationSdk = await page.evaluate('window.__offlineVoice.connects');
  await dial();
  await eventually(
    () => preparations.public > readinessBefore,
    'Create readiness pending',
  );
  await page.foreground();
  await page.evaluate(
    `document.querySelector('[data-view="history"]').click()`,
  );
  publicGate.resolve();
  publicGate = undefined;
  await eventually(
    () =>
      !access.browserSession(
        policy.authenticate(
          {
            host: new URL(origin).host,
            origin,
            cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
          },
          'read',
          { surface: 'http', method: 'GET' },
        ),
      ).busy,
    'Navigation cleanup',
  );
  await eventually(
    async () => !(await page.state()).start,
    'Navigation retires controls',
  );
  check(
    await page.evaluate('window.__offlineVoice.connects'),
    navigationSdk,
    'late readiness result after navigation cannot construct a Voice connection',
  );
  check(
    await page.evaluate('document.getElementById("history-view").hidden'),
    false,
    'actual navigation reaches history with no retained control',
  );
  await page.evaluate(
    `document.querySelector('[data-view="workspace"]').click()`,
  );
  await page.click('enable-device');
  await eventually(
    async () => (await page.state()).start,
    'New controller after navigation',
  );
  // A failure is a real SDK rejection after real per-call preparation.
  const failureCreates = providerCreates.length;
  await page.evaluate('window.__offlineVoice.rejectNext=true');
  await dial();
  await eventually(
    async () =>
      !(await page.state()).start && Boolean((await page.state()).error),
    'SDK failure reported',
  );
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'SDK failure cleanup',
  );
  check(
    providerCreates.length,
    failureCreates,
    'SDK failure never dials the fake telephone provider',
  );
  check(
    (await page.state()).mute,
    false,
    'SDK failure leaves no usable microphone button',
  );
  await page.click('enable-device');
  await eventually(
    async () => (await page.state()).start,
    'Controller before uncertain cleanup',
  );
  await dial();
  await eventually(
    async () =>
      manager.activeSession?.status === 'active' && (await page.state()).mute,
    'Call before uncertain cleanup',
  );
  failHangup = true;
  await page.click('end-call');
  await eventually(
    () => manager.activeSession?.cleanupUnconfirmed === true,
    'Provider cleanup unconfirmed',
  );
  await eventually(
    async () => (await page.state()).connection === '线路关闭待确认',
    'Unconfirmed cleanup UI',
  );
  const uncertain = await page.state();
  check(
    { start: uncertain.start, mute: uncertain.mute },
    { start: false, mute: false },
    'unconfirmed two-leg cleanup blocks dialing and microphone controls',
  );
  check(
    uncertain.connection,
    '线路关闭待确认',
    'failed cleanup never reports a completed call',
  );
  const retryBefore = apiRequests.filter((item) =>
    /^\/api\/calls\/[^/]+\/hangup$/.test(item.path),
  ).length;
  recoverOnBrowserHangup = true;
  await page.click('end-call');
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Actual page retry confirms failed provider cleanup',
  );
  await page.click('refresh-controlled-state');
  check(
    apiRequests.filter((item) =>
      /^\/api\/calls\/[^/]+\/hangup$/.test(item.path),
    ).length - retryBefore,
    1,
    'page retries uncertain cleanup through the actual hangup route',
  );
  // Refresh/navigation loses in-memory control and explicitly retires its lease.
  await eventually(
    async () => (await page.state()).start,
    'Controller before active refresh',
  );
  // Keep SDK acceptance pending while both real application legs are active.
  // Reload must preserve cleanup capabilities even in this earlier UI phase.
  await page.evaluate('window.__offlineVoice.deferAccept = true');
  await dial();
  await eventually(
    async () =>
      manager.activeSession?.status === 'active' &&
      (await page.evaluate(
        "Boolean(window.__offlineVoice.pendingAccept) && document.documentElement.dataset.controllerPhase === 'connecting' && document.getElementById('mute-button').disabled",
      )),
    'Both live legs with actual SDK acceptance still pending before reload',
  );
  const refreshHangups = providerHangups.length;
  const refreshHangupRequests = apiRequests.filter((item) =>
    /\/hangup$/.test(item.path),
  ).length;
  const refreshRevokeRequests = apiRequests.filter(
    (item) => item.path === '/api/controller/revoke',
  ).length;
  const beforeReloadPhase = await page.evaluate(
    'document.documentElement.dataset.controllerPhase',
  );
  const oldDocumentTimeOrigin = await page.evaluate('performance.timeOrigin');
  const refreshRevocations = completedControllerRevocations;
  const heldBeforeRefresh = heldRefreshRevocations;
  const heldRepliesBeforeRefresh = heldRefreshHangupReplies;
  const controllerStatus = () =>
    leases.status(
      policy.authenticate(
        {
          host: new URL(origin).host,
          origin,
          cookie: `${CLOUD_SESSION_COOKIE}=${token}`,
        },
        'read',
        { surface: 'http', method: 'GET' },
      ),
    );
  refreshRevokeGate = deferred();
  refreshHangupReplyGate = deferred();
  try {
    // A native visibility change cancels the still-connecting owner. Its real
    // hangup reaches the backend, but the response remains pending across
    // unload: disposal must start the captured revoke without awaiting it.
    await observer.foreground();
    await eventually(
      async () =>
        (await page.evaluate('document.hidden')) &&
        heldRefreshHangupReplies > heldRepliesBeforeRefresh &&
        !manager.controlAdmissionBlocked,
      'Connecting owner becomes hidden with real hangup response still pending',
    );
    await page.send('Page.reload');
    await eventually(
      async () =>
        (await page.evaluate('performance.timeOrigin')) !==
          oldDocumentTimeOrigin && (await page.state()).ready === 'true',
      'Actual refresh',
    );
    await eventually(
      () =>
        heldRefreshRevocations > heldBeforeRefresh &&
        !manager.controlAdmissionBlocked,
      'Pagehide hangup cleans both legs before held revoke is forwarded',
    );
    await eventually(
      async () =>
        (await page.state()).title === '只读标签页 · 控制权在其他页面',
      'New document reads the still-held old controller',
    );
    const heldState = await page.state();
    check(
      {
        serverMode: controllerStatus().mode,
        acquire: heldState.acquire,
        start: heldState.start,
      },
      { serverMode: 'held', acquire: false, start: false },
      'completed hangup with delayed real revoke leaves refreshed page safely read-only',
    );
    check(
      {
        hangups:
          apiRequests.filter((item) => /\/hangup$/.test(item.path)).length -
          refreshHangupRequests,
        revokes:
          apiRequests.filter((item) => item.path === '/api/controller/revoke')
            .length - refreshRevokeRequests,
      },
      { hangups: 1, revokes: 1 },
      'hidden connecting owner unload reuses pending hangup and dispatches one captured revoke',
    );
  } catch (error) {
    const currentTimeOrigin = await page
      .evaluate('performance.timeOrigin')
      .catch(() => null);
    const currentPhase = await page
      .evaluate('document.documentElement.dataset.controllerPhase')
      .catch(() => null);
    const browser = await page.send('Browser.getVersion').catch(() => ({}));
    console.error(
      JSON.stringify({
        controlledRefreshDiagnostic: {
          heldRevocationDelta: heldRefreshRevocations - heldBeforeRefresh,
          heldHangupReplyDelta:
            heldRefreshHangupReplies - heldRepliesBeforeRefresh,
          controlAdmissionBlocked: manager.controlAdmissionBlocked,
          controllerMode: controllerStatus().mode,
          providerHangupDelta: providerHangups.length - refreshHangups,
          hangupRequestDelta:
            apiRequests.filter((item) => /\/hangup$/.test(item.path)).length -
            refreshHangupRequests,
          revokeRequestDelta:
            apiRequests.filter((item) => item.path === '/api/controller/revoke')
              .length - refreshRevokeRequests,
          completedRevocationDelta:
            completedControllerRevocations - refreshRevocations,
          oldDocumentTimeOrigin,
          currentTimeOrigin,
          newDocument: currentTimeOrigin !== oldDocumentTimeOrigin,
          beforeReloadPhase,
          currentPhase,
          browser: browser.product || 'unknown',
        },
      }),
    );
    throw error;
  } finally {
    refreshRevokeGate.resolve();
    refreshRevokeGate = undefined;
    refreshHangupReplyGate.resolve();
    refreshHangupReplyGate = undefined;
  }
  // Hangup and revoke are independent keepalive requests. A new document can
  // read the old lease before its revocation completes; that safe read-only
  // hint is not refreshed merely because provider cleanup has finished.
  await eventually(
    () =>
      completedControllerRevocations > refreshRevocations &&
      controllerStatus().mode === 'available',
    'Pagehide revocation completes and retires old controller',
  );
  check(
    providerHangups.length - refreshHangups,
    2,
    'actual page reload requests cleanup for both live legs',
  );
  check(
    (await page.state()).start,
    false,
    'refresh cannot recover a controller capability from storage',
  );
  await page.click('refresh-controlled-state');
  await eventually(
    async () => (await page.state()).acquire,
    'Explicit refresh confirms controller availability',
  );
  check(
    {
      acquire: (await page.state()).acquire,
      start: (await page.state()).start,
    },
    { acquire: true, start: false },
    'confirmed revoke and actual state refresh enable only explicit controller acquisition',
  );
  await page.click('enable-device');
  await eventually(
    async () => (await page.state()).start,
    'Controller after refresh',
  );
  await dial();
  await eventually(
    () => manager.activeSession?.status === 'active',
    'Second controlled call',
  );
  const expiredBefore = providerHangups.length;
  clockOffset += 60000;
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Control expiry two-leg cleanup',
  );
  await eventually(
    async () => !(await page.state()).start && !(await page.state()).mute,
    'Expired controller UI',
  );
  check(
    providerHangups.length - expiredBefore,
    2,
    'control expiry cleans both live legs without relying on SSE renewal',
  );
  await observer.click('refresh-controlled-state');
  await observer.click('enable-device');
  await eventually(
    async () => (await observer.state()).start,
    'Observer explicitly acquires after expiry',
  );
  await dial(observer);
  await eventually(
    () => manager.activeSession?.status === 'active',
    'Actual close fixture active',
  );
  const closeHangups = providerHangups.length;
  const closed = await fetch(
    `http://127.0.0.1:${port}/json/close/${observer.targetId}`,
  );
  assert.ok(closed.ok);
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Actual target close pagehide cleanup',
  );
  check(
    providerHangups.length - closeHangups,
    2,
    'closing the actual browser tab requests cleanup for both live legs',
  );
  // Explicit revoked login is exercised by the actual bootstrap endpoint.
  identity.revoked = true;
  await page.send('Page.reload');
  await eventually(
    async () => (await page.state()).ready === 'true',
    'Revoked login bootstrap',
  );
  const revokedState = await page.state();
  check(
    {
      start: revokedState.start,
      mute: revokedState.mute,
      end: revokedState.end,
    },
    { start: false, mute: false, end: false },
    'missing current login leaves every call action disabled',
  );
  const getHeaders = apiRequests.find((item) =>
    item.path.startsWith('/api/browser-session'),
  )!;
  check(
    {
      method: getHeaders.method,
      origin: getHeaders.origin,
      site: getHeaders.site,
      mode: getHeaders.mode,
      dest: getHeaders.dest,
    },
    {
      method: 'GET',
      origin: null,
      site: 'same-origin',
      mode: 'cors',
      dest: 'empty',
    },
    'native Chrome bootstrap GET uses actual same-origin metadata without forged Origin',
  );
  const sseHeaders = apiRequests.find((item) => item.path === '/api/events')!;
  check(
    {
      method: sseHeaders.method,
      origin: sseHeaders.origin,
      site: sseHeaders.site,
      mode: sseHeaders.mode,
      dest: sseHeaders.dest,
    },
    {
      method: 'GET',
      origin: null,
      site: 'same-origin',
      mode: 'cors',
      dest: 'empty',
    },
    'native EventSource carries actual same-origin GET metadata',
  );
  const postHeaders = apiRequests.find(
    (item) => item.path === '/api/controller/acquire',
  )!;
  check(
    {
      method: postHeaders.method,
      origin: postHeaders.origin,
      site: postHeaders.site,
      mode: postHeaders.mode,
      dest: postHeaders.dest,
    },
    {
      method: 'POST',
      origin,
      site: 'same-origin',
      mode: 'cors',
      dest: 'empty',
    },
    'native Chrome controller write supplies fixed Origin and browser metadata',
  );
  check(
    faults,
    [],
    'browser and offline supplier callbacks have no exceptions',
  );
  check(
    requests.filter(
      (url) => /^https?:/.test(url) && !url.startsWith(`${origin}/`),
    ),
    [],
    'actual page contacts no external service',
  );
  const output = join(repo, '.runtime', 'controlled-browser');
  await mkdir(output, { recursive: true });
  const screenshot = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile(
    join(output, 'acceptance.png'),
    Buffer.from(screenshot.data, 'base64'),
  );
  assert.ok(conversationScreenshot);
  await writeFile(
    join(output, 'conversation.png'),
    Buffer.from(conversationScreenshot, 'base64'),
  );
  assert.ok(remoteScreenshot);
  await writeFile(
    join(output, 'conversation-remote.png'),
    Buffer.from(remoteScreenshot, 'base64'),
  );
  const result = {
    passed: true,
    checkCount: checks.length,
    checks,
    externalRequests: 0,
    exceptions: faults,
    realSupplierCalls: 0,
    fakeProviderCreates: providerCreates.length,
    fakeProviderHangups: providerHangups.length,
    artifacts: [
      '.runtime/controlled-browser/conversation.png',
      '.runtime/controlled-browser/conversation-remote.png',
      '.runtime/controlled-browser/acceptance.png',
    ],
    browser: await page.send('Browser.getVersion'),
  };
  await writeFile(
    join(output, 'acceptance.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      ...result,
      screenshot: '.runtime/controlled-browser/acceptance.png',
    }),
  );
} finally {
  refreshRevokeGate?.resolve();
  refreshHangupReplyGate?.resolve();
  identity.revoked = false;
  failHangup = false;
  voiceGate?.resolve();
  publicGate?.resolve();
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
  for (const response of eventResponses) response.destroy();
  for (const request of upstreamRequests) request.destroy();
  for (const socket of mediaSockets) socket.terminate();
  await app?.close();
  await new Promise<void>((done) => proxy.close(() => done()));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
