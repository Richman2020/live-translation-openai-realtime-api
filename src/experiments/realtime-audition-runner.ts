import { setTimeout as delay } from 'node:timers/promises';
import type WebSocket from 'ws';

import {
  createRealtimePrototypeClient,
  type RealtimePrototypeClient,
  type RealtimePrototypeSourceCorrection,
  type RealtimePrototypeTranscriptEvent,
} from '../solo/realtime-prototype-client';
import type { PreparedAuditionInput } from './realtime-audition-input';
import {
  createAuditionTransport,
  type AuditionTransportSnapshot,
} from './realtime-audition-transport';

export const AUDITION_PARENT_CANDIDATE =
  '320f01c4fa037989bddc8a26e0574e7282730c8a';
export type AuditionApproval = {
  version: 1;
  parentCandidate: typeof AUDITION_PARENT_CANDIDATE;
  approvedUsd: 1;
  approvalReference: string;
  sampleUseReference: string;
  sampleSha256: string;
};
export function validateAuditionApproval(
  value: unknown,
  input: PreparedAuditionInput,
): AuditionApproval {
  const data = value as AuditionApproval;
  const keys = [
    'version',
    'parentCandidate',
    'approvedUsd',
    'approvalReference',
    'sampleUseReference',
    'sampleSha256',
  ];
  const reference = (text: unknown) =>
    typeof text === 'string' &&
    text.trim().length > 0 &&
    text.length <= 500 &&
    ![...text].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length !== keys.length ||
    Object.keys(data).some((key) => !keys.includes(key)) ||
    data.version !== 1 ||
    data.parentCandidate !== AUDITION_PARENT_CANDIDATE ||
    data.approvedUsd !== 1 ||
    !reference(data.approvalReference) ||
    !reference(data.sampleUseReference) ||
    !/^[a-f0-9]{64}$/.test(data.sampleSha256) ||
    data.sampleSha256 !== input.wavSha256
  )
    throw new Error('AUDITION_APPROVAL_REQUIRED');
  return { ...data };
}

type SourceTiming = {
  sourceSequence: number;
  firstInputMs?: number;
  firstEnergyInputMs?: number;
  commitMs?: number;
  asrFinalMs?: number;
  requestMs?: number;
  firstOutputMs?: number;
  firstEnergyOutputMs?: number;
  completedMs?: number;
};
export type RealtimeAuditionResult = {
  status: 'completed' | 'stopped' | 'failed';
  reason?: string;
  model: 'gpt-realtime-2.1';
  voice: 'echo';
  parentCandidate: typeof AUDITION_PARENT_CANDIDATE;
  responses: {
    sourceSequence: number;
    responseId: string;
    pcm: Buffer;
    rawAsrText?: string;
    translationText?: string;
    status: 'completed' | 'partial';
    timing: {
      firstAudioMs?: number;
      firstEnergyAudioMs?: number;
      completedMs?: number;
    };
  }[];
  transcripts: RealtimePrototypeTranscriptEvent[];
  corrections: RealtimePrototypeSourceCorrection[];
  usage: AuditionTransportSnapshot['usage'];
  counts: {
    inputBytesFed: number;
    inputSamples: number;
    outputBytesSaved: number;
    asrCommits: number;
    responsesRequested: number;
    connections: number;
  };
  accounting: AuditionTransportSnapshot;
  timing: {
    startedAt: string;
    durationMs: number;
    firstInputMs?: number;
    firstInputEnergyMs?: number;
    firstOutputMs?: number;
    firstOutputEnergyMs?: number;
    sources: SourceTiming[];
  };
};
export type AuditionRunOptions = {
  input: PreparedAuditionInput;
  authorization: AuditionApproval;
  apiKey: string;
  createWebSocket: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  proxyUrl?: string;
  pace?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  timeouts?: {
    readyTimeoutMs?: number;
    progressTimeoutMs?: number;
    wallTimeoutMs?: number;
    cleanupTimeoutMs?: number;
  };
};

/** RMS threshold measures captured PCM energy, not perceived/mouth-to-ear latency. */
function energy(pcm: Buffer) {
  let sum = 0;
  for (let index = 0; index + 1 < pcm.length; index += 2)
    sum += pcm.readInt16LE(index) ** 2;
  return pcm.length > 0 && sum / (pcm.length / 2) >= 20 ** 2;
}

/** No microphone, credential discovery, real socket default, retry or reconnect. */
export async function runRealtimeAudition(
  options: AuditionRunOptions,
): Promise<RealtimeAuditionResult> {
  const { input } = options;
  validateAuditionApproval(options.authorization, input);
  if (
    !Buffer.isBuffer(input.pcm) ||
    !input.pcm.length ||
    input.pcm.length % 2 ||
    input.pcm.length > 24 * 48000 ||
    input.totalSamples !== input.pcm.length / 2 ||
    input.sampleRate !== 24000 ||
    input.preflightCommits < 1 ||
    input.preflightCommits > 6 ||
    typeof options.createWebSocket !== 'function' ||
    typeof options.apiKey !== 'string' ||
    !options.apiKey.trim()
  )
    throw new Error('AUDITION_INVALID_OPTIONS');
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started) || started < 0)
    throw new Error('AUDITION_INVALID_CLOCK');
  const elapsed = () => Math.max(0, now() - started);
  const timing: RealtimeAuditionResult['timing'] = {
    startedAt: new Date().toISOString(),
    durationMs: 0,
    sources: [],
  };
  const sourceTiming = (sequence: number) => {
    let found = timing.sources.find(
      (entry) => entry.sourceSequence === sequence,
    );
    if (!found) {
      found = { sourceSequence: sequence };
      timing.sources.push(found);
    }
    return found;
  };
  const controller = new AbortController();
  const transcripts = new Map<string, RealtimePrototypeTranscriptEvent>();
  const corrections: RealtimePrototypeSourceCorrection[] = [];
  const responses: RealtimeAuditionResult['responses'] = [];
  const rawIds = new Map<string, number>();
  let client: RealtimePrototypeClient | undefined;
  let failure: string | undefined;
  let stopped: string | undefined;
  let fed = 0;
  let outputBytes = 0;
  let completed = false;
  const transport = createAuditionTransport({
    ...options.timeouts,
    createWebSocket: options.createWebSocket,
    now,
    onStop: (reason) => {
      stopped = reason;
      controller.abort();
    },
  });
  const stop = (reason: string) => {
    stopped = reason;
    controller.abort();
    return transport.stop(reason);
  };
  const abort = () => {
    stop('AUDITION_USER_CANCELLED');
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const pace =
    options.pace ?? ((ms, signal) => delay(ms, undefined, { signal }));
  try {
    if (options.signal?.aborted) {
      await stop('AUDITION_USER_CANCELLED');
    } else {
      client = createRealtimePrototypeClient({
        apiKey: options.apiKey,
        voice: 'echo',
        proxyUrl: options.proxyUrl,
        createWebSocket: transport.createWebSocket,
        now: () => Math.floor(now()),
        timeoutMs: options.timeouts?.progressTimeoutMs ?? 15000,
        onError: (code) => {
          failure = /^PROTOTYPE_[A-Z_]+$/.test(code)
            ? code
            : 'AUDITION_CLIENT_FAILED';
          stop(failure);
        },
        onEvidence: (event) => {
          if (!event.sourceSequence || controller.signal.aborted) return;
          const entry = sourceTiming(event.sourceSequence);
          if (event.type === 'source_committed') entry.commitMs ??= elapsed();
          if (event.type === 'source_final') entry.asrFinalMs ??= elapsed();
          if (event.type === 'response_requested')
            entry.requestMs ??= elapsed();
        },
        onConversationTranscript: (event) => {
          if (!controller.signal.aborted)
            transcripts.set(event.id, { ...event });
        },
        onSourceCorrection: (event) => {
          if (!controller.signal.aborted && corrections.length < 48)
            corrections.push({ ...event });
        },
        onAudio: (pcm, metadata) => {
          if (controller.signal.aborted) return;
          let index = rawIds.get(metadata.responseId);
          if (index === undefined) {
            index = responses.length;
            rawIds.set(metadata.responseId, index);
            responses.push({
              sourceSequence: metadata.sourceSequence,
              responseId: `R${index + 1}`,
              pcm: Buffer.alloc(0),
              status: 'partial',
              timing: {},
              rawAsrText: [...transcripts.values()].find(
                (event) =>
                  event.sourceSequence === metadata.sourceSequence &&
                  event.kind === 'original',
              )?.text,
            });
          }
          const response = responses[index];
          const entry = sourceTiming(metadata.sourceSequence);
          const at = elapsed();
          response.timing.firstAudioMs ??= at;
          entry.firstOutputMs ??= at;
          timing.firstOutputMs ??= at;
          const remaining = 36 * 48000 - outputBytes;
          const captured = pcm.subarray(0, remaining);
          if (energy(captured)) {
            response.timing.firstEnergyAudioMs ??= at;
            entry.firstEnergyOutputMs ??= at;
            timing.firstOutputEnergyMs ??= at;
          }
          response.pcm = Buffer.concat([response.pcm, captured]);
          outputBytes += captured.length;
          if (outputBytes >= 36 * 48000) stop('AUDITION_OUTPUT_LIMIT');
        },
        onAudioComplete: (metadata) => {
          if (controller.signal.aborted) return;
          const index = rawIds.get(metadata.responseId);
          if (index === undefined) return;
          const response = responses[index];
          response.status = 'completed';
          response.timing.completedMs = elapsed();
          sourceTiming(metadata.sourceSequence).completedMs = elapsed();
          response.translationText = [...transcripts.values()].find(
            (event) =>
              event.sourceSequence === metadata.sourceSequence &&
              event.kind === 'translation',
          )?.text;
          // ACK means captured to bounded memory, never that a human heard it.
          client?.acknowledgeAudio(metadata.epoch, metadata.responseId);
        },
      });
      // A transport timeout must unblock an unfinished parent promise, without
      // destroying the raw cancellation/usage listener before its bounded drain.
      transport.closed.then(() => {
        if (!completed) client?.abort();
      });
      await client.ready;
      for (let offset = 0; offset < input.pcm.length; offset += 480) {
        if (controller.signal.aborted) break;
        const frame = input.pcm.subarray(offset, offset + 480);
        const at = elapsed();
        timing.firstInputMs ??= at;
        if (energy(frame)) timing.firstInputEnergyMs ??= at;
        for (const source of input.preflightSources) {
          if (
            (offset + frame.length) / 2 > source.startSample &&
            offset / 2 < source.endSample
          ) {
            const entry = sourceTiming(source.sequence);
            entry.firstInputMs ??= at;
            if (energy(frame)) entry.firstEnergyInputMs ??= at;
          }
        }
        fed += frame.length;
        client.append(frame);
        if (!controller.signal.aborted) {
          // Pace sequentially: parallel scheduling would upload faster than source time.
          // eslint-disable-next-line no-await-in-loop
          await pace(frame.length / 48, controller.signal);
        }
      }
      if (!controller.signal.aborted) {
        await client.finish();
        completed =
          !failure &&
          fed === input.pcm.length &&
          responses.length > 0 &&
          responses.every((response) => response.status === 'completed');
        if (completed) await transport.closeSuccess();
        else await stop('AUDITION_NO_COMPLETE_OUTPUT');
      }
    }
  } catch {
    if (!stopped) failure ??= 'AUDITION_EXECUTION_FAILED';
    await stop(failure ?? stopped ?? 'AUDITION_EXECUTION_FAILED');
  } finally {
    controller.abort();
    await transport.stop(failure ?? stopped ?? 'AUDITION_COMPLETE');
    await transport.closed;
    client?.abort();
    options.signal?.removeEventListener('abort', abort);
  }
  const accounting = transport.snapshot();
  timing.durationMs = elapsed();
  const success =
    completed &&
    !failure &&
    accounting.allClosed &&
    accounting.reason === 'AUDITION_COMPLETE';
  let status: RealtimeAuditionResult['status'] = 'failed';
  if (success) status = 'completed';
  else if (stopped === 'AUDITION_USER_CANCELLED') status = 'stopped';
  return {
    status,
    reason: success
      ? undefined
      : (failure ?? stopped ?? 'AUDITION_EXECUTION_FAILED'),
    model: 'gpt-realtime-2.1',
    voice: 'echo',
    parentCandidate: AUDITION_PARENT_CANDIDATE,
    responses,
    transcripts: [...transcripts.values()],
    corrections,
    usage: accounting.usage,
    accounting,
    timing,
    counts: {
      inputBytesFed: fed,
      inputSamples: fed / 2,
      outputBytesSaved: outputBytes,
      asrCommits: accounting.commits,
      responsesRequested: accounting.responses,
      connections: accounting.connections,
    },
  };
}
