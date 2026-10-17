import { performance } from 'node:perf_hooks';

import {
  createLiveTranslateSendDiagnostics,
  type LiveTranslateSendDiagnostic,
  type SendDiagnosticState,
} from './livetranslate-send-diagnostics';

/** Phone-only input protection, not a call duration or supplier usage limit. */
export const LIVE_TRANSLATE_PENDING_INPUT_BYTES = 64000;
export const LIVE_TRANSLATE_SEND_WAIT_MS = 2000;
export const LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES = 1024 * 1024;
const BUFFER_RECHECK_MS = 25;

export type LiveTranslateSendReason =
  | 'transport_not_open'
  | 'transport_buffer_limit'
  | 'pending_input_limit'
  | 'oldest_send_timeout'
  | 'write_callback_error'
  | 'write_throw';
export type LiveTranslateSendEventType =
  | 'session.update'
  | 'input_audio_buffer.append'
  | 'session.finish'
  | 'unknown';
export type SendObservation = {
  at: number;
  observedSequence: number;
  stage:
    | 'send_accepted'
    | 'send_started'
    | 'send_written'
    | 'send_waiting'
    | 'send_failed'
    | 'send_cancelled'
    | 'transport_closed';
  eventType: LiveTranslateSendEventType;
  sendSequence: number;
  audioBytes: number;
  acceptedAudioBytes: number;
  writtenAudioBytes: number;
  pendingAudioBytes: number;
  pendingWireBytes: number;
  readyState: number;
  bufferedBytes: number;
  queuedDurationMs: number;
  callbackDurationMs?: number;
  sendReason?: LiveTranslateSendReason;
  closeCode?: number;
};
export type SendFailure = SendObservation & {
  stage: 'send_failed';
  sendReason: LiveTranslateSendReason;
  code: 'LIVETRANSLATE_SEND_UNAVAILABLE' | 'LIVETRANSLATE_SEND_FAILED';
};
type SendItem = {
  wire: string;
  eventType: LiveTranslateSendEventType;
  audioBytes: number;
  sendSequence: number;
  acceptedAt: number;
  startedAt?: number;
  completed: boolean;
  rawCallbackSeen: boolean;
  callbackDurationMs?: number;
  waitingObserved: boolean;
  onWritten?: () => void;
};
type Timer = ReturnType<typeof setTimeout>;
type SendPumpOptions = {
  socket: {
    readyState: number;
    bufferedAmount: number;
    send(wire: string, callback: (error?: Error) => void): void;
  };
  now?: () => number;
  /** Internal clock/scheduler injection for deterministic offline tests only. */
  monotonicNow?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancelSchedule?: (timer: Timer) => void;
  onObservation?: (event: SendObservation) => void;
  onDiagnostic?: (event: LiveTranslateSendDiagnostic) => void;
  onFailure: (event: SendFailure) => void;
};

/** Each accepted frame gets one write attempt. A write callback establishes
 * local socket progress only; it is never a supplier receipt acknowledgement. */
export function createLiveTranslateSendPump(options: SendPumpOptions) {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const schedule: NonNullable<SendPumpOptions['schedule']> =
    options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const queue: SendItem[] = [];
  // ws preserves send-call order itself. Keep bounded callback receipts, but
  // do not gate the next audio frame on the preceding local write callback.
  const inFlight: SendItem[] = [];
  let timer: Timer | undefined;
  let stopped = false;
  let pumping = false;
  let closeObserved = false;
  let sendSequence = 0;
  let observedSequence = 0;
  let acceptedAudioBytes = 0;
  let writtenAudioBytes = 0;
  let pendingAudioBytes = 0;
  let pendingWireBytes = 0;
  let contiguousWrittenSequence = 0;
  // Diagnostic accounting only; never used by admission, timers or prefix release.
  let successfulCallbacksAwaitingPrefix = 0;
  const diagnostics = (() => {
    try {
      return options.onDiagnostic
        ? createLiveTranslateSendDiagnostics({
            socket: options.socket,
            now,
            monotonicNow,
            onDiagnostic: options.onDiagnostic,
          })
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const duration = (started: number) => Math.max(0, monotonicNow() - started);
  const diagnosticState = (
    stage: SendDiagnosticState['stage'],
    item?: SendItem,
    detail: Partial<SendDiagnosticState> = {},
  ): SendDiagnosticState => {
    const first = inFlight[0] ?? queue[0];
    const blocked =
      first && !first.completed ? successfulCallbacksAwaitingPrefix : 0;
    return {
      stage,
      eventType: item?.eventType ?? 'unknown',
      sendSequence: item?.sendSequence ?? sendSequence,
      callbackDisposition: null,
      callbackDuplicate: null,
      callbackAfterStop: null,
      callbackError: null,
      callbackErrorCode: null,
      callbackDurationMs: null,
      callbackAt: null,
      callbackMonotonicAtMs: null,
      contiguousWrittenSequence,
      firstUnconfirmedSequence: first?.sendSequence ?? null,
      prefixGapSequence: blocked ? first!.sendSequence : null,
      completedBehindGapFrames: blocked,
      oldestUnfinishedAgeMs: first ? duration(first.acceptedAt) : null,
      queuedFrames: queue.length,
      inFlightFrames: inFlight.length,
      acceptedAudioBytes,
      writtenAudioBytes,
      pendingAudioBytes,
      pendingWireBytes,
      sendReason: null,
      closeCode: null,
      ...detail,
    };
  };
  const diagnose = (
    stage: SendDiagnosticState['stage'],
    item?: SendItem,
    detail: Partial<SendDiagnosticState> = {},
  ) => {
    if (!diagnostics) return;
    try {
      diagnostics.record(diagnosticState(stage, item, detail));
    } catch {
      /* Diagnostic state cannot affect the writer. */
    }
  };
  const safeCount = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const sample = (
    stage: SendObservation['stage'],
    item?: SendItem,
    detail: Partial<SendObservation> = {},
  ): SendObservation => {
    observedSequence += 1;
    return {
      at: now(),
      observedSequence,
      stage,
      eventType: item?.eventType ?? 'unknown',
      sendSequence: item?.sendSequence ?? sendSequence,
      audioBytes: item?.audioBytes ?? 0,
      acceptedAudioBytes,
      writtenAudioBytes,
      pendingAudioBytes,
      pendingWireBytes,
      readyState: safeCount(options.socket.readyState),
      bufferedBytes: safeCount(options.socket.bufferedAmount),
      queuedDurationMs: item ? duration(item.acceptedAt) : 0,
      ...detail,
    };
  };
  const observe = (event: SendObservation, diagnosticItem?: SendItem) => {
    if (diagnostics)
      diagnose(event.stage, diagnosticItem, {
        eventType: event.eventType,
        sendSequence: event.sendSequence,
        ...(event.callbackDurationMs === undefined
          ? {}
          : { callbackDurationMs: event.callbackDurationMs }),
        sendReason: event.sendReason ?? null,
        closeCode: event.closeCode ?? null,
      });
    try {
      options.onObservation?.(event);
    } catch {
      // Observers cannot re-enable a failed writer or expose raw exceptions.
    }
  };
  const clear = () => {
    if (timer !== undefined) cancelSchedule(timer);
    timer = undefined;
    queue.length = 0;
    inFlight.length = 0;
    pendingAudioBytes = 0;
    pendingWireBytes = 0;
    successfulCallbacksAwaitingPrefix = 0;
  };
  const fail = (
    sendReason: LiveTranslateSendReason,
    item?: SendItem,
    callbackDurationMs?: number,
  ) => {
    if (stopped) return;
    const event: SendFailure = {
      ...sample('send_failed', item, {
        sendReason,
        ...(callbackDurationMs === undefined ? {} : { callbackDurationMs }),
      }),
      stage: 'send_failed',
      sendReason,
      code:
        sendReason === 'write_callback_error' || sendReason === 'write_throw'
          ? 'LIVETRANSLATE_SEND_FAILED'
          : 'LIVETRANSLATE_SEND_UNAVAILABLE',
    };
    stopped = true;
    diagnose('send_failed', item, {
      sendReason,
      callbackDurationMs: callbackDurationMs ?? null,
    });
    diagnostics?.dispose();
    clear();
    observe(event);
    try {
      options.onFailure(event);
    } catch {
      // The local stopped fence is authoritative even if cleanup throws.
    }
  };
  const oldest = () => inFlight[0] ?? queue[0];
  const arm = (recheckBuffer = false) => {
    if (timer !== undefined) cancelSchedule(timer);
    timer = undefined;
    const item = oldest();
    if (stopped || !item) return;
    const remaining = LIVE_TRANSLATE_SEND_WAIT_MS - duration(item.acceptedAt);
    timer = schedule(
      () => {
        timer = undefined;
        if (stopped) return;
        const pending = oldest();
        if (!pending) return;
        if (duration(pending.acceptedAt) >= LIVE_TRANSLATE_SEND_WAIT_MS) {
          fail(
            options.socket.bufferedAmount >
              LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES
              ? 'transport_buffer_limit'
              : 'oldest_send_timeout',
            pending,
            pending.startedAt === undefined
              ? undefined
              : duration(pending.startedAt),
          );
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- The scheduled callback invokes the hoisted writer after construction.
        pump();
      },
      Math.max(
        1,
        recheckBuffer ? Math.min(BUFFER_RECHECK_MS, remaining) : remaining,
      ),
    );
  };
  function pump() {
    if (stopped || pumping) return;
    pumping = true;
    try {
      while (!stopped && queue.length) {
        const item = queue[0];
        // Configuration and finish retain their existing callback barriers.
        // Only adjacent audio appends may have multiple outstanding writes.
        if (
          inFlight.length &&
          (item.eventType !== 'input_audio_buffer.append' ||
            inFlight[0].eventType !== 'input_audio_buffer.append')
        )
          break;
        if (options.socket.readyState !== 1) {
          fail('transport_not_open', item);
          break;
        }
        if (duration(item.acceptedAt) >= LIVE_TRANSLATE_SEND_WAIT_MS) {
          fail('oldest_send_timeout', item);
          break;
        }
        if (
          options.socket.bufferedAmount > LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES
        ) {
          if (!item.waitingObserved) {
            item.waitingObserved = true;
            observe(
              sample('send_waiting', item, {
                sendReason: 'transport_buffer_limit',
              }),
              item,
            );
          }
          arm(true);
          return;
        }
        queue.shift();
        inFlight.push(item);
        item.startedAt = monotonicNow();
        observe(sample('send_started', item), item);
        if (stopped || !inFlight.includes(item)) break;
        try {
          // eslint-disable-next-line @typescript-eslint/no-loop-func -- Each closure owns its const item; stopped/completed fences reject late or duplicate callbacks.
          options.socket.send(item.wire, (error) => {
            let callbackAt: number | null = null;
            let callbackMonotonicAtMs: number | null = null;
            if (diagnostics)
              try {
                callbackAt = now();
                callbackMonotonicAtMs = monotonicNow();
              } catch {
                /* Optional clocks only. */
              }
            const recordRawCallback = (callbackDurationMs: number | null) => {
              if (!diagnostics) return;
              try {
                let callbackErrorCode: SendDiagnosticState['callbackErrorCode'] =
                  null;
                if (error) {
                  try {
                    const code = Object.getOwnPropertyDescriptor(
                      error,
                      'code',
                    )?.value;
                    callbackErrorCode = [
                      'EPIPE',
                      'ECONNRESET',
                      'ETIMEDOUT',
                      'ERR_STREAM_DESTROYED',
                    ].includes(code)
                      ? code
                      : 'other';
                  } catch {
                    callbackErrorCode = 'other';
                  }
                }
                let callbackDisposition: SendDiagnosticState['callbackDisposition'] =
                  stopped ? 'late' : 'first';
                if (item.rawCallbackSeen) callbackDisposition = 'duplicate';
                diagnose('raw_callback', item, {
                  callbackDisposition,
                  callbackDuplicate: item.rawCallbackSeen,
                  callbackAfterStop: stopped,
                  callbackError: Boolean(error),
                  callbackErrorCode,
                  callbackDurationMs,
                  callbackAt,
                  callbackMonotonicAtMs,
                });
                item.rawCallbackSeen = true;
              } catch {
                /* Raw callback diagnostics cannot change callback behavior. */
              }
            };
            if (stopped || item.completed || !inFlight.includes(item)) {
              recordRawCallback(
                callbackMonotonicAtMs === null
                  ? null
                  : Math.max(0, callbackMonotonicAtMs - item.startedAt!),
              );
              return;
            }
            item.completed = true;
            const callbackDurationMs = duration(item.startedAt!);
            item.callbackDurationMs = callbackDurationMs;
            if (error) {
              recordRawCallback(callbackDurationMs);
              fail('write_callback_error', item, callbackDurationMs);
              return;
            }
            // A due timer may still be waiting for its event-loop turn. A late
            // success must not bypass the same accepted-item deadline.
            if (duration(item.acceptedAt) >= LIVE_TRANSLATE_SEND_WAIT_MS) {
              recordRawCallback(callbackDurationMs);
              fail('oldest_send_timeout', item, callbackDurationMs);
              return;
            }
            if (diagnostics) successfulCallbacksAwaitingPrefix += 1;
            recordRawCallback(callbackDurationMs);
            // Even a custom transport delivering callbacks out of order may
            // advance acknowledged progress only across a successful prefix.
            while (!stopped && inFlight[0]?.completed) {
              const written = inFlight.shift()!;
              if (diagnostics) successfulCallbacksAwaitingPrefix -= 1;
              pendingAudioBytes -= written.audioBytes;
              pendingWireBytes -= Buffer.byteLength(written.wire);
              writtenAudioBytes += written.audioBytes;
              contiguousWrittenSequence = written.sendSequence;
              observe(
                sample('send_written', written, {
                  callbackDurationMs: written.callbackDurationMs,
                }),
                written,
              );
              if (stopped) return;
              try {
                written.onWritten?.();
              } catch {
                fail(
                  'write_callback_error',
                  written,
                  written.callbackDurationMs,
                );
                return;
              }
            }
            pump();
          });
        } catch {
          if (!stopped && !item.completed) fail('write_throw', item);
        }
      }
    } finally {
      pumping = false;
    }
    arm();
  }
  return {
    enqueue(
      wire: string,
      eventType: LiveTranslateSendEventType,
      audioBytes: number,
      onWritten?: () => void,
    ): boolean {
      if (stopped) return false;
      sendSequence += 1;
      const item: SendItem = {
        wire,
        eventType,
        audioBytes,
        sendSequence,
        acceptedAt: monotonicNow(),
        completed: false,
        rawCallbackSeen: false,
        waitingObserved: false,
        onWritten,
      };
      if (options.socket.readyState !== 1) {
        fail('transport_not_open', item);
        return false;
      }
      const oldestItem = oldest();
      if (
        oldestItem &&
        duration(oldestItem.acceptedAt) >= LIVE_TRANSLATE_SEND_WAIT_MS
      ) {
        fail('oldest_send_timeout', oldestItem);
        return false;
      }
      if (
        !Number.isSafeInteger(audioBytes) ||
        audioBytes < 0 ||
        pendingAudioBytes + audioBytes > LIVE_TRANSLATE_PENDING_INPUT_BYTES ||
        pendingWireBytes + Buffer.byteLength(wire) >
          LIVE_TRANSLATE_TRANSPORT_BUFFER_BYTES
      ) {
        fail('pending_input_limit', item);
        return false;
      }
      queue.push(item);
      acceptedAudioBytes += audioBytes;
      pendingAudioBytes += audioBytes;
      pendingWireBytes += Buffer.byteLength(wire);
      observe(sample('send_accepted', item), item);
      pump();
      return !stopped;
    },
    abort() {
      if (stopped) return;
      const event = sample('send_cancelled', oldest());
      stopped = true;
      diagnose('send_cancelled', oldest());
      diagnostics?.dispose();
      clear();
      observe(event);
    },
    observeClose(code?: number) {
      if (closeObserved) return;
      closeObserved = true;
      observe(
        sample('transport_closed', oldest(), {
          ...(Number.isSafeInteger(code) && code! >= 1000 && code! <= 4999
            ? { closeCode: code }
            : {}),
        }),
        oldest(),
      );
      diagnostics?.dispose();
    },
    /** Read-only diagnostic accounting; never used for admission or cleanup decisions. */
    diagnosticSnapshot: () =>
      diagnostics
        ? { ...diagnostics.snapshot(), successfulCallbacksAwaitingPrefix }
        : undefined,
    /** End metadata collection without changing the writer's existing lifecycle. */
    finishDiagnostics() {
      try {
        diagnostics?.finish(
          diagnosticState('diagnostic_end', oldest()),
          'normal_end',
        );
      } catch {
        /* Diagnostics only. */
      } finally {
        diagnostics?.dispose();
      }
    },
    snapshot: () => ({
      stopped,
      acceptedAudioBytes,
      writtenAudioBytes,
      pendingAudioBytes,
      pendingWireBytes,
      queuedFrames: queue.length,
      inFlight: Boolean(inFlight.length),
      sendSequence,
    }),
  };
}
