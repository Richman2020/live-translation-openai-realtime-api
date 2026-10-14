/* eslint-disable no-await-in-loop -- A single FIFO translator and audio queue preserve source order. */
/* eslint-disable no-continue -- Stale immutable snapshots must be skipped without retry or replay. */
import { performance } from 'node:perf_hooks';

import { createCaptionSections, type CaptionSection } from './caption-sections';
import { normalizeCaptionDisplay } from './caption-normalization';
import type {
  CallContextObservation,
  CallContextQuery,
  CallContextSnapshot,
} from './call-context';
import { createAliyunPlanBAsrClient } from './aliyun-planb-asr';
import { translateAliyunPlanB } from './aliyun-planb-translation';
import { createAliyunPlanBTts } from './aliyun-planb-tts';
import type {
  AliyunPlanBConfig,
  PlanBAsrClient,
  PlanBAsrSource,
  PlanBAsrOptions,
  PlanBEvidence,
  PlanBSocketFactory,
  PlanBTranslationOptions,
  PlanBTranslationResult,
  PlanBTtsClient,
  PlanBTtsOptions,
  PlanBUsage,
} from './aliyun-planb-types';
import type { TranscriptEvent, TranslationRole } from './translation-bridge';

export type PlanBSourceCorrection = {
  role: TranslationRole;
  sourceSequence: number;
  sourceRevision: number;
  utteranceId: string;
  rawText: string;
  /** Independent evidence: never silently changes text already sent to TTS. */
  frozenText: string;
  audioExposed: boolean;
};
export type PlanBAudioMetadata = {
  utteranceId: string;
  sessionEpoch: number;
  sourceRevision: number;
};
export type AliyunPlanBPipelineOptions = {
  config: AliyunPlanBConfig;
  role: TranslationRole;
  onTranscript: (event: TranscriptEvent) => void;
  onAudio?: (pcm: Buffer, metadata: PlanBAudioMetadata) => void;
  onAudioComplete?: (metadata: PlanBAudioMetadata) => void;
  beforeAudio?: (
    pcmBytes: number,
    metadata: PlanBAudioMetadata,
    signal: AbortSignal,
  ) => Promise<void>;
  waitForPlayback?: boolean;
  onError: (code: string) => void;
  getContext?: (query: CallContextQuery) => CallContextSnapshot;
  onSource?: (source: CallContextObservation) => void;
  onUsage?: (event: PlanBUsage) => void;
  onEvidence?: (event: PlanBEvidence) => void;
  onCorrection?: (event: PlanBSourceCorrection) => void;
  createAsr?: (options: PlanBAsrOptions) => PlanBAsrClient;
  translate?: (
    options: PlanBTranslationOptions,
  ) => Promise<PlanBTranslationResult>;
  createTts?: (options: PlanBTtsOptions) => PlanBTtsClient;
  createWebSocket?: PlanBSocketFactory;
  fetch?: typeof fetch;
  now?: () => number;
  pauseMs?: number;
  timeoutMs?: number;
};
export type AliyunPlanBPipeline = {
  ready: Promise<void>;
  append(pcm: Buffer): void;
  finish(): Promise<void>;
  abort(): void;
  breakSection(): void;
  acknowledgeAudio(utteranceId: string): boolean;
};

type SectionState = CaptionSection & {
  utteranceId: string;
  sequence: number;
  revision: number;
  translated?: string;
  audioExposed: boolean;
  done: boolean;
  translationRevision: number;
};
type SourceState = PlanBAsrSource & { sectionId?: string; sealed?: boolean };
type Job = {
  section: SectionState;
  text: string;
  revision: number;
  final: boolean;
  context: CallContextSnapshot;
};
const MAX_RECORDS = 512;
const MAX_JOBS = 24;
const MAX_QUEUE_CHARS = 16000;
const AUDIO_CHUNK_BYTES = 4800;
const DRAFT_INTERVAL_MS = 350;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const emptyContext = (): CallContextSnapshot => ({ version: 0, entries: [] });

/** Per-call, per-speaker queue. No environment reads, persistence or fallback. */
export function createAliyunPlanBPipeline(
  options: AliyunPlanBPipelineOptions,
): AliyunPlanBPipeline {
  if (
    !['local', 'remote'].includes(options.role) ||
    typeof options.onTranscript !== 'function' ||
    typeof options.onError !== 'function' ||
    (options.role === 'local' && typeof options.onAudio !== 'function') ||
    (options.pauseMs !== undefined &&
      (!integer(options.pauseMs) ||
        options.pauseMs < 1 ||
        options.pauseMs > 5000)) ||
    (options.timeoutMs !== undefined &&
      (!integer(options.timeoutMs) || options.timeoutMs < 1))
  )
    throw new Error('PLANB_PIPELINE_INVALID_OPTIONS');
  const now = options.now || Date.now;
  const sections = createCaptionSections();
  const sources = new Map<number, SourceState>();
  const records = new Map<string, SectionState>();
  const pending = new Map<string, Job>();
  const controllers = new Set<AbortController>();
  let sequence = 0;
  let ttsSequence = 0;
  let translationSequence = 0;
  let retiredSource = 0;
  let active: { job: Job; controller: AbortController } | undefined;
  let closed = false;
  let finishing = false;
  let running = false;
  let pause: ReturnType<typeof setTimeout> | undefined;
  let draftWake: ReturnType<typeof setTimeout> | undefined;
  let sourceWait: ReturnType<typeof setTimeout> | undefined;
  let lastDraftAt = -Infinity;
  let tts: PlanBTtsClient | undefined;
  let asr: PlanBAsrClient;
  let failure: string | undefined;
  let playback:
    | {
        id: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const drained: Array<() => void> = [];
  const notify = <T>(callback: ((event: T) => void) | undefined, event: T) => {
    try {
      callback?.(event);
    } catch {
      // Observers cannot suppress teardown or change supplier selection.
    }
  };
  const evidence = (event: PlanBEvidence['event'], code?: string) =>
    notify(options.onEvidence, {
      layer: 'pipeline',
      event,
      role: options.role,
      region: options.config.region,
      ...(code ? { code } : {}),
    });
  const finishDrain = () => {
    if (!running && !pending.size) drained.splice(0).forEach((done) => done());
  };
  const stop = (code?: string) => {
    if (closed) return;
    closed = true;
    failure = code;
    clearTimeout(pause);
    clearTimeout(draftWake);
    clearTimeout(sourceWait);
    for (const controller of controllers) controller.abort();
    controllers.clear();
    pending.clear();
    if (playback) {
      clearTimeout(playback.timer);
      playback.reject(new Error('PLANB_PIPELINE_CANCELLED'));
      playback = undefined;
    }
    try {
      asr?.abort();
    } catch {
      // Continue independent TTS cleanup.
    }
    try {
      tts?.abort();
    } catch {
      // No further output is accepted once closed is set.
    }
    sources.clear();
    records.clear();
    evidence(code ? 'failed' : 'cancelled', code);
    if (code) notify(options.onError, code);
    finishDrain();
  };
  const emit = (
    record: SectionState,
    kind: TranscriptEvent['kind'],
    text: string,
    final: boolean,
  ) => {
    if (closed) return;
    const normalization =
      kind === 'original' ? normalizeCaptionDisplay(text) : undefined;
    notify(options.onTranscript, {
      id: `${record.utteranceId}:${kind}`,
      utteranceId: record.utteranceId,
      role: options.role,
      kind,
      text,
      final,
      at: record.at,
      pairing: 'explicit',
      boundary: 'semantic',
      revision:
        kind === 'original' ? record.revision : record.translationRevision,
      sourceRevision: record.revision,
      ...(record.sourceEndAt === undefined
        ? {}
        : { sourceEndAt: record.sourceEndAt }),
      ...(normalization?.normalization ? normalization : {}),
    });
  };
  const waitPlayback = (id: string) => {
    if (!options.waitForPlayback) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop('PLANB_PLAYBACK_UNCONFIRMED');
      }, options.timeoutMs ?? 20000);
      timer.unref?.();
      playback = { id, resolve, reject, timer };
    });
  };
  const current = (job: Job) =>
    !closed && job.section.revision === job.revision;
  const execute = async (job: Job, controller: AbortController) => {
    const record = job.section;
    translationSequence += 1;
    const context = job.final
      ? options.getContext?.({
          beforeAt: record.at,
          observedBeforeAt: Math.max(now(), record.at),
          allowLateFinal: true,
        }) || job.context
      : job.context;
    const result = await (options.translate || translateAliyunPlanB)({
      config: options.config,
      role: options.role,
      text: job.text,
      context,
      sequence: translationSequence,
      signal: controller.signal,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      onDelta: (text) => {
        if (!current(job) || controller.signal.aborted) return;
        record.translationRevision += 1;
        emit(record, 'translation', text, false);
      },
      onUsage: options.onUsage,
      onEvidence: options.onEvidence,
    });
    if (!current(job) || controller.signal.aborted) return;
    if (
      !result ||
      typeof result.text !== 'string' ||
      !result.text.trim() ||
      result.text.length > 16000
    )
      throw new Error('PLANB_TRANSLATION_INVALID_RESULT');
    record.translated = result.text;
    record.translationRevision += 1;
    emit(record, 'translation', result.text, job.final);
    if (!job.final) return;
    if (options.role === 'remote') {
      record.done = true;
      return;
    }
    tts ||= (options.createTts || createAliyunPlanBTts)({
      config: options.config,
      createWebSocket: options.createWebSocket,
      timeoutMs: options.timeoutMs,
      onUsage: options.onUsage,
      onEvidence: options.onEvidence,
    });
    const metadata: PlanBAudioMetadata = {
      utteranceId: record.utteranceId,
      sessionEpoch: 1,
      sourceRevision: job.revision,
    };
    let generated = 0;
    ttsSequence += 1;
    for await (const pcm of tts.synthesize(
      result.text,
      ttsSequence,
      controller.signal,
    )) {
      if (!current(job) || controller.signal.aborted) return;
      if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2)
        throw new Error('PLANB_TTS_INVALID_PCM');
      for (
        let offset = 0;
        offset < pcm.length && current(job);
        offset += AUDIO_CHUNK_BYTES
      ) {
        const chunk = pcm.subarray(offset, offset + AUDIO_CHUNK_BYTES);
        await options.beforeAudio?.(chunk.length, metadata, controller.signal);
        if (!current(job) || controller.signal.aborted) return;
        record.audioExposed = true;
        generated += chunk.length;
        options.onAudio!(chunk, metadata);
      }
    }
    if (!current(job) || controller.signal.aborted) return;
    if (!generated) throw new Error('PLANB_TTS_EMPTY_AUDIO');
    // Reserve the ACK waiter before callback; a fake or fast mark can ACK inline.
    const acknowledged = waitPlayback(record.utteranceId);
    notify(options.onAudioComplete, metadata);
    await acknowledged;
    if (!current(job)) return;
    record.done = true;
  };
  const pump = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed && pending.size) {
        const [id, job] = [...pending.entries()].sort(
          (a, b) =>
            a[1].section.at - b[1].section.at ||
            a[1].section.sequence - b[1].section.sequence,
        )[0];
        const earlier = [...records.values()].some(
          (record) =>
            record !== job.section &&
            !record.final &&
            (record.at < job.section.at ||
              (record.at === job.section.at &&
                record.sequence < job.section.sequence)),
        );
        if (job.final && earlier) {
          // A later completed ASR item cannot overtake a known earlier source.
          // A finite missing-final timeout is a fault cleanup, never a call cap.
          sourceWait ||= setTimeout(
            () => stop('PLANB_SOURCE_ORDER_UNRESOLVED'),
            options.timeoutMs ?? 20000,
          );
          sourceWait.unref?.();
          break;
        }
        clearTimeout(sourceWait);
        sourceWait = undefined;
        const draftWait = DRAFT_INTERVAL_MS - (performance.now() - lastDraftAt);
        if (!job.final && !finishing && draftWait > 0) {
          clearTimeout(draftWake);
          draftWake = setTimeout(() => {
            pump().catch(() => stop('PLANB_PIPELINE_QUEUE_FAILED'));
          }, draftWait);
          draftWake.unref?.();
          break;
        }
        pending.delete(id);
        if (!current(job)) continue;
        if (!job.final) lastDraftAt = performance.now();
        const controller = new AbortController();
        controllers.add(controller);
        active = { job, controller };
        try {
          await execute(job, controller);
        } catch {
          if (!closed && !controller.signal.aborted && current(job))
            stop('PLANB_PIPELINE_PROVIDER_FAILED');
        } finally {
          controllers.delete(controller);
          active = undefined;
        }
      }
    } finally {
      running = false;
      finishDrain();
    }
  };
  const withdraw = (record: SectionState) => {
    if (closed || record.audioExposed) return;
    if (active?.job.section === record) active.controller.abort();
    pending.delete(record.id);
    record.text = '';
    record.translated = '';
    record.final = true;
    record.done = true;
    record.revision += 1;
    record.translationRevision += 1;
    emit(record, 'original', '', true);
    emit(record, 'translation', '', true);
    if (closed) return;
    notify(options.onSource, {
      role: options.role,
      sourceId: record.utteranceId,
      sourceKind: 'asr',
      at: record.at,
      order: record.sequence,
      revision: record.revision,
      observedAt: Math.max(now(), record.at, record.sourceEndAt ?? 0),
      text: '',
      final: true,
      ...(record.sourceEndAt === undefined
        ? {}
        : { sourceEndAt: record.sourceEndAt }),
    });
    evidence('correction', 'PLANB_SOURCE_WITHDRAWN');
  };
  const receiveSections = (
    updates: CaptionSection[],
    originSequence?: number,
  ) => {
    for (const update of updates) {
      if (closed) return;
      let record = records.get(update.id);
      if (!update.text.trim()) {
        if (record && update.final) {
          record.sourceEndAt = update.sourceEndAt;
          withdraw(record);
        }
        continue;
      }
      if (!record) {
        if (records.size >= MAX_RECORDS) {
          const activeRecord = active?.job.section;
          const evict = [...records.entries()].find(
            ([, item]) =>
              item.done && activeRecord !== item && !pending.has(item.id),
          );
          if (!evict) {
            stop('PLANB_PIPELINE_CAPACITY');
            return;
          }
          records.delete(evict[0]);
        }
        sequence += 1;
        record = {
          ...update,
          text: '',
          final: false,
          utteranceId: `planb_${options.role}_${update.id}`,
          sequence,
          revision: 0,
          translationRevision: 0,
          audioExposed: false,
          done: false,
        };
        records.set(update.id, record);
      }
      if (
        record.final ||
        (record.text === update.text &&
          record.revision &&
          record.final === update.final)
      )
        continue;
      Object.assign(record, update);
      record.revision += 1;
      const origin =
        originSequence === undefined ? undefined : sources.get(originSequence);
      if (origin && !origin.sectionId) origin.sectionId = update.id;
      for (const source of sources.values()) {
        if (!source.sealed && source.sectionId === update.id) {
          if (update.final) source.sealed = true;
        }
      }
      emit(record, 'original', record.text, record.final);
      if (closed) return;
      notify(options.onSource, {
        role: options.role,
        sourceId: record.utteranceId,
        sourceKind: 'asr',
        at: record.at,
        order: record.sequence,
        revision: record.revision,
        observedAt: Math.max(now(), record.at, record.sourceEndAt ?? 0),
        text: record.text,
        final: record.final,
        ...(record.sourceEndAt === undefined
          ? {}
          : { sourceEndAt: record.sourceEndAt }),
      });
      if (closed) return;
      const context =
        options.getContext?.({
          beforeAt: record.at,
          observedBeforeAt: Math.max(now(), record.at),
          allowLateFinal: true,
        }) || emptyContext();
      // Only provisional work may be superseded; a confirmed voice queue is
      // never cancelled merely because the same speaker continues speaking.
      if (active && active.job.section === record && !active.job.final)
        active.controller.abort();
      pending.set(record.id, {
        section: record,
        text: record.text,
        revision: record.revision,
        final: record.final,
        context,
      });
      if (record.final) clearTimeout(draftWake);
      if (
        pending.size > MAX_JOBS ||
        [...pending.values()].reduce(
          (total, job) => total + job.text.length,
          0,
        ) > MAX_QUEUE_CHARS
      ) {
        stop('PLANB_PIPELINE_QUEUE_CAPACITY');
        return;
      }
    }
    pump().catch(() => stop('PLANB_PIPELINE_QUEUE_FAILED'));
  };
  const seal = (speakerChange = false) => {
    if (closed) return;
    clearTimeout(pause);
    pause = undefined;
    receiveSections(speakerChange ? sections.break() : sections.seal());
  };
  const onSource = (event: PlanBAsrSource) => {
    if (closed) return;
    if (
      !event ||
      !integer(event.sequence) ||
      event.sequence < 1 ||
      !integer(event.revision) ||
      event.revision < 1 ||
      typeof event.text !== 'string' ||
      event.text.length > 4096 ||
      typeof event.final !== 'boolean' ||
      !integer(event.at) ||
      (event.endAt !== undefined &&
        (!integer(event.endAt) || event.endAt < event.at))
    ) {
      stop('PLANB_ASR_INVALID_SOURCE');
      return;
    }
    const previous = sources.get(event.sequence);
    if (event.sequence <= retiredSource && !previous) return;
    if (previous) {
      if (
        event.at !== previous.at ||
        event.revision < previous.revision ||
        (previous.final && !event.final)
      )
        return;
      if (event.revision === previous.revision) {
        if (event.text !== previous.text || event.final !== previous.final)
          stop('PLANB_ASR_SOURCE_CONFLICT');
        return;
      }
      if (previous.sealed) {
        if (event.text !== previous.text) {
          const record = previous.sectionId && records.get(previous.sectionId);
          if (record && !record.audioExposed && !event.text.trim()) {
            withdraw(record);
            sources.set(event.sequence, { ...previous, ...event });
            pump().catch(() => stop('PLANB_PIPELINE_QUEUE_FAILED'));
            return;
          }
          notify(options.onCorrection, {
            role: options.role,
            sourceSequence: event.sequence,
            sourceRevision: event.revision,
            utteranceId: record?.utteranceId || `planb_${options.role}_retired`,
            rawText: event.text,
            frozenText: record?.text || previous.text,
            audioExposed: record?.audioExposed || false,
          });
          evidence('correction');
        }
        sources.set(event.sequence, { ...previous, ...event });
        return;
      }
    } else {
      if (sources.size >= MAX_RECORDS) {
        const evict = [...sources.entries()].find(
          ([, source]) => source.sealed,
        );
        if (!evict) {
          stop('PLANB_PIPELINE_CAPACITY');
          return;
        }
        sources.delete(evict[0]);
        retiredSource = Math.max(retiredSource, evict[0]);
      }
      sections.register(`source_${event.sequence}`, event.at);
    }
    clearTimeout(pause);
    sources.set(event.sequence, { ...previous, ...event });
    try {
      receiveSections(
        sections.update(
          `source_${event.sequence}`,
          event.text,
          event.final,
          event.endAt,
        ),
        event.sequence,
      );
      if (event.final && !event.text.trim()) {
        const source = sources.get(event.sequence);
        if (source) source.sealed = true;
      }
      // The shared section helper targets English endpointing. Chinese full
      // clauses use their actual punctuation, never guessed punctuation.
      if (
        event.final &&
        options.role === 'local' &&
        (/[。！？][”’）】]*$/u.test(event.text) || event.text.length >= 240)
      )
        seal();
      else if (event.final) {
        pause = setTimeout(() => seal(), options.pauseMs ?? 1200);
        pause.unref?.();
      }
    } catch {
      stop('PLANB_ASR_INVALID_SOURCE');
    }
  };
  try {
    asr = (options.createAsr || createAliyunPlanBAsrClient)({
      config: options.config,
      role: options.role,
      createWebSocket: options.createWebSocket,
      now,
      timeoutMs: options.timeoutMs,
      onSource,
      onError: (code) => stop(code),
      onUsage: options.onUsage,
      onEvidence: options.onEvidence,
      getContext: () =>
        options.getContext?.({ beforeAt: now() }) || emptyContext(),
    });
  } catch {
    stop('PLANB_ASR_CREATION_FAILED');
    throw new Error('PLANB_ASR_CREATION_FAILED');
  }
  const ready = asr.ready.catch(() => {
    stop('PLANB_ASR_NOT_READY');
    throw new Error('PLANB_ASR_NOT_READY');
  });
  ready.catch(() => {});
  let finishTask: Promise<void> | undefined;
  return {
    ready,
    append(pcm) {
      if (closed || finishing) return;
      if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) {
        stop('PLANB_PIPELINE_INVALID_PCM');
        return;
      }
      try {
        asr.append(pcm);
      } catch {
        stop('PLANB_ASR_APPEND_FAILED');
      }
    },
    finish() {
      if (finishTask) return finishTask;
      finishing = true;
      finishTask = (async () => {
        await asr.finish();
        seal();
        if (running || pending.size)
          await new Promise<void>((resolve) => {
            drained.push(resolve);
          });
        if (failure) throw new Error(failure);
      })().catch(() => {
        if (!closed) stop('PLANB_PIPELINE_FINISH_FAILED');
        throw new Error(failure || 'PLANB_PIPELINE_FINISH_FAILED');
      });
      finishTask.catch(() => {});
      return finishTask;
    },
    abort: () => stop(),
    breakSection: () => seal(true),
    acknowledgeAudio(id) {
      if (closed || !playback || playback.id !== id) return false;
      clearTimeout(playback.timer);
      const { resolve } = playback;
      playback = undefined;
      resolve();
      return true;
    },
  };
}
