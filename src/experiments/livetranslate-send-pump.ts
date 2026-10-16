import { performance } from 'node:perf_hooks';

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
  let inFlight: SendItem | undefined;
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
  const duration = (started: number) => Math.max(0, monotonicNow() - started);
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
  const observe = (event: SendObservation) => {
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
    inFlight = undefined;
    pendingAudioBytes = 0;
    pendingWireBytes = 0;
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
    clear();
    observe(event);
    try {
      options.onFailure(event);
    } catch {
      // The local stopped fence is authoritative even if cleanup throws.
    }
  };
  const oldest = () => inFlight ?? queue[0];
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
      while (!stopped && !inFlight && queue.length) {
        const item = queue[0];
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
            );
          }
          arm(true);
          return;
        }
        queue.shift();
        inFlight = item;
        item.startedAt = monotonicNow();
        observe(sample('send_started', item));
        if (stopped || inFlight !== item) break;
        try {
          // eslint-disable-next-line @typescript-eslint/no-loop-func -- Each closure owns its const item; stopped/inFlight fences reject late callbacks before mutating shared progress.
          options.socket.send(item.wire, (error) => {
            if (stopped || item.completed || inFlight !== item) return;
            item.completed = true;
            const callbackDurationMs = duration(item.startedAt!);
            if (error) {
              fail('write_callback_error', item, callbackDurationMs);
              return;
            }
            // A due timer may still be waiting for its event-loop turn. A late
            // success must not bypass the same accepted-item deadline.
            if (duration(item.acceptedAt) >= LIVE_TRANSLATE_SEND_WAIT_MS) {
              fail('oldest_send_timeout', item, callbackDurationMs);
              return;
            }
            inFlight = undefined;
            pendingAudioBytes -= item.audioBytes;
            pendingWireBytes -= Buffer.byteLength(item.wire);
            writtenAudioBytes += item.audioBytes;
            observe(sample('send_written', item, { callbackDurationMs }));
            if (stopped) return;
            try {
              item.onWritten?.();
            } catch {
              fail('write_callback_error', item, callbackDurationMs);
              return;
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
      observe(sample('send_accepted', item));
      pump();
      return !stopped;
    },
    abort() {
      if (stopped) return;
      const event = sample('send_cancelled', oldest());
      stopped = true;
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
      );
    },
    snapshot: () => ({
      stopped,
      acceptedAudioBytes,
      writtenAudioBytes,
      pendingAudioBytes,
      pendingWireBytes,
      queuedFrames: queue.length,
      inFlight: Boolean(inFlight),
      sendSequence,
    }),
  };
}
