/** Controlled real-Chromium reproduction of paused-request lifecycle boundaries.
 * Only synthetic HTTP requests to an owned loopback listener are used. This is
 * deliberately scheduled evidence, not a replay of the unidentified CI #72 XHR.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { CdpInterceptionLifecycle } from './cdp-interception-lifecycle';

const argument = process.argv.slice(2);
assert.ok(
  argument.length === 0 ||
    (argument.length === 2 && argument[0] === '--evidence-dir'),
);
const evidenceDirectory = argument.length ? resolve(argument[1]) : undefined;
const executable = [
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].find(existsSync);
assert.ok(
  executable,
  'An existing Chromium executable is required; this entry does not install one.',
);
const directory = await mkdtemp(join(tmpdir(), 'cdp-lifecycle-reproduction-'));
const profile = join(directory, 'chrome');
const began = performance.now();
const startedAtUtc = new Date().toISOString();
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      import.meta.url,
      new URL('./cdp-interception-lifecycle.ts', import.meta.url),
    ].map(async (file) => [
      String(file).split('/').at(-1),
      createHash('sha256')
        .update(await readFile(new URL(file)))
        .digest('hex'),
    ]),
  ),
);
const records: Record<string, unknown>[] = [];
const results: Record<string, unknown>[] = [];
const pages: ProbePage[] = [];
let origin = '';
let debugPort = 0;
let chrome: ReturnType<typeof spawn> | undefined;
let serverRequests = 0;
const record = (event: string, details: Record<string, unknown> = {}) => {
  records.push({
    sequence: records.length + 1,
    elapsedMs: Math.round((performance.now() - began) * 1000) / 1000,
    event,
    ...details,
  });
};
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until<T>(
  read: () => T | Promise<T>,
  label: string,
  timeout = 8000,
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(10);
  }
  throw new Error(`Controlled reproduction timeout: ${label}`);
}
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
};
type Paused = {
  requestId: string;
  networkId?: string;
  resourceType?: string;
  request: { url: string; method: string };
};

class ProbePage {
  socket: WebSocket;
  nextId = 0;
  pending = new Map<number, Pending>();
  paused: Paused[] = [];
  terminal = new Map<string, { method: string; canceled?: boolean }>();
  closed = false;
  faults: string[] = [];
  guardedFaults: string[] = [];
  lifecycle: CdpInterceptionLifecycle;
  constructor(
    readonly target: { id: string; webSocketDebuggerUrl: string },
    readonly label: string,
  ) {
    this.lifecycle = new CdpInterceptionLifecycle({
      pageId: label,
      origin,
      onFault: (fault) => this.guardedFaults.push(fault),
    });
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.socket.on('message', (data) => {
      const value = JSON.parse(String(data));
      if (value.method) this.lifecycle.observe(value.method, value.params);
      if (value.id) {
        const pending = this.pending.get(value.id);
        this.pending.delete(value.id);
        if (!pending) throw new Error('Uncorrelated CDP command response');
        clearTimeout(pending.timer);
        record('command-result', {
          page: this.label,
          commandId: value.id,
          method: pending.method,
          protocolCode: value.error?.code ?? null,
        });
        if (value.error)
          pending.reject(
            Object.assign(new Error(value.error.message), {
              protocolCode: value.error.code,
              commandId: value.id,
              method: pending.method,
            }),
          );
        else pending.resolve(value.result);
      } else if (value.method === 'Fetch.requestPaused') {
        const event = value.params as Paused;
        const parsed = new URL(event.request.url);
        const local = parsed.origin === origin;
        record(value.method, {
          page: this.label,
          fetchId: event.requestId,
          networkId: event.networkId ?? null,
          resourceType: event.resourceType,
          path: local ? parsed.pathname : 'external-blocked',
        });
        if (local && parsed.pathname.startsWith('/case/'))
          this.paused.push(event);
        else
          void this.send(
            local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
            {
              requestId: event.requestId,
              ...(local ? {} : { errorReason: 'BlockedByClient' }),
            },
          ).catch((error) => this.faults.push(String(error)));
      } else if (
        value.method === 'Network.loadingFailed' ||
        value.method === 'Network.loadingFinished'
      ) {
        this.terminal.set(value.params.requestId, {
          method: value.method,
          canceled: value.params.canceled,
        });
        record(value.method, {
          page: this.label,
          networkId: value.params.requestId,
          canceled: value.params.canceled ?? null,
        });
      } else if (value.method === 'Page.frameNavigated') {
        record(value.method, {
          page: this.label,
          frameId: value.params.frame.id,
          loaderId: value.params.frame.loaderId,
        });
      } else if (value.method === 'Inspector.detached')
        record(value.method, { page: this.label, reason: value.params.reason });
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.lifecycle.observe('Fixture.transportClosed');
      record('socket-close', { page: this.label });
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          Object.assign(new Error('CDP page socket closed'), {
            commandId: id,
            method: pending.method,
          }),
        );
      }
      this.pending.clear();
    });
  }
  async ready() {
    await once(this.socket, 'open');
    for (const method of ['Runtime.enable', 'Network.enable', 'Page.enable'])
      await this.send(method);
    await this.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    await this.send('Page.navigate', { url: `${origin}/` });
    await until(
      () =>
        this.evaluate(
          `location.origin === ${JSON.stringify(origin)} && document.title === 'Owned loopback lifecycle fixture' && document.readyState === 'complete'`,
        ),
      'loopback page loaded',
    );
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    record('command-send', {
      page: this.label,
      commandId: id,
      method,
      ...(typeof params.requestId === 'string'
        ? { fetchId: params.requestId }
        : {}),
    });
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        Object.assign(new Error('CDP page socket unavailable'), {
          commandId: id,
          method,
        }),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error('CDP command timed out'), {
            commandId: id,
            method,
          }),
        );
      }, 8000);
      this.pending.set(id, { resolve, reject, method, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string) {
    const value = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    assert.equal(
      value.exceptionDetails,
      undefined,
      'Controlled browser expression succeeds',
    );
    return value.result.value;
  }
  async begin(path: string) {
    await this.evaluate(
      `window.fixtureAbort = new AbortController(); window.fixtureState = 'pending'; fetch(${JSON.stringify(path)}, {signal:window.fixtureAbort.signal}).then(response=>response.text()).then(()=>window.fixtureState='finished', error=>window.fixtureState=error.name);`,
    );
    return until(
      () =>
        this.paused.find(
          (event) => new URL(event.request.url).pathname === path,
        ),
      `paused ${path}`,
    );
  }
  async continue(event: Paused) {
    try {
      await this.send('Fetch.continueRequest', { requestId: event.requestId });
      return {
        accepted: true,
        protocolCode: null,
        commandId: this.nextId,
        method: 'Fetch.continueRequest',
      };
    } catch (error: any) {
      record('observed-rejection', {
        page: this.label,
        fetchId: event.requestId,
        networkId: event.networkId ?? null,
        commandId: error.commandId,
        method: error.method,
        protocolCode: error.protocolCode ?? null,
        classification: /Invalid InterceptionId/.test(error.message)
          ? 'INVALID_INTERCEPTION_ID'
          : 'OTHER',
      });
      return {
        accepted: false,
        protocolCode: error.protocolCode ?? null,
        commandId: error.commandId,
        method: error.method,
      };
    }
  }
  guarded(event: Paused, beforeCommand = async () => {}) {
    this.lifecycle.run(event, async (request) => {
      await beforeCommand();
      await this.lifecycle.command(
        request,
        'Fetch.continueRequest',
        this.nextId + 1,
        () =>
          this.send('Fetch.continueRequest', { requestId: event.requestId }),
      );
    });
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
const sentFor = (pageLabel: string, fetchId: string) =>
  records.filter(
    (item) =>
      item.event === 'command-send' &&
      item.page === pageLabel &&
      item.method === 'Fetch.continueRequest' &&
      item.fetchId === fetchId,
  ).length;

const server = http.createServer((request, response) => {
  serverRequests++;
  const path = new URL(request.url ?? '/', 'http://loopback.invalid').pathname;
  record('server-request', { path });
  response.setHeader('Cache-Control', 'no-store');
  if (path.startsWith('/case/')) {
    response.end('synthetic local fixture');
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(
    '<!doctype html><title>Owned loopback lifecycle fixture</title><link rel="icon" href="data:,">',
  );
});

async function page(label: string) {
  const response = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?about:blank`,
    { method: 'PUT' },
  );
  assert.ok(response.ok);
  const instance = new ProbePage(
    (await response.json()) as { id: string; webSocketDebuggerUrl: string },
    label,
  );
  pages.push(instance);
  await instance.ready();
  return instance;
}

let failure: string | undefined;
try {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
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
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  debugPort = await until(
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
    'Chromium start',
    20000,
  );

  const normal = await page('normal-and-duplicate');
  const normalRequest = await normal.begin('/case/normal');
  const first = await normal.continue(normalRequest);
  assert.equal(first.accepted, true);
  await until(
    () => normal.evaluate('window.fixtureState === "finished"'),
    'normal response completes',
  );
  const duplicate = await normal.continue(normalRequest);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.protocolCode, -32602);
  results.push({
    case: 'normal-then-duplicate',
    first,
    duplicate,
    terminal: normal.terminal.get(normalRequest.networkId!),
  });

  const abort = await page('abort-while-paused');
  const aborted = await abort.begin('/case/abort');
  await abort.evaluate('window.fixtureAbort.abort()');
  const abortTerminal = await until(
    () => abort.terminal.get(aborted.networkId!),
    'explicit AbortController network terminal',
  );
  assert.equal(abortTerminal.canceled, true);
  const afterAbort = await abort.continue(aborted);
  assert.equal(afterAbort.accepted, false);
  assert.equal(afterAbort.protocolCode, -32602);
  results.push({
    case: 'abort-before-continue',
    outcome: afterAbort,
    terminal: abortTerminal,
  });

  const navigation = await page('navigation-while-paused');
  const navigated = await navigation.begin('/case/navigation');
  await navigation.send('Page.navigate', { url: `${origin}/replacement` });
  await until(
    () =>
      navigation.evaluate(
        'location.pathname === "/replacement" && document.readyState === "complete"',
      ),
    'navigation completes',
  );
  const navigationTerminal = navigation.terminal.get(navigated.networkId!);
  const afterNavigation = await navigation.continue(navigated);
  if (!afterNavigation.accepted)
    assert.equal(afterNavigation.protocolCode, -32602);
  results.push({
    case: 'navigation-before-continue',
    outcome: afterNavigation,
    terminalBeforeCommand: navigationTerminal ?? null,
    explanation:
      'Navigation is recorded independently and is not assumed to prove cancellation.',
  });

  const closing = await page('target-close-while-paused');
  const closed = await closing.begin('/case/close');
  const closingRequest = await fetch(
    `http://127.0.0.1:${debugPort}/json/close/${closing.target.id}`,
  );
  assert.ok(closingRequest.ok);
  await until(() => closing.closed, 'target-close observed');
  const afterClose = await closing.continue(closed);
  assert.equal(afterClose.accepted, false);
  assert.equal(
    afterClose.protocolCode,
    null,
    'Closing a target is not falsely called an Invalid InterceptionId',
  );
  results.push({
    case: 'target-close-before-continue',
    outcome: afterClose,
    socketClosed: closing.closed,
  });

  const guardedNormal = await page('guarded-normal-and-duplicate');
  const normalGuarded = await guardedNormal.begin('/case/guarded-normal');
  guardedNormal.guarded(normalGuarded);
  await guardedNormal.lifecycle.drain();
  await until(
    () => guardedNormal.evaluate('window.fixtureState === "finished"'),
    'guarded normal response completes',
  );
  guardedNormal.guarded(normalGuarded);
  await guardedNormal.lifecycle.drain();
  assert.deepEqual(guardedNormal.guardedFaults, []);
  assert.equal(sentFor(guardedNormal.label, normalGuarded.requestId), 1);
  assert.equal(guardedNormal.lifecycle.snapshot().duplicates, 1);
  results.push({
    case: 'guarded-normal-and-injected-duplicate-event',
    evidence:
      'One actual paused browser request; its event is deliberately delivered twice to the helper.',
    state: guardedNormal.lifecycle.snapshot(),
  });

  const guardedAbort = await page('guarded-abort-while-handler-pending');
  const abortGuarded = await guardedAbort.begin('/case/guarded-abort');
  const abortGate = gate();
  guardedAbort.guarded(abortGuarded, () => abortGate.promise);
  await guardedAbort.evaluate('window.fixtureAbort.abort()');
  const guardedAbortTerminal = await until(
    () => guardedAbort.terminal.get(abortGuarded.networkId!),
    'guarded cancellation evidence',
  );
  assert.equal(guardedAbortTerminal.canceled, true);
  abortGate.release();
  await guardedAbort.lifecycle.drain();
  assert.deepEqual(guardedAbort.guardedFaults, []);
  assert.equal(
    sentFor(guardedAbort.label, abortGuarded.requestId),
    0,
    'Proven cancelled request is not continued with a stale ID.',
  );
  assert.equal(guardedAbort.lifecycle.snapshot().cancellations, 1);
  results.push({
    case: 'guarded-cancel-before-command',
    evidence:
      'Actual AbortController and same-request canceled event precede releasing the held handler.',
    state: guardedAbort.lifecycle.snapshot(),
  });

  const guardedNavigation = await page('guarded-navigation-without-terminal');
  const navigationGuarded = await guardedNavigation.begin(
    '/case/guarded-navigation',
  );
  const navigationGate = gate();
  guardedNavigation.guarded(navigationGuarded, () => navigationGate.promise);
  await guardedNavigation.send('Page.navigate', {
    url: `${origin}/replacement`,
  });
  await until(
    () =>
      guardedNavigation.evaluate(
        'location.pathname === "/replacement" && document.readyState === "complete"',
      ),
    'guarded navigation completes',
  );
  navigationGate.release();
  await guardedNavigation.lifecycle.drain();
  assert.deepEqual(guardedNavigation.guardedFaults, []);
  assert.equal(
    sentFor(guardedNavigation.label, navigationGuarded.requestId),
    1,
  );
  results.push({
    case: 'guarded-navigation-is-not-cancellation',
    evidence: 'Navigation alone does not suppress a valid held request.',
    state: guardedNavigation.lifecycle.snapshot(),
  });

  const guardedCleanup = await page('guarded-cleanup-pending-handler');
  const cleanupGuarded = await guardedCleanup.begin('/case/guarded-cleanup');
  const cleanupGate = gate();
  guardedCleanup.guarded(cleanupGuarded, () => cleanupGate.promise);
  guardedCleanup.lifecycle.observe('Fixture.cleanupStarted');
  let cleanupDrained = false;
  const cleanupDraining = guardedCleanup.lifecycle.drain().then(() => {
    cleanupDrained = true;
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(
    cleanupDrained,
    false,
    'Cleanup waits for already admitted asynchronous handlers.',
  );
  cleanupGate.release();
  await cleanupDraining;
  assert.deepEqual(guardedCleanup.guardedFaults, []);
  assert.equal(sentFor(guardedCleanup.label, cleanupGuarded.requestId), 1);
  results.push({
    case: 'guarded-cleanup-waits-for-handler',
    evidence:
      'Cleanup begins while an actual request handler is held; drain does not resolve early.',
    state: guardedCleanup.lifecycle.snapshot(),
  });

  const guardedClose = await page('guarded-closed-target-is-strict-fault');
  const closeGuarded = await guardedClose.begin('/case/guarded-close');
  const closeGate = gate();
  guardedClose.guarded(closeGuarded, () => closeGate.promise);
  assert.ok(
    (
      await fetch(
        `http://127.0.0.1:${debugPort}/json/close/${guardedClose.target.id}`,
      )
    ).ok,
  );
  await until(() => guardedClose.closed, 'guarded actual target closes');
  closeGate.release();
  await guardedClose.lifecycle.drain();
  assert.equal(
    guardedClose.guardedFaults.length,
    1,
    'Closed transport is not silently accepted as a proven cancelled request.',
  );
  results.push({
    case: 'guarded-target-close-remains-fault',
    evidence:
      'Actual target-close while a handler is pending; absence of a correlated cancellation remains a strict failure.',
    state: guardedClose.lifecycle.snapshot(),
  });

  const guardedInvalid = await page(
    'guarded-unknown-invalid-id-is-strict-fault',
  );
  const invalidGuarded = await guardedInvalid.begin('/case/guarded-invalid');
  assert.equal((await guardedInvalid.continue(invalidGuarded)).accepted, true);
  await until(
    () => guardedInvalid.evaluate('window.fixtureState === "finished"'),
    'request completes before deliberately invalid ID',
  );
  const deliberatelyInvalid = {
    ...invalidGuarded,
    requestId: 'fixture-intentionally-invalid-interception-id',
  };
  guardedInvalid.guarded(deliberatelyInvalid);
  await guardedInvalid.lifecycle.drain();
  assert.equal(
    guardedInvalid.guardedFaults.length,
    1,
    'An unproven -32602 remains a strict failure.',
  );
  assert.equal(guardedInvalid.lifecycle.snapshot().cancellations, 0);
  results.push({
    case: 'guarded-injected-invalid-id-remains-fault',
    evidence:
      'An intentionally malformed Fetch ID is sent to real Chromium; this is fault injection, not an observed duplicate provider event.',
    state: guardedInvalid.lifecycle.snapshot(),
  });
  for (const probe of pages)
    assert.deepEqual(
      probe.faults,
      [],
      `${probe.label}: uncontrolled request handling errors`,
    );
} catch (error: any) {
  failure = error?.stack ?? String(error);
  process.exitCode = 1;
} finally {
  for (const probe of pages)
    if (probe.socket.readyState === WebSocket.OPEN) probe.socket.close();
  if (chrome?.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([once(chrome, 'exit'), pause(3000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  const receipt = {
    evidenceKind:
      'actual Chromium with deliberately scheduled local fixture requests, not CI incident replay',
    chromium: execFileSync(executable, ['--version'], {
      encoding: 'utf8',
    }).trim(),
    node: process.version,
    startedAtUtc,
    finishedAtUtc: new Date().toISOString(),
    sourceHashes,
    status: failure ? 'failure' : 'success',
    failure: failure ?? null,
    results,
    serverRequests,
    records,
  };
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      join(evidenceDirectory, 'receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  console.log(
    JSON.stringify(
      {
        ...receipt,
        results: results.map(({ state, ...value }) => ({
          ...value,
          ...(state
            ? {
                state: {
                  inFlight: (state as any).inFlight,
                  faults: (state as any).faults,
                  cancellations: (state as any).cancellations,
                  duplicates: (state as any).duplicates,
                },
              }
            : {}),
        })),
        records: undefined,
      },
      null,
      2,
    ),
  );
  await rm(directory, { recursive: true, force: true });
}
