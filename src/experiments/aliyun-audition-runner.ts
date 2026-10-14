/* eslint-disable no-await-in-loop -- Single audition preserves wire and speech order. */
/* eslint-disable @typescript-eslint/no-loop-func -- Per-clip closures intentionally share one fenced run state; clips are processed serially. */
import { performance } from 'node:perf_hooks';

import { createAliyunPlanBAsrClient } from '../solo/aliyun-planb-asr';
import { assertAliyunPlanBConfig } from '../solo/aliyun-planb-config';
import { translateAliyunPlanB } from '../solo/aliyun-planb-translation';
import { createAliyunPlanBTts } from '../solo/aliyun-planb-tts';
import type {
  AliyunPlanBConfig,
  PlanBAsrOptions,
  PlanBAsrSource,
  PlanBAsrClient,
  PlanBTtsClient,
  PlanBTtsOptions,
  PlanBTranslationOptions,
  PlanBTranslationResult,
  PlanBUsage,
  PlanBEvidence,
} from '../solo/aliyun-planb-types';
import {
  recentWholeContext,
  type CallContextEntry,
  type CallContextSnapshot,
} from '../solo/call-context';
import {
  ALIYUN_AUDITION_LIMITS,
  type AliyunAuditionClip,
} from './aliyun-audition-input';

const BYTES_PER_SECOND = 24000 * 2;
const FRAME_BYTES = BYTES_PER_SECOND / 50;
const MAX_SOURCE_EVENTS = 128;

export type AliyunAuditionLatency = {
  /** Provider stream timestamps are estimates, not an acoustic endpoint detector. */
  sourceEndBasis: 'provider_stream_estimate' | 'unknown';
  sourceEndAt: number | null;
  asrFinalReceivedAt: number;
  sourceEndToFinalMs: number | null;
  queueMs: number;
  translationStartedAt: number | null;
  translationCompletedAt: number | null;
  translationMs: number | null;
  ttsRequestedAt: number | null;
  translationEndToTtsMs: number | null;
  ttsFirstPcmMs: number | null;
  sourceEndToFirstPcmMs: number | null;
  /** User-marked last spoken sample of this file; independent of ASR end_time. */
  annotatedClipSpeechEndToFirstPcmMs: number | null;
  firstPcmAt: number | null;
};
export type AliyunAuditionSegment = {
  clipId: string;
  role: 'local' | 'remote';
  sourceSequence: number;
  sourceRevision: number;
  raw: string;
  translation: string;
  contextSourceIds: string[];
  pcm: Buffer;
  latency: AliyunAuditionLatency;
};
export type AliyunAuditionResult = {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode?: string;
  startedAt: number;
  endedAt: number;
  configuration: {
    region: AliyunPlanBConfig['region'];
    asrModel: AliyunPlanBConfig['asrModel'];
    textModel: AliyunPlanBConfig['textModel'];
    ttsModel: AliyunPlanBConfig['ttsModel'];
    voice: AliyunPlanBConfig['voice'];
    sampleRate: 24000;
    translationMaxTokens: 2048;
    automaticRetries: 0;
    automaticReconnects: 0;
  };
  counters: {
    asrTasks: number;
    translationRequests: number;
    ttsTasks: number;
    ttsCharacters: number;
    inputBytesSent: number;
    outputBytesReceived: number;
    duplicateFinalsIgnored: number;
    lateRevisionsIgnored: number;
  };
  segments: AliyunAuditionSegment[];
  usage: (PlanBUsage & { clipId: string })[];
  evidence: (PlanBEvidence & { clipId: string; at: number })[];
  clips: {
    id: string;
    role: 'local' | 'remote';
    audioSendStartedAt: number | null;
    finishRequestedAt: number | null;
    maxPartialWaitMs: number;
    finalsBeforeFinish: number;
    finalsAfterFinish: number;
    /** Arrival after finish is correlation; it does not establish causation. */
    finalizationAfterFinishObserved: boolean;
    observations: (PlanBAsrSource & { receivedAt: number })[];
  }[];
};
export type AliyunAuditionRunnerOptions = {
  config: AliyunPlanBConfig;
  clips: AliyunAuditionClip[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Monotonic non-negative milliseconds; production uses performance.now(). */
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  deps?: {
    createAsr?: (options: PlanBAsrOptions) => PlanBAsrClient;
    translate?: (
      options: PlanBTranslationOptions,
    ) => Promise<PlanBTranslationResult>;
    createTts?: (options: PlanBTtsOptions) => PlanBTtsClient;
  };
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new Error('ALIYUN_AUDITION_CANCELLED'));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('ALIYUN_AUDITION_CANCELLED'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** No microphone, playback, Twilio, retries or production provider selection. */
export async function runAliyunAudition(
  options: AliyunAuditionRunnerOptions,
): Promise<AliyunAuditionResult> {
  const config = Object.freeze({ ...options.config });
  assertAliyunPlanBConfig(config);
  const timeoutMs = options.timeoutMs ?? ALIYUN_AUDITION_LIMITS.totalTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > ALIYUN_AUDITION_LIMITS.totalTimeoutMs ||
    !Array.isArray(options.clips) ||
    !options.clips.length ||
    options.clips.length > ALIYUN_AUDITION_LIMITS.clips
  )
    throw new Error('ALIYUN_AUDITION_INPUT_INVALID');
  let totalBytes = 0;
  const ids = new Set<string>();
  for (const clip of options.clips) {
    if (
      !clip ||
      typeof clip.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,60}$/.test(clip.id) ||
      ids.has(clip.id) ||
      !['local', 'remote'].includes(clip.role) ||
      !Buffer.isBuffer(clip.pcm) ||
      !clip.pcm.length ||
      clip.pcm.length % 2 ||
      !Number.isFinite(clip.durationMs) ||
      Math.abs(clip.durationMs - (clip.pcm.length * 1000) / BYTES_PER_SECOND) >
        0.001 ||
      (clip.speechEndMs !== undefined &&
        (!Number.isFinite(clip.speechEndMs) ||
          clip.speechEndMs < 0 ||
          clip.speechEndMs > clip.durationMs))
    )
      throw new Error('ALIYUN_AUDITION_INPUT_INVALID');
    ids.add(clip.id);
    totalBytes += clip.pcm.length;
  }
  if (totalBytes > ALIYUN_AUDITION_LIMITS.inputSeconds * BYTES_PER_SECOND)
    throw new Error('ALIYUN_AUDITION_INPUT_LIMIT');
  const clock = options.now ?? (() => Math.floor(performance.now()));
  let lastNow = -1;
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastNow)
      throw new Error('ALIYUN_AUDITION_CLOCK_INVALID');
    lastNow = value;
    return value;
  };
  const startedAt = now();
  const result: AliyunAuditionResult = {
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    configuration: {
      region: config.region,
      asrModel: config.asrModel,
      textModel: config.textModel,
      ttsModel: config.ttsModel,
      voice: config.voice,
      sampleRate: 24000,
      translationMaxTokens: 2048,
      automaticRetries: 0,
      automaticReconnects: 0,
    },
    counters: {
      asrTasks: 0,
      translationRequests: 0,
      ttsTasks: 0,
      ttsCharacters: 0,
      inputBytesSent: 0,
      outputBytesReceived: 0,
      duplicateFinalsIgnored: 0,
      lateRevisionsIgnored: 0,
    },
    segments: [],
    usage: [],
    evidence: [],
    clips: [],
  };
  const controller = new AbortController();
  const asrClients = new Set<PlanBAsrClient>();
  let tts: PlanBTtsClient | undefined;
  let collectUsage = true;
  let stoppedCode = '';
  const stop = (code: string) => {
    if (stoppedCode) return;
    stoppedCode = /^(?:PLAN_B_|PLANB_|ALIYUN_AUDITION_)[A-Z_]{1,80}$/.test(code)
      ? code
      : 'ALIYUN_AUDITION_PROVIDER_FAILED';
    controller.abort();
    for (const asr of asrClients) {
      try {
        asr.abort();
      } catch {
        /* A failed teardown never retries. */
      }
    }
    asrClients.clear();
    try {
      tts?.abort();
    } catch {
      /* Locally fenced; supplier already generated audio may remain billable. */
    }
    tts = undefined;
  };
  const assertLive = () => {
    if (stoppedCode) throw new Error(stoppedCode);
    if (now() - startedAt >= timeoutMs) {
      stop('ALIYUN_AUDITION_TIMEOUT');
      throw new Error(stoppedCode);
    }
  };
  const codeFor = (error: unknown) =>
    error instanceof Error &&
    /^(?:PLAN_B_|PLANB_|ALIYUN_AUDITION_)[A-Z_]{1,80}$/.test(error.message)
      ? error.message
      : 'ALIYUN_AUDITION_PROVIDER_FAILED';
  const externalAbort = () => stop('ALIYUN_AUDITION_CANCELLED');
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const timer = setTimeout(() => stop('ALIYUN_AUDITION_TIMEOUT'), timeoutMs);
  const abortRace = async <T>(operation: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new Error(stoppedCode);
    let handler: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          handler = () => reject(new Error(stoppedCode));
          controller.signal.addEventListener('abort', handler, { once: true });
        }),
      ]);
    } finally {
      if (handler) controller.signal.removeEventListener('abort', handler);
    }
  };
  const context: CallContextEntry[] = [];
  let contextVersion = 0;
  const snapshot = (): CallContextSnapshot => ({
    version: contextVersion,
    entries: context.map((entry) => ({ ...entry })),
  });
  const remember = (
    clip: AliyunAuditionClip,
    source: PlanBAsrSource,
    at: number,
  ) => {
    const excerpt = recentWholeContext(source.text);
    if (!excerpt) return;
    contextVersion += 1;
    context.push({
      ...excerpt,
      role: clip.role,
      sourceId: `${clip.id}:${source.sequence}`,
      sourceKind: 'asr',
      at,
      observedAt: at,
      order: contextVersion,
      revision: source.revision,
      provisional: false,
      generated: false,
    });
    while (
      context.length > 6 ||
      context.reduce((sum, entry) => sum + entry.text.length, 0) > 1600 ||
      (context[0] && at - context[0].at > 120000)
    )
      context.shift();
  };
  try {
    for (const clip of options.clips) {
      assertLive();
      const clipResult: AliyunAuditionResult['clips'][number] = {
        id: clip.id,
        role: clip.role,
        audioSendStartedAt: null,
        finishRequestedAt: null,
        maxPartialWaitMs: 0,
        finalsBeforeFinish: 0,
        finalsAfterFinish: 0,
        finalizationAfterFinishObserved: false,
        observations: [],
      };
      result.clips.push(clipResult);
      type SourceState = {
        source: PlanBAsrSource;
        receivedAt: number;
        partialStartedAt?: number;
      };
      const sources = new Map<number, SourceState>();
      const consumed = new Map<number, PlanBAsrSource>();
      let retiredThrough = -1;
      let worker: Promise<void> | undefined;
      const usage = (value: PlanBUsage) => {
        // Cancellation fences requests, not billable provider counters emitted
        // during teardown. Freeze collection only immediately before returning.
        if (!collectUsage) return;
        const prior = result.usage.findIndex(
          (entry) =>
            entry.clipId === clip.id &&
            entry.layer === value.layer &&
            entry.taskSequence === value.taskSequence,
        );
        const previous = prior < 0 ? undefined : result.usage[prior];
        const item: PlanBUsage & { clipId: string } = {
          layer: value.layer,
          role: value.role,
          taskSequence: value.taskSequence,
          region: config.region,
          basis:
            previous?.basis === 'provider_reported' ||
            value.basis === 'provider_reported'
              ? 'provider_reported'
              : 'unknown',
          clipId: clip.id,
        };
        for (const field of [
          'durationSeconds',
          'inputTokens',
          'outputTokens',
          'characters',
        ] as const) {
          const oldValue = previous?.[field];
          const newValue = value[field];
          const accepted =
            value.basis === 'provider_reported' &&
            typeof newValue === 'number' &&
            Number.isFinite(newValue) &&
            newValue >= 0
              ? newValue
              : undefined;
          if (oldValue !== undefined || accepted !== undefined)
            item[field] = Math.max(oldValue ?? 0, accepted ?? 0);
        }
        if (prior < 0) result.usage.push(item);
        else result.usage[prior] = item;
      };
      const evidence = (value: PlanBEvidence) => {
        if (!stoppedCode && result.evidence.length < 256)
          result.evidence.push({ ...value, clipId: clip.id, at: now() });
      };
      const process = async (item: SourceState) => {
        assertLive();
        const { source, receivedAt } = item;
        const sourceEnd =
          Number.isSafeInteger(source.endAt) &&
          source.endAt! >= source.at &&
          source.endAt! <= receivedAt
            ? source.endAt!
            : null;
        const requestAt = now();
        const contextSnapshot = snapshot();
        const segment: AliyunAuditionSegment = {
          clipId: clip.id,
          role: clip.role,
          sourceSequence: source.sequence,
          sourceRevision: source.revision,
          raw: source.text,
          translation: '',
          contextSourceIds: contextSnapshot.entries.map(
            (entry) => entry.sourceId,
          ),
          pcm: Buffer.alloc(0),
          latency: {
            sourceEndBasis:
              sourceEnd === null ? 'unknown' : 'provider_stream_estimate',
            sourceEndAt: sourceEnd,
            asrFinalReceivedAt: receivedAt,
            sourceEndToFinalMs:
              sourceEnd === null ? null : receivedAt - sourceEnd,
            queueMs: requestAt - receivedAt,
            translationStartedAt: null,
            translationCompletedAt: null,
            translationMs: null,
            ttsRequestedAt: null,
            translationEndToTtsMs: null,
            ttsFirstPcmMs: null,
            sourceEndToFirstPcmMs: null,
            annotatedClipSpeechEndToFirstPcmMs: null,
            firstPcmAt: null,
          },
        };
        result.segments.push(segment);
        if (
          result.counters.translationRequests >=
          ALIYUN_AUDITION_LIMITS.translationRequests
        )
          throw new Error('ALIYUN_AUDITION_TRANSLATION_LIMIT');
        result.counters.translationRequests += 1;
        remember(clip, source, receivedAt);
        segment.latency.translationStartedAt = now();
        segment.latency.queueMs =
          segment.latency.translationStartedAt - receivedAt;
        const translated = await abortRace(
          (options.deps?.translate ?? translateAliyunPlanB)({
            config,
            role: clip.role,
            text: source.text,
            sequence: result.counters.translationRequests,
            context: contextSnapshot,
            signal: controller.signal,
            onUsage: usage,
            onEvidence: evidence,
          }),
        );
        assertLive();
        segment.latency.translationCompletedAt = now();
        segment.latency.translationMs =
          segment.latency.translationCompletedAt -
          segment.latency.translationStartedAt;
        if (typeof translated.text !== 'string' || !translated.text.trim())
          throw new Error('ALIYUN_AUDITION_TRANSLATION_EMPTY');
        segment.translation = translated.text;
        if (clip.role === 'remote') return;
        if (result.counters.ttsTasks >= ALIYUN_AUDITION_LIMITS.ttsTasks)
          throw new Error('ALIYUN_AUDITION_TTS_LIMIT');
        const characters = Array.from(translated.text).length;
        if (
          result.counters.ttsCharacters + characters >
          ALIYUN_AUDITION_LIMITS.ttsCharacters
        )
          throw new Error('ALIYUN_AUDITION_TTS_CHARACTER_LIMIT');
        result.counters.ttsCharacters += characters;
        result.counters.ttsTasks += 1;
        tts?.abort();
        tts = (options.deps?.createTts ?? createAliyunPlanBTts)({
          config,
          onUsage: usage,
          onEvidence: evidence,
        });
        const ttsAt = now();
        segment.latency.ttsRequestedAt = ttsAt;
        segment.latency.translationEndToTtsMs =
          ttsAt - segment.latency.translationCompletedAt;
        const iterator = tts
          .synthesize(
            translated.text,
            result.counters.ttsTasks,
            controller.signal,
          )
          [Symbol.asyncIterator]();
        const parts: Buffer[] = [];
        try {
          let audioFinished = false;
          while (!audioFinished) {
            const next = await abortRace(iterator.next());
            assertLive();
            if (next.done) {
              audioFinished = true;
              break;
            }
            if (
              !Buffer.isBuffer(next.value) ||
              !next.value.length ||
              next.value.length % 2
            )
              throw new Error('ALIYUN_AUDITION_TTS_PCM_INVALID');
            const at = now();
            if (segment.latency.firstPcmAt === null) {
              segment.latency.firstPcmAt = at;
              segment.latency.ttsFirstPcmMs = at - ttsAt;
              segment.latency.sourceEndToFirstPcmMs =
                sourceEnd === null ? null : at - sourceEnd;
            }
            const remaining =
              ALIYUN_AUDITION_LIMITS.outputSeconds * BYTES_PER_SECOND -
              result.counters.outputBytesReceived;
            const accepted = next.value.subarray(0, remaining);
            parts.push(Buffer.from(accepted));
            result.counters.outputBytesReceived += accepted.length;
            segment.pcm = Buffer.concat(parts);
            if (
              next.value.length > remaining ||
              result.counters.outputBytesReceived >=
                ALIYUN_AUDITION_LIMITS.outputSeconds * BYTES_PER_SECOND
            )
              throw new Error('ALIYUN_AUDITION_OUTPUT_OBSERVATION_LIMIT');
          }
        } finally {
          await iterator.return?.();
        }
        if (!segment.pcm.length) throw new Error('ALIYUN_AUDITION_TTS_EMPTY');
      };
      const drain = async () => {
        while (!stoppedCode && sources.size) {
          const sequence = Math.min(...sources.keys());
          const item = sources.get(sequence)!;
          if (!item.source.final) return;
          sources.delete(sequence);
          consumed.set(sequence, item.source);
          retiredThrough = sequence;
          if (item.source.text.trim()) await process(item);
        }
      };
      const schedule = () => {
        if (worker || stoppedCode) return;
        worker = drain()
          .catch((error) => stop(codeFor(error)))
          .finally(() => {
            worker = undefined;
            if (
              !stoppedCode &&
              sources.size &&
              sources.get(Math.min(...sources.keys()))!.source.final
            )
              schedule();
          });
      };
      if (result.counters.asrTasks >= ALIYUN_AUDITION_LIMITS.asrTasks)
        throw new Error('ALIYUN_AUDITION_ASR_LIMIT');
      result.counters.asrTasks += 1;
      const asr = (options.deps?.createAsr ?? createAliyunPlanBAsrClient)({
        config,
        role: clip.role,
        now,
        getContext: snapshot,
        onUsage: usage,
        onEvidence: evidence,
        onError: stop,
        onSource: (source) => {
          if (stoppedCode) return;
          try {
            assertLive();
            const receivedAt = now();
            if (
              !Number.isSafeInteger(source.sequence) ||
              source.sequence < 1 ||
              !Number.isSafeInteger(source.revision) ||
              source.revision < 1 ||
              typeof source.text !== 'string' ||
              source.text.length > 4096 ||
              typeof source.final !== 'boolean'
            )
              throw new Error('ALIYUN_AUDITION_ASR_SOURCE_INVALID');
            if (clipResult.observations.length >= MAX_SOURCE_EVENTS)
              throw new Error('ALIYUN_AUDITION_SOURCE_EVENT_LIMIT');
            clipResult.observations.push({ ...source, receivedAt });
            const done = consumed.get(source.sequence);
            if (source.sequence <= retiredThrough || done) {
              if (done && source.final && done.text === source.text)
                result.counters.duplicateFinalsIgnored += 1;
              else {
                result.counters.lateRevisionsIgnored += 1;
                evidence({
                  layer: 'asr',
                  event: 'correction',
                  role: clip.role,
                  region: config.region,
                  sequence: source.sequence,
                  code: 'ALIYUN_AUDITION_LATE_REVISION_IGNORED',
                });
              }
              return;
            }
            const prior = sources.get(source.sequence);
            if (prior && source.revision <= prior.source.revision) {
              result.counters.duplicateFinalsIgnored += Number(source.final);
              return;
            }
            if (prior?.source.final) {
              if (prior.source.text === source.text)
                result.counters.duplicateFinalsIgnored += 1;
              else {
                result.counters.lateRevisionsIgnored += 1;
                evidence({
                  layer: 'asr',
                  event: 'correction',
                  role: clip.role,
                  region: config.region,
                  sequence: source.sequence,
                  code: 'ALIYUN_AUDITION_LATE_REVISION_IGNORED',
                });
              }
              return;
            }
            const partialStartedAt =
              prior?.partialStartedAt ??
              (!source.final ? receivedAt : undefined);
            if (partialStartedAt !== undefined)
              clipResult.maxPartialWaitMs = Math.max(
                clipResult.maxPartialWaitMs,
                receivedAt - partialStartedAt,
              );
            sources.set(source.sequence, {
              source: { ...source },
              receivedAt,
              partialStartedAt,
            });
            if (source.final) {
              if (clipResult.finishRequestedAt === null)
                clipResult.finalsBeforeFinish += 1;
              else clipResult.finalsAfterFinish += 1;
              schedule();
            }
          } catch (error) {
            stop(codeFor(error));
          }
        },
      });
      asrClients.add(asr);
      await abortRace(asr.ready);
      assertLive();
      clipResult.audioSendStartedAt = now();
      for (let offset = 0; offset < clip.pcm.length; offset += FRAME_BYTES) {
        assertLive();
        const frame = clip.pcm.subarray(offset, offset + FRAME_BYTES);
        const targetAt =
          clipResult.audioSendStartedAt + (offset * 1000) / BYTES_PER_SECOND;
        const delayMs = Math.max(0, Math.ceil(targetAt - now()));
        if (delayMs)
          await abortRace((options.delay ?? wait)(delayMs, controller.signal));
        assertLive();
        result.counters.inputBytesSent += frame.length;
        asr.append(frame);
      }
      const audioEndAt = clipResult.audioSendStartedAt + clip.durationMs;
      if (audioEndAt > now())
        await abortRace(
          (options.delay ?? wait)(
            Math.ceil(audioEndAt - now()),
            controller.signal,
          ),
        );
      assertLive();
      clipResult.finishRequestedAt = now();
      await abortRace(asr.finish());
      while (worker) await abortRace(worker);
      assertLive();
      for (const item of sources.values()) {
        if (item.partialStartedAt !== undefined)
          clipResult.maxPartialWaitMs = Math.max(
            clipResult.maxPartialWaitMs,
            now() - item.partialStartedAt,
          );
      }
      if (sources.size) throw new Error('ALIYUN_AUDITION_ASR_FINAL_MISSING');
      if (!consumed.size) throw new Error('ALIYUN_AUDITION_ASR_EMPTY');
      clipResult.finalizationAfterFinishObserved =
        clipResult.finalsAfterFinish > 0;
      // This annotation identifies the clip's last spoken sample, rather than
      // the endpoint of every earlier natural sentence in the same file.
      const lastSegment = result.segments
        .filter((segment) => segment.clipId === clip.id)
        .at(-1);
      if (
        clip.speechEndMs !== undefined &&
        clipResult.audioSendStartedAt !== null &&
        lastSegment?.latency.firstPcmAt !== null &&
        lastSegment?.latency.firstPcmAt !== undefined
      )
        lastSegment.latency.annotatedClipSpeechEndToFirstPcmMs =
          lastSegment.latency.firstPcmAt -
          (clipResult.audioSendStartedAt + clip.speechEndMs);
      asr.abort();
      asrClients.delete(asr);
    }
  } catch (error) {
    stop(codeFor(error));
    result.status =
      stoppedCode === 'ALIYUN_AUDITION_CANCELLED' ? 'cancelled' : 'failed';
    result.errorCode = stoppedCode;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalAbort);
    controller.abort();
    for (const asr of asrClients) {
      try {
        asr.abort();
      } catch {
        /* No retry on cleanup. */
      }
    }
    try {
      tts?.abort();
    } catch {
      /* No retry on cleanup. */
    }
    // Native MT cancellation reports usage from its rejection continuation.
    // Give that fenced continuation one turn; never wait for another response.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    collectUsage = false;
    result.endedAt = now();
  }
  return result;
}
