/** Test-only CDP request ownership. No URL queries, headers or bodies are retained. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

type Paused = {
  requestId: string;
  networkId?: string;
  resourceType?: string;
  responseStatusCode?: number;
  responseErrorReason?: string;
  request: { url: string; method: string };
};
export type InterceptionRecord = {
  fetchId: string;
  networkId?: string;
  generation: number;
  local: boolean;
  path: string;
  method: string;
  resource: string;
  terminal?: 'cancelled' | 'failed' | 'finished';
  action?: string;
  commandId?: number;
  state: 'handling' | 'done' | 'fault';
};
const actions = new Set([
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
]);
const paths = new Set([
  '/favicon.ico',
  '/favicon.svg',
  '/controlled',
  '/auth/status',
  '/auth/logout',
  '/auth/google/start',
  '/auth/google/callback',
  '/api/browser-session',
  '/api/events',
  '/api/status',
  '/api/health',
  '/auth/session/page',
  '/fixture/cdp/request',
]);
const resources = new Set([
  'Document',
  'Script',
  'Stylesheet',
  'Image',
  'Fetch',
  'XHR',
  'EventSource',
  'Other',
]);

export class CdpInterceptionLifecycle {
  private fingerprints = new WeakMap<InterceptionRecord, string>();
  private records = new Map<string, InterceptionRecord>();
  private networks = new Map<string, InterceptionRecord>();
  // A redirect/reused Network ID is ambiguous; it cannot attest cancellation.
  private ambiguous = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private waiters = new Set<() => void>();
  private trace: Record<string, unknown>[] = [];
  private sequence = 0;
  private generation = 0;
  private started = performance.now();
  private faults = 0;
  private cancellations = 0;
  private duplicates = 0;
  private droppedTrace = 0;
  private options: {
    pageId: string;
    origin: string;
    onFault: (fault: string) => void;
    cancellationWaitMs?: number;
    traceLimit?: number;
    maxRecords?: number;
  };
  constructor(options: CdpInterceptionLifecycle['options']) {
    this.options = options;
  }

  private note(
    event: string,
    record?: InterceptionRecord,
    extra: Record<string, unknown> = {},
  ) {
    this.trace.push({
      seq: ++this.sequence,
      ms: Number((performance.now() - this.started).toFixed(3)),
      page: this.options.pageId,
      generation: record?.generation ?? this.generation,
      event,
      ...(record
        ? {
            fetchId: record.fetchId,
            networkId: record.networkId,
            path: record.path,
            resource: record.resource,
            method: record.method,
          }
        : {}),
      ...extra,
    });
    if (this.trace.length > (this.options.traceLimit ?? 2048)) {
      this.trace.shift();
      this.droppedTrace++;
    }
  }
  private fault(
    code: string,
    record?: InterceptionRecord,
    extra: Record<string, unknown> = {},
  ) {
    this.faults++;
    this.note(code, record, extra);
    this.options.onFault(
      `Offline interception failed: ${code}/page=${this.options.pageId}/fetch=${record?.fetchId ?? 'none'}/network=${record?.networkId ?? 'none'}/action=${record?.action ?? 'none'}/command=${record?.commandId ?? 'none'}/path=${record?.path ?? 'none'}`,
    );
  }
  observe(method: string, params: any = {}) {
    if (method === 'Page.frameNavigated') {
      if (!params.frame?.parentId) this.generation++;
      this.note('navigation', undefined, {
        frameId: params.frame?.id,
        loaderId: params.frame?.loaderId,
      });
    } else if (method === 'Network.requestWillBeSent') {
      if (params.redirectResponse && this.networks.has(params.requestId)) {
        this.ambiguous.add(params.requestId);
        this.note('redirect', this.networks.get(params.requestId));
      }
    } else if (
      method === 'Network.loadingFailed' ||
      method === 'Network.loadingFinished'
    ) {
      const record = this.networks.get(params.requestId);
      const terminal =
        method === 'Network.loadingFinished'
          ? 'finished'
          : params.canceled === true
            ? 'cancelled'
            : 'failed';
      // Never borrow a terminal event across page objects, unknown requests or redirects.
      if (record && !this.ambiguous.has(params.requestId))
        record.terminal = terminal;
      this.note(terminal, record, {
        networkId: params.requestId,
        ambiguous: this.ambiguous.has(params.requestId),
      });
      for (const notify of this.waiters) notify();
    } else if (
      method === 'Inspector.detached' ||
      method === 'Fixture.transportClosed' ||
      method === 'Fixture.cleanupStarted'
    ) {
      // Closing/navigation intentions alone never justify ignoring a command error.
      this.note(method);
    }
  }
  run(
    event: Paused,
    handler: (record: InterceptionRecord) => Promise<void>,
  ): void {
    let url: URL;
    try {
      url = new URL(event.request.url);
    } catch {
      this.fault('INVALID_REQUEST_URL');
      return;
    }
    const record: InterceptionRecord = {
      fetchId: event.requestId,
      networkId: event.networkId,
      generation: this.generation,
      local: url.origin === this.options.origin,
      path: paths.has(url.pathname) ? url.pathname : 'asset-or-other',
      method: [
        'GET',
        'POST',
        'PUT',
        'HEAD',
        'DELETE',
        'OPTIONS',
        'PATCH',
      ].includes(event.request.method)
        ? event.request.method
        : 'OTHER',
      resource: resources.has(event.resourceType ?? '')
        ? event.resourceType!
        : 'OTHER_RESOURCE',
      state: 'handling',
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          event.request.url,
          event.request.method,
          event.networkId,
          event.resourceType,
          event.responseStatusCode,
          event.responseErrorReason,
        ]),
      )
      .digest('hex');
    const previous = this.records.get(event.requestId);
    if (previous) {
      this.duplicates++;
      this.note('duplicate-paused', previous);
      if (
        this.fingerprints.get(previous) !== fingerprint ||
        previous.networkId !== record.networkId ||
        previous.method !== record.method ||
        previous.path !== record.path ||
        previous.local !== record.local ||
        previous.resource !== record.resource ||
        event.responseStatusCode !== undefined ||
        event.responseErrorReason !== undefined
      )
        this.fault('DUPLICATE_PAUSED_CONFLICT', previous);
      return;
    }
    const maximum = this.options.maxRecords ?? 1024;
    if (this.records.size >= maximum) {
      // Fail closed instead of evicting IDs and accidentally reissuing a late command.
      this.fault('INTERCEPTION_CAPACITY');
      return;
    }
    this.fingerprints.set(record, fingerprint);
    this.records.set(record.fetchId, record);
    if (record.networkId) {
      if (this.networks.has(record.networkId))
        this.ambiguous.add(record.networkId);
      this.networks.set(record.networkId, record);
    }
    this.note('paused', record);
    let task: Promise<void>;
    task = Promise.resolve()
      .then(async () => {
        try {
          if (
            event.responseStatusCode !== undefined ||
            event.responseErrorReason !== undefined
          )
            throw new Error('UNEXPECTED_RESPONSE_STAGE');
          await handler(record);
          if (!record.action) throw new Error('MISSING_TERMINAL_COMMAND');
          record.state = 'done';
          this.note('handled', record);
        } catch (error) {
          record.state = 'fault';
          const value = error as Error & { protocolCode?: number };
          this.fault(
            ['DUPLICATE_TERMINAL_COMMAND', 'MISSING_TERMINAL_COMMAND'].includes(value.message)
              ? value.message
              : /Invalid InterceptionId/.test(value.message)
                ? 'INVALID_INTERCEPTION_ID'
                : value.name === 'AssertionError'
                  ? 'FIXTURE_ASSERTION'
                  : 'INTERCEPTION_ERROR',
            record,
            {
              errorCode: value.protocolCode ?? null,
              errorKind: /Invalid InterceptionId/.test(value.message)
                ? 'INVALID_INTERCEPTION_ID'
                : value.name === 'AssertionError'
                  ? 'FIXTURE_ASSERTION'
                  : 'COMMAND_OR_HANDLER_FAILURE',
            },
          );
        }
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }
  private cancelled(record: InterceptionRecord) {
    return (
      record.local &&
      record.networkId !== undefined &&
      this.networks.get(record.networkId) === record &&
      !this.ambiguous.has(record.networkId) &&
      record.terminal === 'cancelled'
    );
  }
  async command<T>(
    record: InterceptionRecord,
    method: string,
    commandId: number,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!actions.has(method)) {
      this.note('aux-command', record, { action: method, commandId });
      return action();
    }
    if (record.action) throw new Error('DUPLICATE_TERMINAL_COMMAND');
    record.action = method;
    record.commandId = commandId;
    if (this.cancelled(record)) {
      this.cancellations++;
      this.note('cancelled-before-command', record, {
        action: method,
        commandId,
      });
      return undefined;
    }
    this.note('command', record, { action: method, commandId });
    try {
      const value = await action();
      this.note('command-ok', record, { action: method, commandId });
      return value;
    } catch (error) {
      const value = error as Error & { protocolCode?: number };
      this.note('command-error', record, {
        action: method,
        commandId,
        errorCode: value.protocolCode ?? null,
        invalidId: /Invalid InterceptionId/.test(value.message),
      });
      if (
        record.local &&
        record.networkId &&
        value.protocolCode === -32602 &&
        /Invalid InterceptionId/.test(value.message)
      ) {
        if (!this.cancelled(record)) await this.waitForCancellation(record);
        if (this.cancelled(record)) {
          this.cancellations++;
          this.note('confirmed-cancelled-command', record, {
            action: method,
            commandId,
          });
          return undefined;
        }
      }
      throw error;
    }
  }
  private async waitForCancellation(record: InterceptionRecord) {
    const timeout = this.options.cancellationWaitMs ?? 150;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(notify);
        resolve();
      };
      const notify = () => {
        if (this.cancelled(record)) finish();
      };
      const timer = setTimeout(finish, timeout);
      this.waiters.add(notify);
      notify();
    });
  }
  async drain(timeoutMs = 10000) {
    const deadline = performance.now() + timeoutMs;
    let quietTurns = 0;
    while (quietTurns < 2) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        this.fault('CDP_INTERCEPTION_DRAIN_TIMEOUT');
        throw new Error('CDP_INTERCEPTION_DRAIN_TIMEOUT');
      }
      const sequence = this.sequence;
      if (this.inFlight.size) {
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          Promise.all([...this.inFlight]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]).finally(() => clearTimeout(timer));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      quietTurns =
        !this.inFlight.size && sequence === this.sequence ? quietTurns + 1 : 0;
    }
  }
  snapshot() {
    return {
      pageId: this.options.pageId,
      generation: this.generation,
      inFlight: this.inFlight.size,
      faults: this.faults,
      cancellations: this.cancellations,
      duplicates: this.duplicates,
      droppedTrace: this.droppedTrace,
      records: [...this.records.values()].map((record) => ({ ...record })),
      trace: [...this.trace],
    };
  }
}
