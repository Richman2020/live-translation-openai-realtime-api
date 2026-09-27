import WebSocket from 'ws';

import { createOpenAIWebSocket } from './openai-websocket';

export type ContinuousTranslationOptions = {
  apiKey: string;
  targetLanguage: 'en' | 'zh';
  noiseReduction?: 'near_field' | 'far_field' | null;
  proxyUrl?: string;
  onAudio: (pcm: Buffer) => void;
  onTranscript?: (delta: string) => void;
  onError?: (code: string) => void;
  createWebSocket?: (
    url: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket;
  timeoutMs?: number;
};

export type ContinuousTranslationClient = {
  ready: Promise<void>;
  append(pcm: Buffer): void;
  finish(): Promise<void>;
  abort(): void;
};

const MODEL = 'gpt-realtime-translate';
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 48000; // One second of mono PCM16 at 24 kHz.
const MAX_BUFFERED_BYTES = 256 * 1024;
const ignoreSocketError = () => {};

function deferred() {
  let resolve: () => void;
  let reject: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Callers can abort before awaiting either lifecycle operation. Keep the
  // original promise rejectable without creating an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function parseEvent(raw: unknown): Record<string, any> {
  let buffer: Buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (typeof raw === 'string') buffer = Buffer.from(raw);
  else if (raw instanceof ArrayBuffer) buffer = Buffer.from(raw);
  else if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    if (raw.reduce((sum, part) => sum + part.length, 0) > MAX_EVENT_BYTES)
      throw new Error('INVALID_PROVIDER_EVENT');
    buffer = Buffer.concat(raw);
  } else throw new Error('INVALID_PROVIDER_EVENT');
  if (buffer.length > MAX_EVENT_BYTES)
    throw new Error('INVALID_PROVIDER_EVENT');
  const event = JSON.parse(buffer.toString('utf8'));
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('INVALID_PROVIDER_EVENT');
  return event;
}

function decodePcm(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > MAX_EVENT_BYTES ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('INVALID_PROVIDER_AUDIO');
  const pcm = Buffer.from(value, 'base64');
  if (!pcm.length || pcm.length % 2 || pcm.toString('base64') !== value)
    throw new Error('INVALID_PROVIDER_AUDIO');
  return pcm;
}

/**
 * Dedicated continuous translation client shared by the phone adapter and
 * isolated benchmarks. No ASR or transcript gates its audio output.
 * Input and output are headerless, mono little-endian PCM16 at 24 kHz.
 */
export function createContinuousTranslationClient(
  options: ContinuousTranslationOptions,
): ContinuousTranslationClient {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (
    !['en', 'zh'].includes(options.targetLanguage) ||
    (options.noiseReduction !== undefined &&
      options.noiseReduction !== null &&
      !['near_field', 'far_field'].includes(options.noiseReduction)) ||
    typeof options.apiKey !== 'string' ||
    !options.apiKey.trim() ||
    typeof options.onAudio !== 'function' ||
    (options.onTranscript !== undefined &&
      typeof options.onTranscript !== 'function') ||
    (options.onError !== undefined && typeof options.onError !== 'function') ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw new Error('INVALID_CONTINUOUS_TRANSLATION_OPTIONS');

  const ready = deferred();
  const finished = deferred();
  let state: 'connecting' | 'ready' | 'draining' | 'closed' = 'connecting';
  let configured = false;
  let socket: WebSocket;
  let timer: ReturnType<typeof setTimeout>;
  const listeners: [string, (...args: any[]) => void][] = [];

  const cleanup = () => {
    clearTimeout(timer);
    if (!socket) return;
    for (const [name, listener] of listeners) socket.off(name, listener);
    listeners.length = 0;
    // ws can emit a final transport error while a socket is closing.
    socket.on('error', ignoreSocketError);
    try {
      // On success the application-level session.closed already confirms the
      // drain. On abort/error no further output is wanted. In both cases release
      // TCP immediately instead of retaining ws's 30-second close timer.
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    } catch {
      // Cleanup must not expose transport errors or replace the primary code.
    }
  };

  const fail = (code: string, notify = true) => {
    if (state === 'closed') return;
    state = 'closed';
    cleanup();
    const error = new Error(code);
    ready.reject(error);
    finished.reject(error);
    if (notify) {
      try {
        options.onError?.(code);
      } catch {
        // A diagnostic subscriber cannot prevent deterministic cleanup.
      }
    }
  };

  const send = (event: object): boolean => {
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      fail('PROVIDER_SEND_UNAVAILABLE');
      return false;
    }
    try {
      socket.send(JSON.stringify(event), (error?: Error) => {
        if (error) fail('PROVIDER_SEND_FAILED');
      });
      return state !== 'closed';
    } catch {
      fail('PROVIDER_SEND_FAILED');
      return false;
    }
  };

  const configure = () => {
    if (state !== 'connecting' || configured) return;
    configured = true;
    send({
      type: 'session.update',
      session: {
        audio: {
          ...(options.noiseReduction === undefined
            ? {}
            : {
                input: {
                  noise_reduction:
                    options.noiseReduction === null
                      ? null
                      : { type: options.noiseReduction },
                },
              }),
          output: { language: options.targetLanguage },
        },
      },
    });
  };

  const receive = (raw: unknown) => {
    if (state === 'closed') return;
    let event: Record<string, any>;
    try {
      event = parseEvent(raw);
    } catch {
      fail('INVALID_PROVIDER_EVENT');
      return;
    }
    if (event.type === 'error') {
      fail('PROVIDER_SESSION_REJECTED');
      return;
    }
    if (event.type === 'session.updated') {
      if (
        !configured ||
        event.session?.model !== MODEL ||
        event.session?.audio?.output?.language !== options.targetLanguage ||
        (options.noiseReduction !== undefined &&
          (options.noiseReduction === null
            ? event.session?.audio?.input?.noise_reduction !== null
            : event.session?.audio?.input?.noise_reduction?.type !==
              options.noiseReduction))
      ) {
        fail('PROVIDER_SESSION_MISMATCH');
        return;
      }
      if (state === 'connecting') {
        clearTimeout(timer);
        state = 'ready';
        ready.resolve();
      }
      return;
    }
    if (event.type === 'session.closed') {
      if (state !== 'draining') {
        fail('PROVIDER_CLOSED_UNEXPECTEDLY');
        return;
      }
      state = 'closed';
      cleanup();
      finished.resolve();
      return;
    }
    if (
      event.type !== 'session.output_audio.delta' &&
      event.type !== 'session.output_transcript.delta'
    )
      return;
    if (state === 'connecting') {
      fail('PROVIDER_OUTPUT_BEFORE_READY');
      return;
    }
    if (event.type === 'session.output_audio.delta') {
      // The translation protocol uses mono PCM16 at 24 kHz when these optional
      // fields are omitted. Reject any explicit conflicting declaration rather
      // than replaying it with the wrong duration, pitch or channel layout.
      // https://developers.openai.com/api/reference/resources/realtime/translation-server-events
      if (
        (event.sample_rate !== undefined && event.sample_rate !== 24000) ||
        (event.channels !== undefined && event.channels !== 1) ||
        (event.format !== undefined && event.format !== 'pcm16')
      ) {
        fail('PROVIDER_AUDIO_FORMAT_MISMATCH');
        return;
      }
      let pcm: Buffer;
      try {
        pcm = decodePcm(event.delta);
      } catch {
        fail('INVALID_PROVIDER_AUDIO');
        return;
      }
      try {
        options.onAudio(pcm);
      } catch {
        fail('AUDIO_CALLBACK_FAILED');
      }
    } else if (typeof event.delta !== 'string') {
      fail('INVALID_PROVIDER_TRANSCRIPT');
    } else {
      try {
        options.onTranscript?.(event.delta);
      } catch {
        // Captions are optional diagnostics and cannot interrupt spoken output.
      }
    }
  };

  const listen = (name: string, listener: (...args: any[]) => void) => {
    socket.on(name, listener);
    listeners.push([name, listener]);
  };

  try {
    socket = createOpenAIWebSocket(
      `wss://api.openai.com/v1/realtime/translations?model=${MODEL}`,
      {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        handshakeTimeout: timeoutMs,
        maxPayload: MAX_EVENT_BYTES,
      },
      options.proxyUrl,
      options.createWebSocket,
    );
    timer = setTimeout(() => fail('PROVIDER_READY_TIMEOUT'), timeoutMs);
    listen('open', configure);
    listen('message', receive);
    listen('error', () => fail('PROVIDER_CONNECTION_FAILED'));
    listen('close', () => fail('PROVIDER_CLOSED_UNEXPECTEDLY'));
    listen('unexpected-response', (_request, response) => {
      response.resume();
      fail('PROVIDER_HANDSHAKE_REJECTED');
    });
    if (socket.readyState === WebSocket.OPEN) configure();
  } catch {
    fail('PROVIDER_CONNECTION_FAILED');
  }

  return {
    ready: ready.promise,
    append(pcm) {
      if (state !== 'ready')
        throw new Error(
          state === 'connecting'
            ? 'CLIENT_NOT_READY'
            : 'CLIENT_NOT_ACCEPTING_AUDIO',
        );
      if (
        !Buffer.isBuffer(pcm) ||
        !pcm.length ||
        pcm.length % 2 !== 0 ||
        pcm.length > MAX_INPUT_BYTES
      )
        throw new Error('INVALID_PCM_INPUT');
      if (
        !send({
          type: 'session.input_audio_buffer.append',
          audio: pcm.toString('base64'),
        })
      )
        throw new Error('PROVIDER_SEND_FAILED');
    },
    finish() {
      if (state === 'connecting') fail('CLIENT_NOT_READY');
      if (state === 'ready') {
        state = 'draining';
        timer = setTimeout(() => fail('PROVIDER_FINISH_TIMEOUT'), timeoutMs);
        send({ type: 'session.close' });
      }
      return finished.promise;
    },
    abort() {
      fail('CLIENT_ABORTED', false);
    },
  };
}
