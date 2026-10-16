// Test-fixture diagnostics only. Never copy arbitrary provider/browser objects:
// request URLs, headers, bodies, errors and call text are intentionally excluded.
const events = new Set([
  'request-start', 'request-response', 'request-complete',
  'sse-created', 'sse-open', 'sse-close', 'sse-event',
  'media-disconnect', 'boundary', 'ready', 'failure',
  'cleanup-start', 'cleanup-end', 'gate-held', 'gate-released',
  'provider-hangup', 'server-call',
]);

const integerFields = new Set([
  'page', 'request', 'stream', 'call', 'sequence', 'count',
  'voiceReservations', 'providerHangups', 'revocations',
  'bootstrapStarted', 'bootstrapCompleted', 'bootstrapPending',
  'sseOpened', 'sseReceived', 'sseCurrent', 'epoch', 'statusCode',
]);
const timeFields = new Set(['readCompletedMs', 'atMs', 'documentTimeOrigin']);
const booleanFields = new Set([
  'managerBlocked', 'serverActive', 'busy', 'sdkClosed', 'muteEnabled',
  'startEnabled', 'endEnabled', 'hidden', 'connected', 'cleanupPending',
  'readPending',
]);
const enumFields: Record<string, ReadonlySet<string>> = {
  phase: new Set([
    'loading', 'readonly', 'acquiring', 'ready', 'preparing', 'connecting',
    'active', 'ending', 'logging-out', 'disposed',
  ]),
  callStatus: new Set([
    'unknown', 'none', 'connecting', 'ringing', 'active', 'ending',
    'completed', 'failed',
  ]),
  controllerMode: new Set(['held', 'available', 'unknown']),
  route: new Set(['browser-session', 'events', 'hangup', 'revoke', 'renew', 'other']),
  eventKind: new Set(['snapshot', 'call', 'error', 'other']),
  scenario: new Set([
    'baseline', 'bootstrap-held', 'sse-held', 'refresh-ready',
    'late-result', 'cleanup',
  ]),
  scope: new Set(['server', 'page', 'fixture']),
};
const fieldNames = [
  ...integerFields, ...timeFields, ...booleanFields, ...Object.keys(enumFields),
];

export class ControlledBrowserTrace {
  private readonly limit: number;
  private readonly records: Record<string, unknown>[] = [];
  private sequence = 0;
  private dropped = 0;

  constructor(limit = 512) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('Invalid trace capacity');
    this.limit = limit;
  }

  add(event: string, fields: Record<string, unknown> = {}): void {
    if (!events.has(event)) throw new Error('Invalid trace event');
    const record: Record<string, unknown> = {
      seq: ++this.sequence,
      timeMs: performance.now(),
      event,
    };
    if (fields && typeof fields === 'object') {
      for (const name of fieldNames) {
        // Only data properties are eligible. Accessors cannot execute arbitrary
        // browser/provider code or expose their thrown text through diagnostics.
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(fields, name);
        } catch {
          continue;
        }
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
        const value: unknown = descriptor.value;
        if (integerFields.has(name)) {
          if (typeof value === 'number' && Number.isSafeInteger(value) &&
              value >= 0 && (name !== 'statusCode' || value <= 599))
            record[name] = value;
        } else if (timeFields.has(name)) {
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
            record[name] = value;
        } else if (booleanFields.has(name)) {
          if (typeof value === 'boolean') record[name] = value;
        } else if (typeof value === 'string' && enumFields[name]?.has(value)) {
          record[name] = value;
        }
      }
    }
    this.records.push(record);
    if (this.records.length > this.limit) {
      this.records.shift();
      this.dropped += 1;
    }
  }

  snapshot(): { events: Record<string, unknown>[]; dropped: number } {
    return { events: this.records.map((record) => ({ ...record })), dropped: this.dropped };
  }
}
