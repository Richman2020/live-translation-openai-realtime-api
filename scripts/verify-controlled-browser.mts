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
import { CdpInterceptionLifecycle } from './cdp-interception-lifecycle';
import { ControlledBrowserTrace } from './controlled-browser-trace';

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
import type { TranslationEngine } from '../src/solo/translation-engine';
import type { NativeContinuousCaption } from '../src/solo/continuous-translation-bridge';
import { captureControlledCaptionLayout } from './controlled-caption-layout-fixture.mts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layoutPhase = process.env.CONTROLLED_BROWSER_LAYOUT_SNAPSHOT;
if (layoutPhase !== undefined && !['before', 'after'].includes(layoutPhase)) throw new Error('Layout snapshot must be before or after.');
const layoutCompleted = Symbol('layout-only-completed');
const configuredEngine = process.env.CONTROLLED_BROWSER_TRANSLATION_ENGINE;
if (configuredEngine && !['pocket-prefix', 'continuous-captions'].includes(configuredEngine))
  throw new Error('Offline browser fixture supports pocket-prefix or continuous-captions.');
const translationEngine: TranslationEngine = configuredEngine === 'continuous-captions' ? 'continuous-captions' : 'pocket-prefix';
const continuous = translationEngine === 'continuous-captions';
const pairedCaptionOption = process.env.CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS;
if (pairedCaptionOption !== undefined && !['true', 'false'].includes(pairedCaptionOption))
  throw new Error('Offline outgoing paired captions flag must be true or false.');
const outgoingPairedCaptions = !continuous || pairedCaptionOption !== 'false';
const artifactDirectory = continuous ? outgoingPairedCaptions ? 'controlled-continuous-browser' : 'controlled-continuous-return-only-browser' : 'controlled-browser';
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
await rm(join(repo,'.runtime',artifactDirectory,'acceptance.json'),{force:true});
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
const timing = new ControlledBrowserTrace(1024);
let serverDiagnostic: () => Record<string, unknown> = () => ({});
let acceptance: Record<string, unknown> | undefined;
let bootstrapReplyGate: { tabId: string; afterRequest: number; requestId?: number; hits: number; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
let requestSequence = 0;
let latestControllerMode = 'unknown';
const routeKind = (path: string) => path === '/api/browser-session' ? 'browser-session' : path === '/api/events' ? 'events' : path === '/api/controller/revoke' ? 'revoke' : path === '/api/controller/renew' ? 'renew' : /\/hangup$/.test(path) ? 'hangup' : 'other';
const probeSource = `(() => {
  const p = window.__controlledProbe = {events:[],reads:0,completed:0,pending:0,lastCompleted:0,streams:0,current:0,opened:0,received:0,sources:new Map(),lastTabId:'',sequence:0};
  const note = (event, fields={}) => {p.events.push({event,sequence:++p.sequence,atMs:performance.now(),documentTimeOrigin:performance.timeOrigin,...fields}); if(p.events.length>512)p.events.shift();};
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.origin!==location.origin||url.pathname!=='/api/browser-session')return nativeFetch(input,options);
    const id=++p.reads;p.pending++;p.lastTabId=url.searchParams.get('tabId')||'';note('request-start',{request:id,route:'browser-session'});
    try {
      const response=await nativeFetch(input,options), json=response.json.bind(response);let finished=false;
      response.json=async()=>{try{return await json();}finally{if(!finished){finished=true;p.pending--;p.completed++;p.lastCompleted=id;note('request-complete',{request:id,route:'browser-session',statusCode:response.status,readCompletedMs:performance.now()});}}};
      return response;
    }catch(error){p.pending--;note('failure',{route:'browser-session',request:id});throw error;}
  };
  const Native=window.EventSource;
  window.EventSource=class extends Native {
    constructor(...args){super(...args);const id=++p.streams;p.current=id;p.sources.set(id,this);if(p.sources.size>32)p.sources.delete(p.sources.keys().next().value);note('sse-created',{stream:id});
      this.addEventListener('open',()=>{if(p.current===id)p.opened=id;note('sse-open',{stream:id,connected:p.current===id});});
      for(const kind of ['snapshot','call','error'])this.addEventListener(kind,event=>{let value;try{value=JSON.parse(event.data||'null')}catch{};const call=kind==='snapshot'?value?.activeSession:value;
        p.received++;note('sse-event',{stream:id,eventKind:kind,connected:p.current===id,callStatus:call?.status||'none',cleanupPending:call?.cleanupUnconfirmed===true});});
    }
    close(){for(const [id,source]of p.sources)if(source===this){note('sse-close',{stream:id});if(p.current===id)p.current=0;}return super.close();}
  };
})();`;
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
const providerSids: string[] = [];
const providerHangups: string[] = [];
const preparations = { voice: 0, public: 0 };
const heldVoiceReservations = new Set<object>();
const acquirePortFacts: { busy: boolean; heldVoiceReservations: number }[] = [];
let completedControllerRevocations = 0;
let refreshRevokeGate: ReturnType<typeof deferred> | undefined;
let heldRefreshRevocations = 0;
let refreshHangupReplyGate: ReturnType<typeof deferred> | undefined;
let heldRefreshHangupReplies = 0;
let voiceGate: ReturnType<typeof deferred> | undefined;
let publicGate: ReturnType<typeof deferred> | undefined;
let failHangup = false;
let recoverOnBrowserHangup = false;
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
const now = Date.now;
let app: Awaited<ReturnType<typeof buildSoloServer>> | undefined;
let backendPort = 0;
let origin = '';
let config: SoloConfig;

// An explicitly substituted Voice SDK, served at the page's normal SDK URL.
// Its connect travels through the real signed callback and media application.
const fakeSdk = `(() => {
  const fixture = window.__offlineVoice = { devices: 0, connects: 0, disconnects: 0, registers: 0, tokenUpdates: 0, muted: false, hold: false, waiting: null, deferAccept: false, pendingAccept: null, rejectNext: false, mediaTransfers: 0, streams: [] };
  class Emitter { constructor() { this.listeners = new Map(); } on(name, fn) { const all=this.listeners.get(name)||[]; all.push(fn); this.listeners.set(name,all); return this; } off(name, fn) { this.listeners.set(name,(this.listeners.get(name)||[]).filter(item=>item!==fn)); return this; } removeListener(name, fn) { return this.off(name,fn); } emit(name,...args) { for(const fn of this.listeners.get(name)||[]) fn(...args); } }
  class Call extends Emitter { constructor(stream){super();this.stream=stream;} disconnect() { if(this.closed)return;this.closed=true;for(const track of this.stream?.getTracks()||[])track.stop();fixture.disconnects++;this.emit('disconnect'); } mute(value) { fixture.muted=value;this.emit('mute',value); } status() { return this.closed?'closed':'open'; } }
  class Device extends Emitter {
    constructor(token,options={}) { super(); if(!token.startsWith('offline-browser-fake-'))throw new Error('Only fixture tokens are accepted');this.token=token;this.options=options;fixture.devices++;fixture.lastDevice=this; }
    async register() { fixture.registers++;throw new Error('Global registration must not occur'); }
    updateToken(token) { if(this.destroyed||!token.startsWith('offline-browser-fake-refreshed-'))throw new Error('Only current fixture token updates are accepted');this.token=token;fixture.tokenUpdates++; }
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
  ordinal = clients.length + 1;
  eventRequestGate?: { fetchId?: string; hits: number; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  interception = new CdpInterceptionLifecycle({ pageId: `controlled-${clients.length + 1}`, origin, onFault: fault => faults.push(fault) });
  pending = new Map<
    number,
    { done: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(url: string, targetId: string) {
    this.targetId = targetId;
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      const value = JSON.parse(String(data));
      if (value.method) this.interception.observe(value.method, value.params);
      if (value.method === 'Fetch.requestPaused') {
        this.interception.run(value.params, async record => {
          const gate = this.eventRequestGate;
          if (gate) { if(gate.fetchId!==undefined)throw new Error('CONTROLLED_GATE_SECOND_REQUEST');gate.fetchId=value.params.requestId;gate.hits++; gate.entered.resolve(); timing.add('gate-held', {scope:'fixture',page:this.ordinal,scenario:'sse-held'}); await gate.release.promise; }
          await this.interception.command(record, 'Fetch.continueRequest', this.nextId + 1, () => this.send('Fetch.continueRequest', {requestId:value.params.requestId}));
        });
      } else if (value.id) {
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
    this.socket.on('error',()=>faults.push('CONTROLLED_CDP_TRANSPORT_ERROR'));
    this.socket.on('close',()=>{for(const item of this.pending.values())item.reject(new Error('CONTROLLED_CDP_CLOSED'));this.pending.clear();});
  }
  async stop() {
    if(this.socket.readyState===WebSocket.OPEN){await this.send('Emulation.setScriptExecutionDisabled',{value:true});await this.send('Page.stopLoading');}
    await this.interception.drain();
    if(this.pending.size)throw new Error('CONTROLLED_PENDING_COMMAND_AT_CLOSE');
    if(this.socket.readyState!==WebSocket.CLOSED){const closed=once(this.socket,'close');this.socket.close();let timer:ReturnType<typeof setTimeout>;await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>{this.socket.terminate();reject(new Error('CONTROLLED_CDP_CLOSE_TIMEOUT'));},2000);})]).finally(()=>clearTimeout(timer));}
    await this.interception.drain();
  }
  async ready() {
    await once(this.socket, 'open');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Page.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/api/events`, requestStage: 'Request' }] });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((done, reject) => {
      if(this.socket.readyState!==WebSocket.OPEN){reject(new Error('CONTROLLED_CDP_NOT_OPEN'));return;}
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
  recordedDocument = 0;
  recordedSequence = 0;
  async diagnostic() {
    return this.evaluate(`(()=>{const p=window.__controlledProbe;return {phase:document.documentElement.dataset.controllerPhase,muteEnabled:!document.getElementById('mute-button')?.disabled,startEnabled:!document.getElementById('start-call')?.disabled,endEnabled:!document.getElementById('end-call')?.disabled,hidden:document.hidden,connected:document.getElementById('local-state')?.textContent==='会话状态已连接',sdkClosed:window.__offlineVoice?.lastCall?.closed===true,bootstrapStarted:p?.reads||0,bootstrapCompleted:p?.completed||0,bootstrapPending:p?.pending||0,sseCurrent:p?.current||0,sseOpened:p?.opened||0,sseReceived:p?.received||0,documentTimeOrigin:performance.timeOrigin,events:p?.events||[]};})()`);
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
      `({ready:document.documentElement.dataset.phoneReady, manualControls:Boolean(document.querySelector('#enable-device,#renew-control,#keep-online-toggle')), start:!document.getElementById('start-call').disabled, end:!document.getElementById('end-call').disabled, mute:!document.getElementById('mute-button').disabled, error:document.getElementById('app-error').textContent, connection:document.getElementById('connection-text').textContent, engine:document.getElementById('translation-engine').value, title:document.getElementById('readiness-title').textContent})`,
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
  const requestUrl = new URL(request.url || '/', origin || 'https://phone.example.test');
  const path = requestUrl.pathname;
  const requestId = ++requestSequence;
  const kind = routeKind(path);
  if (kind !== 'other') timing.add('request-start', {scope:'server',request:requestId,route:kind,...serverDiagnostic()});
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
      let bootstrapBody = '';
      if (kind === 'events') {
        let pending = '';
        stream.on('data', chunk => {
          pending += String(chunk);
          if(pending.length>65536){pending='';return;}
          let end;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const eventKind=/^event: (snapshot|call|error)$/m.exec(frame)?.[1];if(!eventKind)continue;let data;try{data=JSON.parse(/^data: (.*)$/m.exec(frame)?.[1]||'null');}catch{};const call=eventKind==='snapshot'?data?.activeSession:data;timing.add('sse-event',{scope:'server',request:requestId,eventKind,callStatus:call?.status||'none',cleanupPending:call?.cleanupUnconfirmed===true});}
        });
      }
      if (kind === 'browser-session') {
        stream.pause();
        stream.on('data', chunk => { if (bootstrapBody.length < 65536) bootstrapBody = (bootstrapBody + String(chunk)).slice(0,65536); });
        stream.once('end', () => {
          try { const body=JSON.parse(bootstrapBody); latestControllerMode = body.controller?.mode ?? 'unknown'; timing.add('request-complete',{scope:'server',request:requestId,route:kind,controllerMode:latestControllerMode,busy:body.busy,callStatus:body.activeSession?.status||'none',readCompletedMs:performance.now()}); } catch {}
          bootstrapBody = '';
        });
      }
      if (kind !== 'other') timing.add('request-response', {scope:'server',request:requestId,route:kind,statusCode:stream.statusCode,...serverDiagnostic()});
      const readGate = kind === 'browser-session' && bootstrapReplyGate?.tabId === requestUrl.searchParams.get('tabId') && requestId>bootstrapReplyGate.afterRequest ? bootstrapReplyGate : undefined;
      if (readGate) { if(readGate.requestId!==undefined){faults.push('CONTROLLED_GATE_SECOND_RESPONSE');readGate.release.resolve();}else{readGate.requestId=requestId;readGate.hits++;readGate.entered.resolve();} timing.add('gate-held', {scope:'server',request:requestId,scenario:'bootstrap-held'}); await readGate.release.promise; }
      stream.once('end', () => {if(kind !== 'other')timing.add('request-complete', {scope:'server',request:requestId,route:kind,...serverDiagnostic()});});
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
        providerSids.push(sid);
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
        timing.add('provider-hangup',{scope:'server',providerHangups:providerHangups.length});
        if (failHangup) throw new Error('Explicit offline cleanup failure');
      },
    }),
    bridgeFactory: (parameters) => {
      bridges.push(parameters);
      return {
        attach: (role) => {
          parameters.onConnection?.({ role, state: 'ready' });
          if (continuous && outgoingPairedCaptions && role === 'local')
            parameters.onOutgoingCaptionState?.({ role: 'local', state: 'ready', translationSource: 'independent_text' });
          if (role === 'remote')
            parameters.onCaptionState?.({ state: 'ready' });
        },
        close() {},
      };
    },
    setupTimeoutMs: 30000,
  });
  manager.on('event', value => { if(value.event==='call')timing.add('server-call',{scope:'server',callStatus:value.data.status,cleanupPending:value.data.cleanupUnconfirmed===true}); });
  const policy = new CloudAccessPolicy({
    publicOrigin: origin,
    now,
    resolveSession: (credential) =>
      credential === token ? { ...identity } : null,
  });
  const leases = new (class extends CloudControllerLeases {
    override acquire(...args: Parameters<CloudControllerLeases['acquire']>) {
      // Observe the real access-layer admission decision without changing it.
      acquirePortFacts.push({
        busy: args[2]?.busy ?? false,
        heldVoiceReservations: heldVoiceReservations.size,
      });
      return super.acquire(...args);
    }
  })({ policy, now, ttlMs: 30000 });
  const voiceJoin = new CloudVoiceJoin({
    policy,
    now,
    outgoingApplicationSid: config.TWILIO_TWIML_APP_SID,
    signer: async (grant) => {
      const fake = `offline-browser-fake-${issuedGrants.size + 1}`;
      issuedGrants.set(fake, grant);
      return fake;
    },
    refreshSigner: async () => `offline-browser-fake-refreshed-${Date.now()}`,
    admission: {
      reserve: async () => {
        preparations.voice++;
        const gate = voiceGate;
        if (gate) await gate.promise;
        const reservation = {};
        heldVoiceReservations.add(reservation);
        return {
          assertCurrent() {},
          release: async () => {
            heldVoiceReservations.delete(reservation);
          },
        };
      },
    },
  });
  const access = new CloudPhoneAccess({
    policy,
    manager,
    controllerLeases: leases,
    voiceJoin,
    ...(continuous ? { allowedTranslationEngines: [translationEngine], defaultTranslationEngine: translationEngine } : {}),
    outgoingPairedCaptions,
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
  serverDiagnostic = () => ({
    managerBlocked: manager.controlAdmissionBlocked, serverActive: Boolean(manager.activeSession),
    callStatus: manager.activeSession?.status || 'none',
    voiceReservations: heldVoiceReservations.size,providerHangups:providerHangups.length,revocations:completedControllerRevocations,
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
    ).json() as {id:string;webSocketDebuggerUrl:string};
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
  if (layoutPhase) {
    await captureControlledCaptionLayout(page, layoutPhase as 'before' | 'after', '/workspace/ai-phone-reference/phone-stability-captions-20261013');
    assert.equal(providerCreates.length, 0);
    assert.equal(issuedGrants.size, 0);
    assert.equal(await page.evaluate('window.__offlineVoice.devices'), 0);
    throw layoutCompleted;
  }
  await eventually(
    async () => (await page.state()).start,
    'Idle authenticated page connected',
  );
  check(
    (await page.state()).manualControls,
    false,
    'controlled page removes manual acquisition, renewal and keep-control controls',
  );
  check(
    await page.evaluate(
      `document.getElementById('readiness-copy').textContent.includes('秒内有效')`,
    ),
    false,
    'controlled page has no controller countdown',
  );
  check(
    await page.evaluate(`document.documentElement.dataset.phoneSurface`),
    'controlled',
    'real index serves the isolated controlled entry',
  );
  check(
    (await page.state()).start,
    true,
    'initial idle page offers direct dialing without acquiring on boot',
  );
  check(apiRequests.filter(item => item.path === '/api/controller/acquire').length, 0, 'boot and SSE reads do not acquire control');
  check(
    (await page.state()).engine,
    translationEngine,
    'controlled page follows the service outgoing strategy and original-English return',
  );
  check(
    await page.evaluate(`[...document.getElementById('translation-engine').options].map(option=>option.value)`),
    continuous ? ['continuous-captions'] : ['pocket-prefix', 'pocket-captions'],
    'actual selector displays only strategies advertised by the service',
  );
  check(
    await page.evaluate(`document.getElementById('connection-mode-label').textContent`),
    continuous ? '连续英文译音 · 英文原声回程' : 'Pocket Michael 英文译音 · 英文原声回程',
    'mode description matches the actual service strategy',
  );
  if (continuous) check(
    await page.evaluate(`document.getElementById('transcript-engine-note').textContent.includes(${JSON.stringify(outgoingPairedCaptions ? '原生英文译音文字独立显示' : '显示原生英文译音文字')}) && document.getElementById('transcript-engine-note').textContent.includes('字幕不能确认译音已播放')`),
    true,
    outgoingPairedCaptions ? 'continuous captions distinguish native text from reference translation and playback confirmation' : 'default captions include native English and paired remote Chinese without local pairing',
  );
  check(
    await page.evaluate('window.__offlineVoice.devices'),
    0,
    'boot creates no Voice token or SDK registration',
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
  try {
    await eventually(
      () => manager.activeSession?.status === 'active' && bridges.length > 0,
      'Real signed two-leg call',
    );
  } catch (failure) {
    console.error(JSON.stringify({
      fixture: 'initial-call',
      page: await page.state(),
      serverStatus: manager.activeSession?.status || 'none',
      fakeProviderCreates: providerCreates.length,
      bridgeCount: bridges.length,
      routes: apiRequests.map(item => ({ method: item.method, path: new URL(item.path, origin).pathname })),
      fixtureFaults: faults,
    }));
    throw failure;
  }
  await eventually(
    async () => (await page.state()).mute,
    'Page accepts real call state',
  );
  check(apiRequests.filter(item => item.path === '/api/controller/acquire').length, 1, 'first direct DOM dial safely acquires once');
  const acquireIndex = apiRequests.findIndex(item => item.path === '/api/controller/acquire');
  const recheckIndex = apiRequests.findIndex((item, index) => index > acquireIndex && item.path.startsWith('/api/browser-session'));
  const createIndex = apiRequests.findIndex(item => item.path === '/api/calls' && item.method === 'POST');
  check(acquireIndex >= 0 && recheckIndex > acquireIndex && createIndex > recheckIndex, true, 'first direct dial rechecks authority before the original call route');
  const observer = await openPage();
  check((await observer.state()).start, false, 'second real tab remains read-only while the first controls');
  check(
    (await observer.state()).manualControls,
    false,
    'read-only tab has no manual control action',
  );
  check(await observer.evaluate(`document.getElementById('readiness-title').textContent.includes('其他页面')`), true, 'observer has a clear multi-page control conflict message');
  check(
    await page.evaluate('window.__offlineVoice.registers'),
    0,
    'automatic per-call ownership performs no global SDK registration',
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
    manager.activeSession?.translationEngine,
    translationEngine,
    'actual create route receives the browser selected service strategy',
  );
  check(
    await page.evaluate(`document.getElementById('translation-engine').disabled`),
    true,
    'strategy cannot switch while the actual call is active',
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
  await eventually(() => page.evaluate('window.__offlineVoice.tokenUpdates === 1'), 'Finite signalling refresh in the current accepted Device');
  check(
    manager.activeSession?.status,
    'active',
    'short join token expiry notification cannot end an already joined call',
  );
  check(
    await page.evaluate('window.__offlineVoice.tokenUpdates'),
    1,
    'SDK expiry warning refreshes the finite token in the same Device',
  );
  check(
    await page.evaluate('window.__offlineVoice.connects'),
    1,
    'signalling refresh never reconnects or creates another phone call',
  );
  check(
    (await observer.state()).start,
    false,
    'observer cannot take control of an active call',
  );
  const bridge = bridges.at(-1)!;
  const at = Date.now();
  const nativeText = 'Keep the total below fifty dollars, not fifteen.';
  const nativeTranscript: NativeContinuousCaption = {
    id: 'native-output', role: 'local', kind: 'translation', text: 'Keep the total',
    final: false, at, pairing: 'unpaired', boundary: 'diagnostic',
    captionSource: 'native_output', audioCorrespondence: 'generated_only',
  };
  if (continuous) {
    bridge.onTranscript?.(nativeTranscript);
  }
  if (outgoingPairedCaptions) {
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
      ...(continuous ? { captionSource: 'independent_text' as const, audioCorrespondence: 'none' as const } : {}),
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
      ...(continuous ? { captionSource: 'independent_text' as const, audioCorrespondence: 'none' as const } : {}),
    });
  }
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
  if (continuous) {
    bridge.onTranscript?.({
      id: 'browser-remote-next', utteranceId: 'browser-remote-next', role: 'remote',
      kind: 'original', text: 'Please confirm the address.', final: true, at: at + 2,
      pairing: 'explicit', boundary: 'semantic',
    });
    bridge.onTranscript?.({
      id: 'browser-remote-next', utteranceId: 'browser-remote-next', role: 'remote',
      kind: 'translation', text: '请确认地址。', final: true, at: at + 2,
      pairing: 'explicit', boundary: 'semantic',
    });
  }
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
  if (continuous) bridge.onTranscript?.({
    ...nativeTranscript,
    id: 'native-output-after-interruption',
    text: ' below fifty dollars, not fifteen.',
    at: at + 10,
  });
  await eventually(
    () =>
      page.evaluate(
        `document.querySelectorAll('[data-utterance-id]').length===${(outgoingPairedCaptions ? 2 : 1) + (continuous ? 3 : 0)}`,
      ),
    'Native SSE paired captions',
  );
  check(
    await page.evaluate(
      `[...document.querySelectorAll('[data-utterance-id]')].map(row=>{const grouped=row.matches('.conversation-source-fragment');return {id:row.dataset.utteranceId,original:row.querySelector(grouped?'.original-text':'.conversation-original .transcript-text').textContent,translation:(grouped?row.closest('.conversation-block').querySelector('.conversation-translation [data-source-id=\"'+row.dataset.utteranceId+'\"] .translation-text'):row.querySelector('.conversation-translation .transcript-text')).textContent};})`,
    ),
    [
      ...(outgoingPairedCaptions ? [{
        id: 'browser-local',
        original: '不是十五美元，是五十美元以内。',
        translation: 'Not fifteen dollars; under fifty dollars.',
      }] : []),
      {
        id: 'browser-remote',
        original: 'We can do that.',
        translation: '我们可以做到。',
      },
      ...(continuous ? [{ id: 'browser-remote-next', original: 'Please confirm the address.', translation: '请确认地址。' }] : []),
      ...(continuous ? [{ id: 'native:native-output', original: '', translation: nativeTranscript.text }] : []),
      ...(continuous ? [{ id: 'native:native-output-after-interruption', original: '', translation: ' below fifty dollars, not fifteen.' }] : []),
    ],
    outgoingPairedCaptions ? 'source-ordered speaker blocks and unbound native auxiliary text remain separate' : 'default shows paired remote captions and unbound native English without inventing a local source pair',
  );
  if (continuous) check(
    await page.evaluate(`({blocks:[...document.querySelectorAll('.conversation-block')].map(block=>[...block.querySelectorAll('[data-utterance-id]')].map(row=>row.dataset.utteranceId)),auxiliary:document.querySelectorAll('.conversation-auxiliary').length,repeatedSpeakerHeaders:document.querySelectorAll('.conversation-segment .utterance-meta').length})`),
    { blocks: [...(outgoingPairedCaptions ? [['browser-local']] : []), ['browser-remote', 'browser-remote-next']], auxiliary: 2, repeatedSpeakerHeaders: 0 },
    'actual cloud SSE keeps same-speaker completed semantic paragraphs in one block and native text in separate unbound auxiliary entries',
  );
  if (continuous) check(
    await page.evaluate(`[...document.querySelectorAll('.conversation-segment[data-caption-source="native_output"] .conversation-translation .transcript-text')].map(node=>node.textContent).join('')`),
    nativeText,
    'native fragments preserve all characters across the intervening remote utterance',
  );
  if (continuous) check(
    await page.evaluate(`(() => { const row=document.querySelector('.conversation-segment[data-caption-source="native_output"]'); return {label:row.querySelector('.conversation-translation .conversation-language').textContent,originalHidden:row.querySelector('.conversation-original').hidden,status:row.querySelector('.utterance-playback').dataset.playbackStatus,playback:row.querySelector('.utterance-playback').textContent}; })()`),
    { label: '原生英文译音文字', originalHidden: true, status: 'unknown', playback: '英文译音生成文字 · 未与原文配对 · 播放未确认' },
    'actual native text stays visible without a fabricated Chinese pair or played claim',
  );
  if (continuous && outgoingPairedCaptions) check(
    await page.evaluate(`document.querySelector('[data-caption-source="independent_text"]').closest('.conversation-block').querySelector('.conversation-translation .conversation-language').textContent`),
    'English 参考翻译',
    'independent English wording is labelled reference translation alongside different native text',
  );
  if (continuous && outgoingPairedCaptions) check(
    await page.evaluate(`document.querySelector('[data-utterance-id="browser-local"]').closest('.conversation-block').querySelector(':scope>.utterance-playback').dataset.playbackStatus`),
    'unknown',
    'paired independent text cannot invent native translated audio playback confirmation',
  );
  if (continuous && outgoingPairedCaptions) {
    bridge.onOutgoingCaptionState?.({ role: 'local', state: 'failed', translationSource: 'independent_text' });
    await eventually(() => page.evaluate(`document.getElementById('caption-status').textContent.includes('本页逐句文字暂不可用')`), 'Independent local caption failure');
    check(await page.evaluate(`document.getElementById('caption-status').textContent.includes('对方中文字幕旁路已就绪') && !document.getElementById('mute-button').disabled`), true,
      'local captions failing preserves remote caption status and active native audio controls');
    bridge.onOutgoingCaptionState?.({ role: 'local', state: 'ready', translationSource: 'independent_text' });
    await eventually(() => page.evaluate(`document.getElementById('caption-status').textContent.includes('本页逐句文字旁路已就绪')`), 'Independent local caption recovery fixture');
  }
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
  function collectPageTrace(client: CdpPage, state: any) {
    if(client.recordedDocument!==state.documentTimeOrigin){client.recordedDocument=state.documentTimeOrigin;client.recordedSequence=0;}
    for(const event of state.events)if(event.sequence>client.recordedSequence){timing.add(event.event,{scope:'page',page:client.ordinal,...event});client.recordedSequence=event.sequence;}
  }
  async function observeBoundary(scenario: string) {
    const state = await page.diagnostic();
    collectPageTrace(page,state);
    timing.add('boundary', {scope:'page',page:page.ordinal,scenario,...state});
    timing.add('boundary', {scope:'server',scenario,...serverDiagnostic()});
    return state;
  }
  async function waitFreshEvents(afterRead: number, afterStream: number, active = true) {
    await eventually(async () => {
      const state = await page.diagnostic();
      return state.bootstrapStarted > afterRead && state.bootstrapCompleted === state.bootstrapStarted &&
        state.bootstrapPending === 0 && state.sseCurrent > afterStream && state.sseOpened === state.sseCurrent &&
        state.connected && !state.hidden && (!active || state.phase === 'active' && state.muteEnabled && !state.sdkClosed);
    }, 'Fresh bootstrap body and current SSE open before media boundary');
    await observeBoundary('refresh-ready');
  }
  async function waitDisconnectedUi(scenario: string) {
    try {
      await eventually(() => !manager.controlAdmissionBlocked, 'Real media disconnect two-leg cleanup');
      await eventually(async () => {
        const state = await page.diagnostic();
        return state.phase === 'readonly' && !state.muteEnabled;
      }, 'Disconnected media owner UI');
      await eventually(() => heldVoiceReservations.size === 0 && controllerStatus().mode === 'available', 'Voice reservation and old controller cleanup complete');
      const state = await observeBoundary(scenario);
      check({phase:state.phase,mute:state.muteEnabled,sdkClosed:state.sdkClosed}, {phase:'readonly',mute:false,sdkClosed:true}, 'Disconnected owner is readonly, mute unavailable and original SDK closed');
    } catch(error) { await observeBoundary(scenario); timing.add('failure',{scope:'fixture',scenario,...serverDiagnostic()}); throw error; }
  }
  async function verifyBackgroundCall() {
    await eventually(
      async () => (await page.state()).mute,
      'Accepted SDK before freezing timers',
    );
    if (!(await page.evaluate('window.__offlineVoice.muted')))
      await page.click('mute-button');
    const backgroundHangups = providerHangups.length;
    await observer.foreground();
    await eventually(
      () => page.evaluate('document.hidden'),
      'Muted accepted owner tab is hidden',
    );
    await page.send('Page.setWebLifecycleState', { state: 'frozen' });
    try {
      // The browser's JS timers are paused while the real signed media sockets
      // and server ping/pong witness remain connected, including silence.
      await pause(31000);
      check(
        manager.activeSession?.status,
        'active',
        'normal silent media stay active beyond the old 30-second browser controller deadline',
      );
      check(
        providerHangups.length,
        backgroundHangups,
        'background timer throttling does not hang up either healthy leg',
      );
      check(
        (await observer.state()).start,
        false,
        'another page cannot dial while the background call remains active',
      );
    } finally {
      await page.send('Page.setWebLifecycleState', { state: 'active' });
    }
    check(
      await page.evaluate('window.__offlineVoice.lastCall.closed===true'),
      false,
      'old local expiry does not disconnect the accepted SDK',
    );
    check(
      await page.evaluate('window.__offlineVoice.muted'),
      true,
      'mute remains intact while accepted media stay connected in the background',
    );
    await page.foreground();
    const beforeRefresh = await page.diagnostic();
    await page.click('refresh-controlled-state');
    await waitFreshEvents(beforeRefresh.bootstrapStarted, beforeRefresh.sseCurrent);
  }
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
    { start: true, mute: false },
    'after confirmed outage cleanup a new direct dial is offered while the old SDK stays retired',
  );
  check(await page.evaluate('document.documentElement.dataset.controllerPhase'), 'readonly', 'read reconnect does not recover the retired controller proof');
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
  await eventually(
    async () => (await page.state()).start,
    'Direct dialing is available after pending SDK outage cleanup',
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
    async () => !(await page.state()).mute && (await page.evaluate('document.documentElement.dataset.controllerPhase')) === 'readonly',
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
  await eventually(
    async () => (await page.state()).start,
    'Direct dialing is available after hidden SDK disconnect cleanup',
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
  const pendingNavigationReads = apiRequests.filter((item) =>
    item.path.startsWith('/api/browser-session'),
  ).length;
  const navigationAuthorityWrites = apiRequests.filter((item) =>
    ['/api/controller/acquire', '/api/controller/renew'].includes(item.path),
  ).length;
  await page.evaluate(
    `document.querySelector('[data-view="workspace"]').click()`,
  );
  await eventually(
    () =>
      apiRequests.filter((item) => item.path.startsWith('/api/browser-session'))
        .length > pendingNavigationReads,
    'Returning to workspace issues a read while readiness is still pending',
  );
  check(
    await page.evaluate(
      `fetch('/api/browser-session?tabId=readonly-navigation-probe',{credentials:'same-origin',cache:'no-store'}).then(response=>response.json()).then(value=>value.busy)`,
    ),
    true,
    'the real backend still reports pending readiness rather than confirmed idle',
  );
  check(
    (await page.state()).start,
    false,
    'returning to workspace cannot bypass genuinely pending preparation',
  );
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
  await eventually(
    async () => (await page.state()).start,
    'New controller after navigation',
  );
  check(
    apiRequests.filter((item) =>
      ['/api/controller/acquire', '/api/controller/renew'].includes(item.path),
    ).length,
    navigationAuthorityWrites,
    'confirmed idle workspace navigation restores direct dialing using reads without acquiring or renewing',
  );
  check(
    (await page.state()).manualControls,
    false,
    'returning to workspace requires no manual control button',
  );
  for (const code of [20104, 31205, 31005]) {
    await eventually(
      async () => (await page.state()).start,
      'Direct dialing before Device error diagnosis',
    );
    await dial();
    await eventually(
      async () =>
        manager.activeSession?.status === 'active' && (await page.state()).mute,
      'Accepted call before Device error diagnosis',
    );
    await page.evaluate(
      `window.__retiredDiagnosticDevice=window.__offlineVoice.lastDevice;window.__offlineVoice.lastDevice.emit('error',{code:${code},message:'PRIVATE_ERROR_MUST_NOT_RENDER',token:'PRIVATE_ERROR_MUST_NOT_RENDER',url:'PRIVATE_ERROR_MUST_NOT_RENDER'});`,
    );
    await eventually(
      () => !manager.controlAdmissionBlocked,
      'Device error cleans both provider legs',
    );
    await eventually(
      async () =>
        (await page.evaluate(
          'document.documentElement.dataset.controllerPhase',
        )) === 'readonly',
      'Device error retires local admission',
    );
    check(
      (await page.state()).error,
      code === 20104 || code === 31205
        ? '电话信令令牌到期；正在确认线路清理。'
        : '浏览器电话连接失败；正在确认线路清理。',
      'Device error exposes only the allowlisted expiry category or generic failure',
    );
    check(
      await page.evaluate(
        `document.body.textContent.includes('PRIVATE_ERROR_MUST_NOT_RENDER')`,
      ),
      false,
      'Device supplier error details stay out of the page',
    );
  }
  await eventually(
    async () => (await page.state()).start,
    'Direct dialing after diagnosed Device cleanup',
  );
  await dial();
  await eventually(
    async () =>
      manager.activeSession?.status === 'active' && (await page.state()).mute,
    'New accepted call before a stale Device error',
  );
  const staleDeviceHangups = providerHangups.length;
  await page.evaluate(
    `window.__retiredDiagnosticDevice.emit('error',{code:20104,message:'PRIVATE_ERROR_MUST_NOT_RENDER'});`,
  );
  await pause(80);
  check(
    manager.activeSession?.status,
    'active',
    'a late retired Device error cannot terminate the next call',
  );
  check(
    providerHangups.length,
    staleDeviceHangups,
    'a late Device error performs no cleanup for the new owner',
  );
  const remoteStatus = new URL(
    providerCreates.at(-1)!.statusCallback as string,
  );
  const remoteEnded = await signed(
    remoteStatus.pathname + remoteStatus.search,
    { CallSid: providerSids.at(-1)!, CallStatus: 'completed' },
  );
  check(
    remoteEnded.statusCode,
    204,
    'a signed matching remote completion callback ends the current call',
  );
  await eventually(
    () => !manager.controlAdmissionBlocked,
    'Remote completion confirms remaining-leg cleanup',
  );
  await eventually(
    async () => !(await page.state()).mute && (await page.state()).start,
    'Remote completion retires media and offers a new direct dial',
  );
  check(
    await page.evaluate('window.__offlineVoice.lastCall.closed===true'),
    true,
    'remote completion disconnects the accepted browser SDK',
  );
  // A failure is a real SDK rejection after real per-call preparation.
  const failureCreates = providerCreates.length;
  await page.evaluate('window.__offlineVoice.rejectNext=true');
  await dial();
  await eventually(
    async () =>
      (await page.evaluate('document.documentElement.dataset.controllerPhase')) === 'readonly' && Boolean((await page.state()).error),
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
  await pause(31000);
  check(
    (await page.state()).end,
    true,
    'unconfirmed accepted-call cleanup remains retryable after the old controller deadline',
  );
  check(
    (await page.state()).start,
    false,
    'cleanup-only retry cannot authorize another call after the old deadline',
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
        (await page.state()).title ===
        '其他页面正在使用电话，请在该页面结束通话',
      'New document reads the still-held old controller',
    );
    const heldState = await page.state();
    check(
      {
        serverMode: controllerStatus().mode,
        manualControls: heldState.manualControls,
        start: heldState.start,
      },
      { serverMode: 'held', manualControls: false, start: false },
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
    await page.evaluate('document.documentElement.dataset.controllerPhase'),
    'readonly',
    'refresh cannot recover a controller capability from storage',
  );
  await page.click('refresh-controlled-state');
  await eventually(
    async () => (await page.state()).start,
    'Explicit refresh confirms controller availability',
  );
  check(
    {
      manualControls: (await page.state()).manualControls,
      start: (await page.state()).start,
    },
    { manualControls: false, start: true },
    'confirmed revoke and state refresh offer direct dialing without acquiring control',
  );
  await eventually(
    async () => (await page.state()).start,
    'Controller after refresh',
  );
  await dial();
  await eventually(
    () => manager.activeSession?.status === 'active',
    'Second controlled call',
  );
  await verifyBackgroundCall();
  const disconnectedBefore = providerHangups.length;
  await observeBoundary('baseline');
  timing.add('media-disconnect',{scope:'fixture',scenario:'baseline',...serverDiagnostic()});
  for (const socket of mediaSockets) socket.terminate();
  await waitDisconnectedUi('baseline');
  check(
    providerHangups.length - disconnectedBefore,
    2,
    'real media loss still cleans both live legs despite automatic ownership maintenance',
  );
  const observerBootstrap = () =>
    access.browserSession(
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
  // Manager line cleanup can finish before the independent Voice reservation
  // release and captured controller revoke. Wait for the real complete idle
  // projection before testing a different page's explicit fresh dial.
  await eventually(() => {
    const current = observerBootstrap();
    return (
      current.controller.mode === 'available' &&
      current.busy === false &&
      current.activeSession === null &&
      heldVoiceReservations.size === 0
    );
  }, 'Disconnected-call Voice cleanup and old controller revoke complete');
  // Deterministic scheduling, not retries: hold either one native read response
  // or this exact page's next SSE request. No auth response/event is fabricated.
  for (const scenario of ['bootstrap-held', 'sse-held'] as const) {
    await page.click('refresh-controlled-state');
    await eventually(async () => (await page.state()).start, 'Timing scenario can dial after prior complete cleanup');
    await dial();
    await eventually(async () => manager.activeSession?.status === 'active' && (await page.state()).mute, 'Timing scenario accepted media');
    await eventually(async()=>{const state=await page.diagnostic();return state.bootstrapPending===0&&state.sseCurrent===state.sseOpened&&state.connected;},'Timing scenario begins with settled native reads and an open stream');
    const before = await page.diagnostic();
    const lateCall = manager.activeSession!;
    const hangups = providerHangups.length;
    const gate = {entered:deferred(),release:deferred(),hits:0};
    if (scenario === 'bootstrap-held') bootstrapReplyGate = {...gate,afterRequest:requestSequence,tabId:await page.evaluate('window.__controlledProbe.lastTabId')};
    else page.eventRequestGate = gate;
    try {
      await page.click('refresh-controlled-state');
      let gateTimer:ReturnType<typeof setTimeout>;
      await Promise.race([gate.entered.promise,new Promise((_,reject)=>{gateTimer=setTimeout(()=>reject(new Error('CONTROLLED_TIMING_GATE_NOT_REACHED')),12000);})]).finally(()=>clearTimeout(gateTimer));
      check(scenario==='bootstrap-held'?bootstrapReplyGate!.hits:page.eventRequestGate!.hits,1,'Controlled gate owns exactly one native request');
      const held = await observeBoundary(scenario);
      check(held.muteEnabled,true,'Legacy mute predicate is already true while the controlled refresh gate is held');
      check(held.connected,false,'Controlled gate proves state stream has not reconnected');
      if (scenario === 'bootstrap-held') check(held.bootstrapPending > 0,true,'Held real bootstrap response is not a completed read');
      else check(held.sseOpened < held.sseCurrent,true,'Held native SSE request is not an open current stream');
      timing.add('media-disconnect',{scope:'fixture',scenario,...serverDiagnostic()});
      for (const socket of mediaSockets) socket.terminate();
      await eventually(() => !manager.controlAdmissionBlocked,'Server line cleanup while refresh is deliberately held');
      gate.release.resolve(); timing.add('gate-released',{scope:'fixture',scenario});
      bootstrapReplyGate = undefined; page.eventRequestGate = undefined;
      await waitFreshEvents(before.bootstrapStarted,before.sseCurrent,false);
      await waitDisconnectedUi(scenario);
      check(providerHangups.length-hangups,2,'Controlled refresh boundary still ends both fake provider legs once');
      const afterWrites = apiRequests.filter(item => item.method === 'POST').length;
      const beforeLate = await page.diagnostic();
      // Artificial delayed old-instance event: the real workbench must ignore it.
      const injected = await page.evaluate(`(()=>{const source=window.__controlledProbe.sources.get(${before.sseCurrent});if(!source)return false;source.dispatchEvent(new MessageEvent('call',{data:${JSON.stringify(JSON.stringify({id:lateCall.id,status:'active',translationEngine}))}}));return true;})()`);
      check(injected,true,'Artificial late event is actually dispatched on the retained old stream');
      const afterLate = await page.diagnostic();
      check(afterLate.sseReceived,beforeLate.sseReceived+1,'Late event reaches the diagnostic listener');
      await observeBoundary('late-result');
      check({phase:afterLate.phase,mute:afterLate.muteEnabled,sdkClosed:afterLate.sdkClosed},{phase:'readonly',mute:false,sdkClosed:true},'Late retired-stream event cannot revive media or owner');
      check(apiRequests.filter(item=>item.method==='POST').length,afterWrites,'Late retired-stream event creates no cleanup or dial write');
    } finally {gate.release.resolve(); bootstrapReplyGate=undefined;page.eventRequestGate=undefined;}
  }
  if (continuous) {
    // Synthetic adapter status, not the captured phone's browser evidence.
    // The separate item-conflict lifecycle suite starts at real client frames;
    // this case follows the real manager -> owner SSE -> production DOM path.
    await page.click('refresh-controlled-state');
    await eventually(async () => (await page.state()).start, 'Translation-stop fixture can dial after prior cleanup');
    await dial();
    await eventually(async () => manager.activeSession?.status === 'active' && (await page.state()).mute, 'Translation-stop fixture accepted media');
    const stoppedCall = manager.activeSession!.id;
    const stoppedBridge = bridges.at(-1)!;
    const stopHangups = providerHangups.length;
    const stopCreates = providerCreates.length;
    const stopSdkConnects = await page.evaluate('window.__offlineVoice.connects');
    stoppedBridge.onOutgoingCaptionState?.({ role: 'local', state: 'failed', translationSource: 'independent_text' });
    stoppedBridge.onCaptionState?.({ state: 'failed', translationStopped: true });
    const stoppedDom = () => page.evaluate(`(() => ({
      connection:document.getElementById('connection-text').textContent,
      bridge:document.getElementById('bridge-caption').textContent,
      captions:document.getElementById('caption-status').textContent,
      captionVisible:!document.getElementById('caption-status').hidden,
      endEnabled:!document.getElementById('end-call').disabled,
      muteEnabled:!document.getElementById('mute-button').disabled,
      sdkClosed:window.__offlineVoice.lastCall.closed===true
    }))()`);
    await eventually(async () => (await stoppedDom()).connection === '电话仍在进行 · 翻译已停止', 'Synthetic translation failure reaches owner DOM');
    const failedDom = await stoppedDom();
    check({id:manager.activeSession?.id,stopped:manager.activeSession?.translationStopped}, {id:stoppedCall,stopped:true}, 'Translation stopped is persisted on the real active call');
    check({ status:manager.activeSession?.status,hangups:providerHangups.length }, { status:'active',hangups:stopHangups }, 'Translation failure status does not terminate either fake phone leg');
    check(failedDom.bridge, '翻译已停止 · 电话仍在进行，请手动挂断后检查', 'Translation failure is visibly explained beside the phone');
    check(failedDom.captions, '翻译已停止，电话仍在进行；可听对方原声。请手动挂断后检查，系统不会自动重连或切换模型。', 'Caption status explains original audio and manual recovery without claiming translation continues');
    check({ visible:failedDom.captionVisible,end:failedDom.endEnabled,mute:failedDom.muteEnabled,sdkClosed:failedDom.sdkClosed }, { visible:true,end:true,mute:true,sdkClosed:false }, 'Active stopped-translation call retains the accepted SDK and manual hangup');
    const beforeStoppedRefresh = await page.diagnostic();
    await page.click('refresh-controlled-state');
    await waitFreshEvents(beforeStoppedRefresh.bootstrapStarted,beforeStoppedRefresh.sseCurrent);
    const refreshedStop = await stoppedDom();
    check(refreshedStop, failedDom, 'Fresh bootstrap and owner SSE snapshot keep the persisted translation failure visible');
    check({ creates:providerCreates.length,connects:await page.evaluate('window.__offlineVoice.connects'),hangups:providerHangups.length }, { creates:stopCreates,connects:stopSdkConnects,hangups:stopHangups }, 'Refreshing a translation failure neither redials nor disconnects the accepted phone');
    await page.click('end-call');
    await eventually(() => !manager.controlAdmissionBlocked && heldVoiceReservations.size === 0 && controllerStatus().mode === 'available', 'Manual hangup cleans a stopped-translation call');
    await eventually(async () => !(await page.state()).mute && (await page.state()).start, 'Stopped-translation manual hangup returns to direct dialing');
    check(providerHangups.length-stopHangups,2,'Manual hangup after translation stop cleans both fake provider legs exactly once');
    check(await page.evaluate('window.__offlineVoice.lastCall.closed===true'),true,'Manual hangup after translation stop closes the accepted SDK');
  }
  await observer.click('refresh-controlled-state');
  await eventually(
    async () => (await observer.state()).start,
    'Observer can dial directly after confirmed disconnected-call cleanup',
  );
  await dial(observer);
  try {
    await eventually(
    () => manager.activeSession?.status === 'active',
    'Actual close fixture active',
  );
  } catch (failure) {
    console.error(
      JSON.stringify({
        fixture: 'observer-close-call',
        page: await observer.state(),
        serverStatus: manager.activeSession?.status || 'none',
        serverRead: {
          controllerMode: observerBootstrap().controller.mode,
          busy: observerBootstrap().busy,
          active: observerBootstrap().activeSession !== null,
        },
        latestAcquire: acquirePortFacts.at(-1),
        fakeProviderCreates: providerCreates.length,
        routes: apiRequests.slice(-20).map((item) => ({
          method: item.method,
          path: new URL(item.path, origin).pathname,
        })),
      }),
    );
    throw failure;
  }
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
  const output = join(repo, '.runtime', artifactDirectory);
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
  acceptance = {
    passed: true,
    checkCount: checks.length,
    checks,
    externalRequests: 0,
    exceptions: faults,
    realSupplierCalls: 0,
    fakeProviderCreates: providerCreates.length,
    fakeProviderHangups: providerHangups.length,
    translationEngine,
    outgoingPairedCaptions,
    artifacts: [
      `.runtime/${artifactDirectory}/conversation.png`,
      `.runtime/${artifactDirectory}/conversation-remote.png`,
      `.runtime/${artifactDirectory}/acceptance.png`,
    ],
    browser: await page.send('Browser.getVersion'),
  };

} catch (error) {
  if (error !== layoutCompleted) {
    timing.add('failure',{scope:'fixture',...serverDiagnostic()});
    for (const client of clients) { const state=await client.diagnostic().catch(()=>null); if(state){for(const event of state.events)if(event.sequence>client.recordedSequence)timing.add(event.event,{scope:'page',page:client.ordinal,...event});timing.add('failure',{scope:'page',page:client.ordinal,...state});} }
    throw error;
  }
} finally {
  bootstrapReplyGate?.release.resolve();
  for (const client of clients) client.eventRequestGate?.release.resolve();
  refreshRevokeGate?.resolve();
  refreshHangupReplyGate?.resolve();
  identity.revoked = false;
  failHangup = false;
  voiceGate?.resolve();
  publicGate?.resolve();
  timing.add('cleanup-start',{scope:'fixture'});
  const cleanup=await Promise.allSettled(clients.map(client=>client.stop()));
  for(const result of cleanup)if(result.status==='rejected')faults.push('CONTROLLED_CDP_CLEANUP_FAILURE');
  for(const client of clients)if(client.socket.readyState!==WebSocket.CLOSED)client.socket.terminate();
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
  const failedTimingOutput=join(repo,'.runtime',artifactDirectory);
  await mkdir(failedTimingOutput,{recursive:true});
  await writeFile(join(failedTimingOutput,'controlled-timing.json'),JSON.stringify(timing.snapshot(),null,2)+'\n');
  if(!acceptance||faults.length)console.log(JSON.stringify({controlledTiming:timing.snapshot()}));
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

check(faults, [], 'browser and interception cleanup preserve strict zero exceptions');
check(requests.filter(url=>/^https?:/.test(url)&&!url.startsWith(`${origin}/`)), [], 'cleanup preserves the no-external-service boundary');
timing.add('cleanup-end',{scope:'fixture'});
const timingOutput=join(repo,'.runtime',artifactDirectory);
await mkdir(timingOutput,{recursive:true});
await writeFile(join(timingOutput,'controlled-timing.json'),JSON.stringify(timing.snapshot(),null,2)+'\n');
console.log(JSON.stringify({controlledTiming:timing.snapshot()}));
if(acceptance){acceptance.checkCount=checks.length;acceptance.exceptions=[...faults];await writeFile(join(timingOutput,'acceptance.json'),JSON.stringify(acceptance,null,2)+'\n');console.log(JSON.stringify(acceptance));}
