/* eslint-disable no-await-in-loop -- One session per direction; paced files preserve input order. */
/* eslint-disable @typescript-eslint/no-loop-func -- Per-clip callbacks share the same fenced run; sessions are serial. */
import { performance } from 'node:perf_hooks';

import {
  createLiveTranslateClient,
  isLiveTranslateFailureCode,
} from './livetranslate-client';
import type {
  LiveTranslateAudioMetadata,
  LiveTranslateClient,
  LiveTranslateClientOptions,
  LiveTranslateSource,
  LiveTranslateTranslation,
  LiveTranslateUsage,
  LiveTranslateTiming,
} from './livetranslate-types';
import {
  LIVETRANSLATE_AUDITION_LIMITS,
  LIVETRANSLATE_AUDITION_MODEL,
  LIVETRANSLATE_AUDITION_VOICE,
  liveTranslateSpaceHost,
  type PreparedLiveTranslateAuditionInput,
} from './livetranslate-audition-input';

export type LiveTranslateAuditionResult = {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode?: string;
  closeCode?: number;
  startedAt: number;
  endedAt: number;
  configuration: {
    model: typeof LIVETRANSLATE_AUDITION_MODEL;
    voice: typeof LIVETRANSLATE_AUDITION_VOICE;
    spaceHost: string;
    inputSampleRate: 16000;
    outputSampleRate: 24000;
    automaticRetries: 0;
    automaticReconnects: 0;
    providerOutputTokenLimit: null;
    providerCancelSupported: false;
  };
  counters: {
    sessions: number;
    observedResponses: number;
    acceptedResponses: number;
    inputBytesSent: number;
    audioBytesReceived: number;
    audioBytesSaved: number;
  };
  sources: (LiveTranslateSource & { clipId: string; receivedAt: number })[];
  translations: (LiveTranslateTranslation & {
    clipId: string;
    receivedAt: number;
  })[];
  timing: (LiveTranslateTiming & { clipId: string })[];
  usage: (LiveTranslateUsage & { clipId: string })[];
  audio: {
    clipId: string;
    metadata: LiveTranslateAudioMetadata;
    pcm: Buffer;
    /** Earliest client receive timing, never FIFO delivery time; null without timing. */
    firstPcmAt: number | null;
    firstPcmBasis: 'client_receive_timing' | 'delivery_callback_only';
    collectedQueueAt: number;
    clientFifoWaitMs: number | null;
    responseDoneAt: number | null;
    annotatedSpeechEndToFirstPcmMs: number | null;
    actualPlaybackStartedAt: null;
    playbackQueueWaitMs: null;
    queueMeasurement: 'not_attached_to_playback';
  }[];
  clips: {
    id: string;
    sendStartedAt: number | null;
    finishRequestedAt: number | null;
    endedAt: number | null;
  }[];
};
export type LiveTranslateAuditionRunnerOptions = {
  input: PreparedLiveTranslateAuditionInput;
  apiKey: string;
  proxyUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  clientFactory?: (options: LiveTranslateClientOptions) => LiveTranslateClient;
};
const MAX_EVENTS = 4096;
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new Error('LIVETRANSLATE_AUDITION_CANCELLED'));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('LIVETRANSLATE_AUDITION_CANCELLED'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** No microphone, automatic playback, phone, separate ASR/MT/TTS, retries or reconnects. */
export async function runLiveTranslateAudition(
  options: LiveTranslateAuditionRunnerOptions,
): Promise<LiveTranslateAuditionResult> {
  const { input } = options;
  const timeoutMs =
    options.timeoutMs ?? LIVETRANSLATE_AUDITION_LIMITS.totalTimeoutMs;
  if (
    !input ||
    !Array.isArray(input.clips) ||
    input.clips.length !== 2 ||
    new Set(input.clips.map((clip) => clip.role)).size !== 2 ||
    !input.clips.every(
      (clip) =>
        ['local', 'remote'].includes(clip.role) &&
        Buffer.isBuffer(clip.pcm) &&
        clip.pcm.length >= 3200 &&
        clip.pcm.length % 2 === 0 &&
        clip.durationMs === clip.pcm.length / 32,
    ) ||
    input.clips.reduce((sum, clip) => sum + clip.pcm.length, 0) >
      LIVETRANSLATE_AUDITION_LIMITS.inputSeconds * 32000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > LIVETRANSLATE_AUDITION_LIMITS.totalTimeoutMs ||
    input.spaceHost !== liveTranslateSpaceHost(input.workspaceId)
  )
    throw new Error('LIVETRANSLATE_AUDITION_RUN_INPUT_INVALID');
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const controller = new AbortController();
  const result: LiveTranslateAuditionResult = {
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    configuration: {
      model: LIVETRANSLATE_AUDITION_MODEL,
      voice: LIVETRANSLATE_AUDITION_VOICE,
      spaceHost: input.spaceHost,
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      automaticRetries: 0,
      automaticReconnects: 0,
      providerOutputTokenLimit: null,
      providerCancelSupported: false,
    },
    counters: {
      sessions: 0,
      observedResponses: 0,
      acceptedResponses: 0,
      inputBytesSent: 0,
      audioBytesReceived: 0,
      audioBytesSaved: 0,
    },
    sources: [],
    translations: [],
    timing: [],
    usage: [],
    audio: [],
    clips: input.clips.map((clip) => ({
      id: clip.id,
      sendStartedAt: null,
      finishRequestedAt: null,
      endedAt: null,
    })),
  };
  const clients = new Set<LiveTranslateClient>();
  const responses = new Set<string>();
  const audioEvents = new Set<string>();
  let stopped = false;
  let eventCount = 0;
  let rejectStopped: (reason: Error) => void;
  const stoppedTask = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stoppedTask.catch(() => {});
  const stop = (code: string, cancelled = false) => {
    if (stopped) return;
    stopped = true;
    result.status = cancelled ? 'cancelled' : 'failed';
    result.errorCode = code;
    controller.abort();
    for (const client of clients) {
      try {
        client.abort();
      } catch {
        /* Independent close continues. */
      }
    }
    rejectStopped(new Error(code));
  };
  const abort = () => stop('LIVETRANSLATE_AUDITION_CANCELLED', true);
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => stop('LIVETRANSLATE_AUDITION_TIMEOUT'),
    timeoutMs,
  );
  const observed = () => {
    if (stopped) return false;
    if (now() - startedAt >= timeoutMs) {
      stop('LIVETRANSLATE_AUDITION_TIMEOUT');
      return false;
    }
    eventCount += 1;
    if (eventCount > MAX_EVENTS) {
      stop('LIVETRANSLATE_AUDITION_EVENT_LIMIT');
      return false;
    }
    return true;
  };
  const response = (clipId: string, id: string) => {
    if (!id || typeof id !== 'string' || id.length > 256) {
      stop('LIVETRANSLATE_AUDITION_RESPONSE_INVALID');
      return false;
    }
    const key = `${clipId}:${id}`;
    if (!responses.has(key)) {
      responses.add(key);
      result.counters.observedResponses = responses.size;
      if (responses.size > LIVETRANSLATE_AUDITION_LIMITS.acceptedResponses) {
        stop('LIVETRANSLATE_AUDITION_RESPONSE_OBSERVATION_LIMIT');
        return false;
      }
      result.counters.acceptedResponses = responses.size;
    }
    return !stopped;
  };
  const fenced = <T>(task: Promise<T>) => Promise.race([task, stoppedTask]);
  try {
    if (options.signal?.aborted) abort();
    for (const [index, clip] of input.clips.entries()) {
      if (stopped) break;
      const clipState = result.clips[index];
      let live = true;
      let observedSessionId: string | undefined;
      const accepts = (event: { role: string; sessionId: string }) => {
        if (
          event.role !== clip.role ||
          typeof event.sessionId !== 'string' ||
          !event.sessionId
        )
          return false;
        observedSessionId ??= event.sessionId;
        return observedSessionId === event.sessionId;
      };
      const active = () => live && observed();
      const client = (options.clientFactory ?? createLiveTranslateClient)({
        enabled: true,
        role: clip.role,
        workspaceId: input.workspaceId,
        apiKey: options.apiKey,
        proxyUrl: options.proxyUrl,
        now,
        timeoutMs: Math.min(timeoutMs, 15000),
        onSource: (event) => {
          if (!active()) return;
          if (!accepts(event) || event.text.length > 8192) {
            stop('LIVETRANSLATE_AUDITION_EVENT_INVALID');
            return;
          }
          result.sources.push({ ...event, clipId: clip.id, receivedAt: now() });
        },
        onTranslation: (event) => {
          if (!active() || !response(clip.id, event.responseId)) return;
          if (!accepts(event) || event.text.length > 8192) {
            stop('LIVETRANSLATE_AUDITION_EVENT_INVALID');
            return;
          }
          result.translations.push({
            ...event,
            clipId: clip.id,
            receivedAt: now(),
          });
        },
        onAssociation: (event) => {
          if (!active() || !accepts(event)) return;
          for (const audio of result.audio)
            if (
              audio.clipId === clip.id &&
              audio.metadata.translationId === event.translationId
            )
              audio.metadata = {
                ...audio.metadata,
                sourceId: event.sourceId,
                pairing: 'explicit',
              };
        },
        onTiming: (event) => {
          if (!active()) return;
          if (!accepts(event)) {
            stop('LIVETRANSLATE_AUDITION_EVENT_INVALID');
            return;
          }
          if (event.responseId && !response(clip.id, event.responseId)) return;
          result.timing.push({ ...event, clipId: clip.id });
          if (event.stage === 'response_completed')
            for (const audio of result.audio)
              if (
                audio.clipId === clip.id &&
                audio.metadata.responseId === event.responseId
              )
                audio.responseDoneAt =
                  audio.responseDoneAt === null
                    ? event.at
                    : Math.min(audio.responseDoneAt, event.at);
          if (
            event.stage === 'audio_first_sample' &&
            Number.isFinite(event.at) &&
            event.at >= 0
          )
            for (const audio of result.audio)
              if (
                audio.clipId === clip.id &&
                audio.metadata.responseId === event.responseId &&
                audio.metadata.translationId === event.translationId &&
                (audio.firstPcmAt === null || event.at < audio.firstPcmAt)
              ) {
                audio.firstPcmAt = event.at;
                audio.firstPcmBasis = 'client_receive_timing';
                audio.clientFifoWaitMs = audio.collectedQueueAt - event.at;
                audio.annotatedSpeechEndToFirstPcmMs =
                  clip.speechEndMs === undefined ||
                  clipState.sendStartedAt === null
                    ? null
                    : event.at - clipState.sendStartedAt - clip.speechEndMs;
              }
        },
        onUsage: (event) => {
          if (!active() || !response(clip.id, event.responseId)) return;
          if (!accepts(event)) {
            stop('LIVETRANSLATE_AUDITION_EVENT_INVALID');
            return;
          }
          result.usage.push({ ...event, clipId: clip.id });
        },
        onAudio: (pcm, metadata) => {
          if (!active()) return;
          if (Buffer.isBuffer(pcm))
            result.counters.audioBytesReceived += pcm.length;
          if (!response(clip.id, metadata.responseId)) return;
          if (
            clip.role !== 'local' ||
            !accepts(metadata) ||
            !Buffer.isBuffer(pcm) ||
            !pcm.length ||
            pcm.length % 2
          ) {
            stop('LIVETRANSLATE_AUDITION_AUDIO_INVALID');
            return;
          }
          const key = `${clip.id}:${metadata.eventId}`;
          if (audioEvents.has(key)) return;
          audioEvents.add(key);
          const available =
            LIVETRANSLATE_AUDITION_LIMITS.savedOutputSeconds * 48000 -
            result.counters.audioBytesSaved;
          const save = pcm.subarray(0, Math.min(available, pcm.length));
          let record = result.audio.find(
            (item) =>
              item.clipId === clip.id &&
              item.metadata.responseId === metadata.responseId &&
              item.metadata.translationId === metadata.translationId,
          );
          if (!record) {
            const first = result.timing
              .filter(
                (event) =>
                  event.clipId === clip.id &&
                  event.responseId === metadata.responseId &&
                  event.translationId === metadata.translationId &&
                  event.stage === 'audio_first_sample' &&
                  Number.isFinite(event.at) &&
                  event.at >= 0,
              )
              .sort((a, b) => a.at - b.at)[0];
            const completed = result.timing
              .filter(
                (event) =>
                  event.clipId === clip.id &&
                  event.responseId === metadata.responseId &&
                  event.stage === 'response_completed',
              )
              .sort((a, b) => a.at - b.at)[0];
            const collectedQueueAt = now();
            record = {
              clipId: clip.id,
              metadata: { ...metadata },
              pcm: Buffer.alloc(0),
              firstPcmAt: first?.at ?? null,
              firstPcmBasis: first
                ? 'client_receive_timing'
                : 'delivery_callback_only',
              collectedQueueAt,
              clientFifoWaitMs: first ? collectedQueueAt - first.at : null,
              responseDoneAt: completed?.at ?? null,
              annotatedSpeechEndToFirstPcmMs:
                !first ||
                clip.speechEndMs === undefined ||
                clipState.sendStartedAt === null
                  ? null
                  : first.at - clipState.sendStartedAt - clip.speechEndMs,
              actualPlaybackStartedAt: null,
              playbackQueueWaitMs: null,
              queueMeasurement: 'not_attached_to_playback',
            };
            result.audio.push(record);
          }
          record.pcm = Buffer.concat([record.pcm, save]);
          result.counters.audioBytesSaved += save.length;
          if (pcm.length >= available)
            stop('LIVETRANSLATE_AUDITION_OUTPUT_OBSERVATION_LIMIT');
        },
        onError: (code, diagnostic) => {
          if (stopped || !live) return;
          const closeCode = diagnostic?.closeCode;
          if (
            Number.isInteger(closeCode) &&
            closeCode >= 1000 &&
            closeCode <= 4999
          )
            result.closeCode = closeCode;
          stop(
            isLiveTranslateFailureCode(code)
              ? code
              : 'LIVETRANSLATE_AUDITION_SUPPLIER_FAILED',
          );
        },
      });
      clients.add(client);
      result.counters.sessions += 1;
      if (stopped) {
        client.abort();
        break;
      }
      const session = await fenced(client.ready);
      if (
        (observedSessionId !== undefined &&
          observedSessionId !== session.sessionId) ||
        session.model !== LIVETRANSLATE_AUDITION_MODEL ||
        session.voice !== 'Tina' ||
        session.role !== clip.role ||
        session.inputSampleRate !== 16000 ||
        session.outputSampleRate !== 24000 ||
        [...session.outputModalities].sort().join(',') !==
          (clip.role === 'local' ? 'audio,text' : 'text')
      ) {
        stop('LIVETRANSLATE_AUDITION_SESSION_CONFIG_REJECTED');
        break;
      }
      clipState.sendStartedAt = now();
      for (
        let offset = 0;
        offset < clip.pcm.length && !stopped;
        offset += 640
      ) {
        const frame = clip.pcm.subarray(offset, offset + 640);
        client.append(frame);
        result.counters.inputBytesSent += frame.length;
        await fenced(
          (options.delay ?? wait)(frame.length / 32, controller.signal),
        );
      }
      if (stopped) break;
      clipState.finishRequestedAt = now();
      await fenced(client.finish());
      clipState.endedAt = now();
      const sourceComplete = result.sources.some(
        (event) =>
          event.clipId === clip.id && event.final && !!event.text.trim(),
      );
      const translationComplete = result.translations.some(
        (event) =>
          event.clipId === clip.id && event.final && !!event.text.trim(),
      );
      const localAudioComplete =
        clip.role !== 'local' ||
        result.audio.some(
          (audio) =>
            audio.clipId === clip.id &&
            audio.pcm.length > 0 &&
            audio.responseDoneAt !== null,
        );
      if (!sourceComplete || !translationComplete || !localAudioComplete) {
        stop('LIVETRANSLATE_AUDITION_INCOMPLETE_OUTPUT');
        break;
      }
      live = false;
      client.abort();
      clients.delete(client);
    }
  } catch (error) {
    if (!stopped)
      stop(
        error instanceof Error && isLiveTranslateFailureCode(error.message)
          ? error.message
          : 'LIVETRANSLATE_AUDITION_SUPPLIER_FAILED',
      );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    for (const client of clients) {
      try {
        client.abort();
      } catch {
        /* Local fence is already active. */
      }
    }
    stopped = true;
    result.endedAt = now();
  }
  return result;
}
