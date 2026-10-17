import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import type {
  LiveTranslateSendEventType,
  LiveTranslateSendReason,
} from './livetranslate-send-pump';

/** Metadata only: a local write callback is NOT a supplier receipt. */
export const LIVE_TRANSLATE_DIAGNOSTIC_RING_RECORDS = 256;
export const LIVE_TRANSLATE_DIAGNOSTIC_WINDOW_RECORDS = 24;
export const LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOWS = 6;
export const LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES = 32768;
export const LIVE_TRANSLATE_EVENT_LOOP_RESOLUTION_MS = 20;
export type LiveTranslateSendDiagnosticTrigger =
  | 'backlog_warning'
  | 'send_failure'
  | 'normal_end'
  | 'cancelled'
  | 'transport_closed'
  | 'late_callback';
export type LiveTranslateSendDiagnosticRecord = {
  at: number;
  monotonicAtMs: number;
  recordSequence: number;
  stage:
    | 'send_accepted'
    | 'send_started'
    | 'send_written'
    | 'send_waiting'
    | 'send_failed'
    | 'send_cancelled'
    | 'transport_closed'
    | 'diagnostic_end'
    | 'raw_callback';
  eventType: LiveTranslateSendEventType;
  sendSequence: number;
  callbackDisposition: 'first' | 'duplicate' | 'late' | null;
  callbackDuplicate: boolean | null;
  callbackAfterStop: boolean | null;
  callbackError: boolean | null;
  callbackErrorCode:
    | 'EPIPE'
    | 'ECONNRESET'
    | 'ETIMEDOUT'
    | 'ERR_STREAM_DESTROYED'
    | 'other'
    | null;
  callbackDurationMs: number | null;
  callbackAt: number | null;
  callbackMonotonicAtMs: number | null;
  contiguousWrittenSequence: number;
  firstUnconfirmedSequence: number | null;
  prefixGapSequence: number | null;
  completedBehindGapFrames: number;
  /** Age of the oldest accepted frame not yet continuously released, matching
   * the original 2s protection frontier; not the oldest missing raw callback. */
  oldestUnfinishedAgeMs: number | null;
  queuedFrames: number;
  inFlightFrames: number;
  acceptedAudioBytes: number;
  writtenAudioBytes: number;
  pendingAudioBytes: number;
  pendingWireBytes: number;
  readyState: number | null;
  webSocketBufferedBytes: number | null;
  senderBufferedBytes: number | null;
  writableBufferedBytes: number | null;
  perMessageDeflate: boolean | null;
  eventLoopSampleCount: number | null;
  eventLoopMeanMs: number | null;
  eventLoopMaxMs: number | null;
  sendReason: LiveTranslateSendReason | null;
  closeCode: number | null;
};
export type LiveTranslateSendDiagnostic = {
  schemaVersion: 1;
  connectionOrdinal: 1;
  trigger: LiveTranslateSendDiagnosticTrigger;
  at: number;
  monotonicAtMs: number;
  sendSequence: number;
  records: LiveTranslateSendDiagnosticRecord[];
  /** Fixed metadata anchors, not proof the preceding callback caused failure. */
  firstFailure: {
    failure: LiveTranslateSendDiagnosticRecord;
    precedingRawCallback: LiveTranslateSendDiagnosticRecord | null;
  } | null;
  summary: {
    recordedRecords: number;
    overwrittenRecords: number;
    emittedWindows: number;
    rawCallbackCount: number;
    rawCallbackErrorCount: number;
    lateCallbackCount: number;
    duplicateCallbackCount: number;
    peakPendingAudioBytes: number;
    peakSenderBufferedBytes: number | null;
    peakWritableBufferedBytes: number | null;
    monitorStopped: boolean | null;
    windowTruncatedRecords: number;
    windowContextOmittedRecords: number;
    truncatedRecords: number;
    suppressedRecords: number;
    suppressedWindows: number;
    projectionRejectedWindows: number;
    sinkErrorWindows: number;
    observedThroughRecordSequence: number;
    captureEnded: boolean;
    /** Future suppressed tail is not observable at this window's cutoff. */
    futureSuppressedRecords: null;
  };
};
export type SendDiagnosticState = Pick<
  LiveTranslateSendDiagnosticRecord,
  | 'stage'
  | 'eventType'
  | 'sendSequence'
  | 'callbackDisposition'
  | 'callbackDuplicate'
  | 'callbackAfterStop'
  | 'callbackError'
  | 'callbackErrorCode'
  | 'callbackDurationMs'
  | 'callbackAt'
  | 'callbackMonotonicAtMs'
  | 'contiguousWrittenSequence'
  | 'firstUnconfirmedSequence'
  | 'prefixGapSequence'
  | 'completedBehindGapFrames'
  | 'oldestUnfinishedAgeMs'
  | 'queuedFrames'
  | 'inFlightFrames'
  | 'acceptedAudioBytes'
  | 'writtenAudioBytes'
  | 'pendingAudioBytes'
  | 'pendingWireBytes'
  | 'sendReason'
  | 'closeCode'
>;
type EventLoopMonitor = {
  enable(): unknown;
  disable(): unknown;
  readonly count?: number;
  readonly mean: number;
  readonly max: number;
};
type Options = {
  socket: unknown;
  onDiagnostic: (event: LiveTranslateSendDiagnostic) => void;
  now?: () => number;
  monotonicNow?: () => number;
  /** Offline injection only. Production uses Node's read-only event-loop histogram. */
  createMonitor?: () => EventLoopMonitor;
};
const count = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const nullableCount = (v: unknown): v is number | null =>
  v === null || count(v);
const nullableBool = (v: unknown): v is boolean | null =>
  v === null || typeof v === 'boolean';
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
const own = (o: unknown, key: PropertyKey): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && 'value' in d ? d.value : undefined;
};
const stages = [
  'send_accepted',
  'send_started',
  'send_written',
  'send_waiting',
  'send_failed',
  'send_cancelled',
  'transport_closed',
  'diagnostic_end',
  'raw_callback',
];
const eventTypes = [
  'session.update',
  'input_audio_buffer.append',
  'session.finish',
  'unknown',
];
const reasons = [
  null,
  'transport_not_open',
  'transport_buffer_limit',
  'pending_input_limit',
  'oldest_send_timeout',
  'write_callback_error',
  'write_throw',
];
const recordCounts = [
  'at',
  'monotonicAtMs',
  'recordSequence',
  'sendSequence',
  'contiguousWrittenSequence',
  'completedBehindGapFrames',
  'queuedFrames',
  'inFlightFrames',
  'acceptedAudioBytes',
  'writtenAudioBytes',
  'pendingAudioBytes',
  'pendingWireBytes',
] as const;
const recordNullableCounts = [
  'callbackDurationMs',
  'callbackAt',
  'callbackMonotonicAtMs',
  'firstUnconfirmedSequence',
  'prefixGapSequence',
  'oldestUnfinishedAgeMs',
  'readyState',
  'webSocketBufferedBytes',
  'senderBufferedBytes',
  'writableBufferedBytes',
  'eventLoopSampleCount',
  'eventLoopMeanMs',
  'eventLoopMaxMs',
  'closeCode',
] as const;
const summaryCounts = [
  'recordedRecords',
  'overwrittenRecords',
  'emittedWindows',
  'rawCallbackCount',
  'rawCallbackErrorCount',
  'lateCallbackCount',
  'duplicateCallbackCount',
  'peakPendingAudioBytes',
  'windowTruncatedRecords',
  'windowContextOmittedRecords',
  'truncatedRecords',
  'suppressedRecords',
  'suppressedWindows',
  'projectionRejectedWindows',
  'sinkErrorWindows',
  'observedThroughRecordSequence',
] as const;

function projectRecord(
  input: unknown,
): LiveTranslateSendDiagnosticRecord | undefined {
  const record: any = {};
  for (const key of recordCounts) {
    const v = own(input, key);
    if (!count(v)) return undefined;
    record[key] = v;
  }
  for (const key of recordNullableCounts) {
    const v = own(input, key);
    if (!nullableCount(v)) return undefined;
    record[key] = v;
  }
  for (const [key, allowed] of [
    ['stage', stages],
    ['eventType', eventTypes],
    ['callbackDisposition', [null, 'first', 'duplicate', 'late']],
    [
      'callbackErrorCode',
      [
        null,
        'EPIPE',
        'ECONNRESET',
        'ETIMEDOUT',
        'ERR_STREAM_DESTROYED',
        'other',
      ],
    ],
    ['sendReason', reasons],
  ] as const) {
    const v = own(input, key);
    if (!oneOf(v, allowed)) return undefined;
    record[key] = v;
  }
  for (const key of [
    'callbackError',
    'callbackDuplicate',
    'callbackAfterStop',
    'perMessageDeflate',
  ]) {
    const v = own(input, key);
    if (!nullableBool(v)) return undefined;
    record[key] = v;
  }
  return record;
}

/** A fresh scalar-only whitelist. Accessor properties are never invoked; thrown
 * proxies and invalid or oversized records fail closed at the diagnostic boundary. */
function projectDiagnosticValue(
  value: unknown,
): LiveTranslateSendDiagnostic | undefined {
  try {
    if (
      own(value, 'schemaVersion') !== 1 ||
      own(value, 'connectionOrdinal') !== 1 ||
      !oneOf(own(value, 'trigger'), [
        'backlog_warning',
        'send_failure',
        'normal_end',
        'cancelled',
        'transport_closed',
        'late_callback',
      ])
    )
      return undefined;
    const out: any = {
      schemaVersion: 1,
      connectionOrdinal: 1,
      trigger: own(value, 'trigger'),
    };
    for (const key of ['at', 'monotonicAtMs', 'sendSequence']) {
      const v = own(value, key);
      if (!count(v)) return undefined;
      out[key] = v;
    }
    const records = own(value, 'records');
    if (!Array.isArray(records)) return undefined;
    const length = own(records, 'length');
    if (
      !Number.isInteger(length) ||
      (length as number) < 1 ||
      (length as number) > LIVE_TRANSLATE_DIAGNOSTIC_WINDOW_RECORDS
    )
      return undefined;
    out.records = [];
    for (let i = 0; i < (length as number); i += 1) {
      const record = projectRecord(own(records, String(i)));
      if (!record) return undefined;
      out.records.push(record);
    }
    const inputFailure = own(value, 'firstFailure');
    out.firstFailure = null;
    if (inputFailure !== null) {
      const failure = projectRecord(own(inputFailure, 'failure'));
      const inputCallback = own(inputFailure, 'precedingRawCallback');
      const callback =
        inputCallback === null ? null : projectRecord(inputCallback);
      if (
        !failure ||
        failure.stage !== 'send_failed' ||
        callback === undefined ||
        (callback && callback.stage !== 'raw_callback')
      )
        return undefined;
      out.firstFailure = { failure, precedingRawCallback: callback };
    }
    const inputSummary = own(value, 'summary');
    const summary: any = {};
    for (const key of summaryCounts) {
      const v = own(inputSummary, key);
      if (!count(v)) return undefined;
      summary[key] = v;
    }
    for (const key of [
      'peakSenderBufferedBytes',
      'peakWritableBufferedBytes',
    ]) {
      const v = own(inputSummary, key);
      if (!nullableCount(v)) return undefined;
      summary[key] = v;
    }
    const stopped = own(inputSummary, 'monitorStopped');
    if (!nullableBool(stopped)) return undefined;
    summary.monitorStopped = stopped;
    const captureEnded = own(inputSummary, 'captureEnded');
    if (
      typeof captureEnded !== 'boolean' ||
      own(inputSummary, 'futureSuppressedRecords') !== null
    )
      return undefined;
    summary.captureEnded = captureEnded;
    summary.futureSuppressedRecords = null;
    if (summary.emittedWindows > LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOWS)
      return undefined;
    out.summary = summary;
    return out;
  } catch {
    return undefined;
  }
}

/** Strict external projection retains its hard payload boundary. */
export function projectLiveTranslateSendDiagnostic(
  value: unknown,
): LiveTranslateSendDiagnostic | undefined {
  const out = projectDiagnosticValue(value);
  return out &&
    Buffer.byteLength(JSON.stringify(out)) <=
      LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES
    ? out
    : undefined;
}

/** Scalar whitelist first, then discard only oldest context records. The newest
 * record and both first-failure anchors survive; never truncate individual fields. */
export function fitLiveTranslateSendDiagnostic(
  value: unknown,
  maxBytes = LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES,
): LiveTranslateSendDiagnostic | undefined {
  try {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES
    )
      return undefined;
    const out = projectDiagnosticValue(value);
    if (!out) return undefined;
    while (Buffer.byteLength(JSON.stringify(out)) > maxBytes) {
      if (out.records.length <= 1) return undefined;
      if (
        !Number.isSafeInteger(out.summary.windowTruncatedRecords) ||
        out.summary.windowTruncatedRecords >= Number.MAX_SAFE_INTEGER
      )
        return undefined;
      out.records.shift();
      out.summary.windowTruncatedRecords += 1;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Nothing retained here contains wire messages, PCM, provider text or errors. */
export function createLiveTranslateSendDiagnostics(options: Options) {
  const now = options.now ?? Date.now;
  const mono = options.monotonicNow ?? (() => performance.now());
  const ring: (LiveTranslateSendDiagnosticRecord | undefined)[] = new Array(
    LIVE_TRANSLATE_DIAGNOSTIC_RING_RECORDS,
  );
  let cursor = 0;
  let retained = 0;
  let recorded = 0;
  let observed = 0;
  let overwritten = 0;
  let windows = 0;
  let warnings = 0;
  let lastWarning = -Infinity;
  let finished = false;
  let failureWindow = false;
  let terminalWindow = false;
  let lateWindow = false;
  let firstFailure: LiveTranslateSendDiagnostic['firstFailure'] = null;
  let precedingRawCallback: LiveTranslateSendDiagnosticRecord | null = null;
  let truncatedRecords = 0;
  let suppressedRecords = 0;
  let suppressedWindows = 0;
  let projectionRejectedWindows = 0;
  let sinkErrorWindows = 0;
  let rawCallbacks = 0;
  let errors = 0;
  let late = 0;
  let duplicates = 0;
  let peakPending = 0;
  let peakSender: number | null = null;
  let peakWritable: number | null = null;
  let monitor: EventLoopMonitor | undefined;
  let monitorStopped: boolean | null = true;
  let negotiatedDeflate: boolean | null = null;
  try {
    monitor = (
      options.createMonitor ??
      (() =>
        monitorEventLoopDelay({
          resolution: LIVE_TRANSLATE_EVENT_LOOP_RESOLUTION_MS,
        }))
    )();
    monitorStopped = false;
    monitor.enable();
  } catch {
    try {
      if (monitor) {
        monitor.disable();
        monitorStopped = true;
      }
    } catch {
      monitorStopped = null;
    }
    monitor = undefined;
  }
  const read = (fn: () => unknown): number | null => {
    try {
      const v = fn();
      return count(v) ? v : null;
    } catch {
      return null;
    }
  };
  const stopMonitor = () => {
    const old = monitor;
    monitor = undefined;
    if (!old) return;
    try {
      old.disable();
      monitorStopped = true;
    } catch {
      monitorStopped = null;
    }
  };
  const flush = (
    trigger: LiveTranslateSendDiagnosticTrigger,
    record: LiveTranslateSendDiagnosticRecord,
  ) => {
    if (windows >= LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOWS) {
      suppressedWindows += 1;
      return;
    }
    windows += 1;
    const window: LiveTranslateSendDiagnosticRecord[] = [];
    const size = Math.min(retained, LIVE_TRANSLATE_DIAGNOSTIC_WINDOW_RECORDS);
    for (let i = size; i > 0; i -= 1) {
      const r = ring[(cursor - i + ring.length) % ring.length];
      if (r) window.push(r);
    }
    if (!window.length) window.push(record);
    const candidate = {
      schemaVersion: 1,
      connectionOrdinal: 1,
      trigger,
      at: record.at,
      monotonicAtMs: record.monotonicAtMs,
      sendSequence: record.sendSequence,
      records: window,
      firstFailure,
      summary: {
        recordedRecords: recorded,
        overwrittenRecords: overwritten,
        emittedWindows: windows,
        rawCallbackCount: rawCallbacks,
        rawCallbackErrorCount: errors,
        lateCallbackCount: late,
        duplicateCallbackCount: duplicates,
        peakPendingAudioBytes: peakPending,
        peakSenderBufferedBytes: peakSender,
        peakWritableBufferedBytes: peakWritable,
        monitorStopped,
        windowTruncatedRecords: 0,
        windowContextOmittedRecords: Math.max(0, retained - size),
        truncatedRecords,
        suppressedRecords,
        suppressedWindows,
        projectionRejectedWindows,
        sinkErrorWindows,
        observedThroughRecordSequence: observed,
        captureEnded: finished,
        futureSuppressedRecords: null,
      },
    };
    // Serializing and calling a possibly slow log sink must not precede the
    // writer's existing synchronous callback deadline checks or prefix release.
    queueMicrotask(() => {
      try {
        candidate.firstFailure = firstFailure;
        candidate.summary.recordedRecords = recorded;
        candidate.summary.overwrittenRecords = overwritten;
        candidate.summary.rawCallbackCount = rawCallbacks;
        candidate.summary.rawCallbackErrorCount = errors;
        candidate.summary.lateCallbackCount = late;
        candidate.summary.duplicateCallbackCount = duplicates;
        candidate.summary.peakPendingAudioBytes = peakPending;
        candidate.summary.peakSenderBufferedBytes = peakSender;
        candidate.summary.peakWritableBufferedBytes = peakWritable;
        candidate.summary.monitorStopped = monitorStopped;
        candidate.summary.truncatedRecords = truncatedRecords;
        candidate.summary.suppressedRecords = suppressedRecords;
        candidate.summary.suppressedWindows = suppressedWindows;
        candidate.summary.projectionRejectedWindows = projectionRejectedWindows;
        candidate.summary.sinkErrorWindows = sinkErrorWindows;
        candidate.summary.observedThroughRecordSequence = observed;
        candidate.summary.captureEnded = finished;
        let event = fitLiveTranslateSendDiagnostic(candidate);
        if (!event) {
          projectionRejectedWindows += 1;
          return;
        }
        // Updating the producer-total digit count can itself consume bytes at
        // an exact boundary. Each iteration removes context, never the newest
        // record or anchors, and the record-count bound makes this finite.
        for (let i = 0; i < LIVE_TRANSLATE_DIAGNOSTIC_WINDOW_RECORDS; i += 1) {
          event.summary.truncatedRecords =
            truncatedRecords + event.summary.windowTruncatedRecords;
          if (
            Buffer.byteLength(JSON.stringify(event)) <=
            LIVE_TRANSLATE_DIAGNOSTIC_MAX_WINDOW_BYTES
          )
            break;
          event = fitLiveTranslateSendDiagnostic(event);
          if (!event) {
            projectionRejectedWindows += 1;
            return;
          }
        }
        truncatedRecords = event.summary.truncatedRecords;
        try {
          options.onDiagnostic(event);
        } catch {
          sinkErrorWindows += 1;
        }
      } catch {
        projectionRejectedWindows += 1;
        /* Diagnostic sinks never affect the writer. */
      }
    });
  };
  const record = (state: SendDiagnosticState) => {
    try {
      observed += 1;
      if (state.stage === 'raw_callback') {
        rawCallbacks += 1;
        if (state.callbackError) errors += 1;
        if (state.callbackAfterStop) late += 1;
        if (state.callbackDuplicate) duplicates += 1;
      }
      const isTerminal =
        state.stage === 'send_cancelled' ||
        state.stage === 'transport_closed' ||
        state.stage === 'diagnostic_end';
      if (
        finished &&
        !(!terminalWindow && isTerminal) &&
        !(state.stage === 'raw_callback' && !lateWindow)
      ) {
        suppressedRecords += 1;
        return;
      }
      let at: number;
      let monotonicAtMs: number;
      try {
        at = now();
        monotonicAtMs = mono();
      } catch {
        suppressedRecords += 1;
        return;
      }
      if (!count(at) || !count(monotonicAtMs)) {
        suppressedRecords += 1;
        return;
      }
      const { socket }: { socket: any } = options;
      // eslint-disable-next-line no-underscore-dangle -- Read-only ws 8.18 Sender counter; unavailable values remain null.
      const sender = read(() => socket?._sender?._bufferedBytes);
      // eslint-disable-next-line no-underscore-dangle -- Read-only underlying Node Writable public length; never a TCP or supplier acknowledgement.
      const writable = read(() => socket?._socket?.writableLength);
      const loopCount = read(() => monitor?.count);
      try {
        if (socket?.readyState === 1) {
          const v = socket?.extensions;
          if (typeof v === 'string')
            negotiatedDeflate = v
              .split(',')
              .some(
                (s: string) => s.trim().split(';')[0] === 'permessage-deflate',
              );
        }
      } catch {
        /* Keep last observed negotiated state or unknown. */
      }
      recorded += 1;
      const r: LiveTranslateSendDiagnosticRecord = {
        ...state,
        at,
        monotonicAtMs,
        recordSequence: observed,
        readyState: read(() => socket?.readyState),
        webSocketBufferedBytes: read(() => socket?.bufferedAmount),
        senderBufferedBytes: sender,
        writableBufferedBytes: writable,
        perMessageDeflate: negotiatedDeflate,
        eventLoopSampleCount: loopCount,
        eventLoopMeanMs:
          loopCount && loopCount > 0 ? read(() => monitor!.mean / 1e6) : null,
        eventLoopMaxMs:
          loopCount && loopCount > 0 ? read(() => monitor!.max / 1e6) : null,
      };
      peakPending = Math.max(peakPending, state.pendingAudioBytes);
      if (sender !== null) peakSender = Math.max(peakSender ?? 0, sender);
      if (writable !== null)
        peakWritable = Math.max(peakWritable ?? 0, writable);
      if (finished && state.stage === 'raw_callback') {
        lateWindow = true;
        flush('late_callback', r);
        return;
      }
      if (state.stage === 'raw_callback') precedingRawCallback = r;
      if (retained === ring.length) overwritten += 1;
      ring[cursor] = r;
      cursor = (cursor + 1) % ring.length;
      retained = Math.min(retained + 1, ring.length);
      let terminal: LiveTranslateSendDiagnosticTrigger | null = null;
      if (state.stage === 'send_cancelled') terminal = 'cancelled';
      if (state.stage === 'transport_closed') terminal = 'transport_closed';
      if (state.stage === 'diagnostic_end') terminal = 'normal_end';
      if (state.stage === 'send_failed' && !failureWindow) {
        failureWindow = true;
        firstFailure = { failure: r, precedingRawCallback };
        finished = true;
        stopMonitor();
        flush('send_failure', r);
        ring.fill(undefined);
        retained = 0;
        precedingRawCallback = null;
        return;
      }
      if (terminal && !terminalWindow) {
        terminalWindow = true;
        finished = true;
        stopMonitor();
        flush(terminal, r);
        ring.fill(undefined);
        retained = 0;
        precedingRawCallback = null;
        return;
      }
      if (
        (state.pendingAudioBytes >= 16000 ||
          (state.oldestUnfinishedAgeMs ?? 0) >= 500) &&
        r.monotonicAtMs - lastWarning >= 1000
      ) {
        lastWarning = r.monotonicAtMs;
        if (warnings < 3) {
          warnings += 1;
          flush('backlog_warning', r);
        } else suppressedWindows += 1;
      }
    } catch {
      /* Failed metadata reads, clocks and allocation never change transport behavior. */
    }
  };
  return {
    record,
    finish(
      state: SendDiagnosticState,
      trigger: 'normal_end' | 'cancelled' = 'normal_end',
    ) {
      try {
        record({
          ...state,
          stage: trigger === 'cancelled' ? 'send_cancelled' : 'diagnostic_end',
        });
      } catch {
        stopMonitor();
        ring.fill(undefined);
        retained = 0;
        finished = true;
      }
    },
    dispose() {
      finished = true;
      stopMonitor();
      ring.fill(undefined);
      retained = 0;
      precedingRawCallback = null;
    },
    snapshot: () => ({
      retainedRecords: retained,
      allocatedRecordSlots: ring.length,
      recordedRecords: recorded,
      emittedWindows: windows,
      finished,
      monitorStopped,
      observedThroughRecordSequence: observed,
      suppressedRecords,
      suppressedWindows,
      truncatedRecords,
      projectionRejectedWindows,
      sinkErrorWindows,
      futureSuppressedRecords: null,
    }),
  };
}
