import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import WebSocket from 'ws';

import { analyzePcmuPlayback } from '../src/solo/translation-audio-measurement';
import { PcmuToPcm24k } from '../src/solo/translation-pcm';
import type { TranscriptEvent } from '../src/solo/translation-bridge';

// Explicit replay only: no server import, phone call, live microphone, retries,
// environment mutation, generated reference voice, or expected-text prompt.
const CASE_IDS = ['04', '06', 'L02'] as const;
const PREFIX_BYTES = 2400; // 300 ms, also used by the prior return-ZH comparison.
const SUFFIX_BYTES = 32000; // 4000 ms, retained in all timing and input hashes.
const MAX_EVENTS = 4000;
const MAX_RUN_MS = 90000;
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

type CaptionClient = {
  ready: Promise<void>;
  append(pcm24k: Buffer): void;
  finish(): Promise<void>;
  abort(): void;
};
type ClientOptions = {
  apiKey: string;
  proxyUrl?: string;
  onTranscript(event: TranscriptEvent): void;
  onError(code: string): void;
  createWebSocket?: (
    url: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket;
};
export type CaptionFixture = {
  id: string;
  kind: 'human' | 'synthetic_silence';
  input: Buffer;
  provenance: Record<string, unknown>;
};
export type CaptionTimelineEvent = TranscriptEvent & { atMs: number };

function within(root: string, path: string) {
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Enforce real paths as well as lexical paths so junctions cannot escape. */
function privatePath(root: string, path: string, mustExist: boolean) {
  const runtime = resolve(root, '.runtime');
  if (!within(runtime, path)) throw new Error('PATH_MUST_BE_INSIDE_RUNTIME');
  const realRuntime = realpathSync(runtime);
  let ancestor = path;
  while (!existsSync(ancestor)) {
    if (mustExist) throw new Error('PRIVATE_INPUT_NOT_FOUND');
    ancestor = dirname(ancestor);
  }
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realRuntime && !within(realRuntime, realAncestor))
    throw new Error('PRIVATE_PATH_ESCAPES_RUNTIME');
  return path;
}

export function prepareCaptionPlan(args: string[], root = process.cwd()) {
  const flags = new Set(['--dry-run', '--include-silence']);
  const allowed = new Set([...flags, '--manifest', '--out']);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowed.has(arg) || values.has(arg))
      throw new Error('INVALID_ARGUMENTS');
    const value = flags.has(arg) ? 'true' : args[++index];
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
    values.set(arg, value);
  }
  if (!values.get('--out')) throw new Error('OUTPUT_ARGUMENT_REQUIRED');
  const outputRoot = privatePath(
    root,
    resolve(root, values.get('--out')!),
    false,
  );
  if (existsSync(outputRoot)) throw new Error('OUTPUT_ALREADY_EXISTS');
  const manifestPath = privatePath(
    root,
    resolve(
      root,
      values.get('--manifest') ||
        '.runtime/quality-check/human-20260927-source/manifest.json',
    ),
    true,
  );
  if (statSync(manifestPath).size > 256 * 1024)
    throw new Error('MANIFEST_TOO_LARGE');
  const rawManifest = readFileSync(manifestPath);
  const manifest = JSON.parse(rawManifest.toString('utf8'));
  if (
    manifest.version !== 'phone-quality-inputs/1' ||
    manifest.kind !== 'human' ||
    manifest.consentForProjectEvaluation !== true ||
    manifest.format !== 'PCMU_8000_mono' ||
    !Array.isArray(manifest.cases)
  )
    throw new Error('INVALID_MANIFEST_OR_MISSING_CONSENT');
  const fixtures: CaptionFixture[] = CASE_IDS.map((id) => {
    const matches = manifest.cases.filter(
      (item: { id?: string }) => item?.id === id,
    );
    if (matches.length !== 1)
      throw new Error('MISSING_OR_DUPLICATE_REQUIRED_CASE');
    const item = matches[0];
    if (
      item.role !== 'remote' ||
      item.targetLanguage !== 'zh' ||
      typeof item.inputFile !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.inputSha256)
    )
      throw new Error('INVALID_REMOTE_FIXTURE');
    const inputPath = resolve(dirname(manifestPath), item.inputFile);
    if (!within(dirname(manifestPath), inputPath))
      throw new Error('FIXTURE_PATH_ESCAPES_MANIFEST');
    privatePath(root, inputPath, true);
    const inputBytes = statSync(inputPath).size;
    if (!inputBytes || inputBytes > 60 * 8000)
      throw new Error('INPUT_LIMIT_60_SECONDS');
    const input = readFileSync(inputPath);
    if (sha256(input) !== item.inputSha256)
      throw new Error('INPUT_SHA256_MISMATCH');
    return {
      id,
      kind: 'human',
      input,
      provenance: {
        consentForProjectEvaluation: true,
        manifestFile: relative(root, manifestPath),
        manifestSha256: sha256(rawManifest),
        manifestVersion: manifest.version,
        inputFile: relative(root, inputPath),
        inputSha256: item.inputSha256,
        // Expected words are deliberately not copied into any client options.
        expectedTextSentToProvider: false,
      },
    };
  });
  if (values.has('--include-silence')) {
    fixtures.push({
      id: 'silence',
      kind: 'synthetic_silence',
      input: Buffer.alloc(24000, 255),
      provenance: {
        generator: 'PCMU_ZERO_0xFF',
        synthetic: true,
        expectedTextSentToProvider: false,
      },
    });
  }
  return { root, outputRoot, fixtures, dryRun: values.has('--dry-run') };
}

export function summarizeCaptions(events: CaptionTimelineEvent[]) {
  const latest = new Map<string, CaptionTimelineEvent>();
  const finalTexts = new Map<string, string>();
  let emptyEvents = 0;
  let finalRevisions = 0;
  let draftAfterFinal = 0;
  for (const event of events) {
    if (!event.text.trim()) emptyEvents += 1;
    const key = `${event.kind}:${event.id}`;
    if (!event.final && finalTexts.has(key)) draftAfterFinal += 1;
    if (event.final) {
      if (finalTexts.has(key) && finalTexts.get(key) !== event.text)
        finalRevisions += 1;
      finalTexts.set(key, event.text);
    }
    latest.set(key, event);
  }
  const series = (kind: TranscriptEvent['kind']) => {
    const nonempty = events.filter(
      (event) => event.kind === kind && event.text.trim(),
    );
    const drafts = nonempty.filter((event) => !event.final);
    const finals = [...latest.values()].filter(
      (event) => event.kind === kind && event.final && event.text.trim(),
    );
    return {
      events: nonempty.length,
      draftEvents: drafts.length,
      firstDraftAtMs: drafts[0]?.atMs ?? null,
      firstNonemptyAtMs: nonempty[0]?.atMs ?? null,
      firstFinalAtMs: nonempty.find((event) => event.final)?.atMs ?? null,
      lastFinalAtMs: finals.length
        ? Math.max(...finals.map((event) => event.atMs))
        : null,
      finalItems: finals.map((event) => ({
        id: event.id,
        atMs: event.atMs,
        text: event.text,
      })),
      unsettledIds: [...latest.values()]
        .filter((event) => event.kind === kind && !event.final)
        .map((event) => event.id),
    };
  };
  const original = series('original');
  const translation = series('translation');
  const stem = (id: string) =>
    id.replace(/^remote:(original|translation):/, 'remote:');
  const translated = new Set(
    translation.finalItems.map((item) => stem(item.id)),
  );
  const originals = new Set(original.finalItems.map((item) => stem(item.id)));
  return {
    original,
    translation,
    emptyEvents,
    finalRevisions,
    draftAfterFinal,
    originalFinalsWithoutTranslation: original.finalItems
      .filter((item) => !translated.has(stem(item.id)))
      .map((item) => item.id),
    translationFinalsWithoutOriginal: translation.finalItems
      .filter((item) => !originals.has(stem(item.id)))
      .map((item) => item.id),
  };
}

function safeCode(value: unknown) {
  return typeof value === 'string' && /^[A-Z][A-Z_0-9:]{0,100}$/.test(value)
    ? value
    : 'CAPTION_REPLAY_FAILED';
}

/** Safe allowlisted protocol evidence; never save raw errors, headers, or audio. */
export function captionProtocolEvidence(event: Record<string, any>) {
  if (typeof event.type !== 'string') return null;
  if (
    ['transcription_session.updated', 'session.updated'].includes(event.type)
  ) {
    const session = event.session || {};
    const input = session.audio?.input || {};
    const transcription =
      input.transcription || session.input_audio_transcription || {};
    const vad = input.turn_detection || session.turn_detection || {};
    return {
      type: event.type,
      model: typeof session.model === 'string' ? session.model : null,
      sessionType: typeof session.type === 'string' ? session.type : null,
      transcriptionModel:
        typeof transcription.model === 'string' ? transcription.model : null,
      language:
        typeof transcription.language === 'string'
          ? transcription.language
          : null,
      languages: Array.isArray(transcription.languages)
        ? transcription.languages.filter(
            (language: unknown) => typeof language === 'string',
          )
        : null,
      transcriptionDelay:
        typeof transcription.delay === 'string' ? transcription.delay : null,
      serverTurnDetectionDisabled:
        input.turn_detection === null || session.turn_detection === null,
      modalities: session.output_modalities || session.modalities || null,
      inputFormat: input.format || session.input_audio_format || null,
      turnDetection: {
        type: vad.type,
        threshold: vad.threshold,
        prefixPaddingMs: vad.prefix_padding_ms,
        silenceDurationMs: vad.silence_duration_ms,
      },
    };
  }
  const keep = new Set([
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'input_audio_buffer.cleared',
    'conversation.item.input_audio_transcription.completed',
    'conversation.item.input_audio_transcription.failed',
    'response.done',
    'response.audio.delta',
    'response.output_audio.delta',
    'error',
  ]);
  if (!keep.has(event.type)) return null;
  return {
    type: event.type,
    itemId: typeof event.item_id === 'string' ? event.item_id : null,
    previousItemId:
      typeof event.previous_item_id === 'string'
        ? event.previous_item_id
        : null,
    audioStartMs: Number.isFinite(event.audio_start_ms)
      ? event.audio_start_ms
      : null,
    audioEndMs: Number.isFinite(event.audio_end_ms) ? event.audio_end_ms : null,
    responseId:
      typeof event.response?.id === 'string' ? event.response.id : null,
    status:
      typeof event.response?.status === 'string' ? event.response.status : null,
    incompleteReason: [
      'max_output_tokens',
      'content_filter',
      'client_cancelled',
      'turn_detected',
    ].includes(event.response?.status_details?.reason)
      ? event.response.status_details.reason
      : null,
  };
}

export async function runCaptionReplay(
  fixture: CaptionFixture,
  credentials: { apiKey: string; proxyUrl?: string },
  dependencies: {
    createClient: (options: ClientOptions) => CaptionClient;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    socketFactory?: (
      url: string,
      options: WebSocket.ClientOptions,
    ) => WebSocket;
  },
) {
  const clock = dependencies.now || (() => performance.now());
  const sleep = dependencies.sleep || delay;
  const started = clock();
  const startedAt = new Date().toISOString();
  const now = () => Math.round((clock() - started) * 10) / 10;
  const source = Buffer.concat([
    Buffer.alloc(PREFIX_BYTES, 255),
    fixture.input,
    Buffer.alloc(SUFFIX_BYTES, 255),
  ]);
  const converter = new PcmuToPcm24k();
  const transcripts: CaptionTimelineEvent[] = [];
  const protocol: (Record<string, unknown> & {
    atMs: number;
    connection: number;
  })[] = [];
  const frames: {
    atMs: number;
    targetAtMs: number;
    bytes: number;
    offset: number;
  }[] = [];
  const errors: { atMs: number; code: string }[] = [];
  const sentHash = createHash('sha256');
  const pcmHash = createHash('sha256');
  let failure: string | null = null;
  let client: CaptionClient | undefined;
  let readyAtMs: number | null = null;
  let finishStartedAtMs: number | null = null;
  let finishResolvedAtMs: number | null = null;
  let sentBytes = 0;
  let pcmBytes = 0;
  let connectionCount = 0;
  const fail = (code: string) => {
    failure ||= safeCode(code);
    if (errors.length < 50) errors.push({ atMs: now(), code: safeCode(code) });
  };
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  deadline.catch(() => {});
  const hardLimit = setTimeout(() => {
    fail('HARD_LIMIT_90_SECONDS');
    rejectDeadline(new Error('HARD_LIMIT_90_SECONDS'));
    client?.abort();
  }, MAX_RUN_MS);
  try {
    client = dependencies.createClient({
      ...credentials,
      onTranscript: (event) => {
        if (
          transcripts.length >= MAX_EVENTS ||
          typeof event.text !== 'string' ||
          event.text.length > 8000
        ) {
          fail('CAPTION_EVENT_LIMIT');
          return;
        }
        if (
          event.role !== 'remote' ||
          !['original', 'translation'].includes(event.kind)
        ) {
          fail('UNEXPECTED_CAPTION_ROLE_OR_KIND');
          return;
        }
        transcripts.push({ ...event, atMs: now() });
      },
      onError: fail,
      createWebSocket: (url, options) => {
        const socket = (
          dependencies.socketFactory ||
          ((address, settings) => new WebSocket(address, settings))
        )(url, options);
        const connection = ++connectionCount;
        // Timestamp send attempts without retaining prompts or audio. A send
        // timestamp is not proof of network delivery or provider acceptance.
        const originalSend = socket.send?.bind(socket);
        if (originalSend) {
          socket.send = ((raw: any, ...sendArgs: any[]) => {
            try {
              if (typeof raw === 'string' && raw.length < 1024 * 1024) {
                const event = JSON.parse(raw);
                if (
                  [
                    'input_audio_buffer.commit',
                    'response.create',
                    'response.cancel',
                  ].includes(event.type)
                ) {
                  if (protocol.length >= MAX_EVENTS)
                    fail('PROTOCOL_EVENT_LIMIT');
                  else
                    protocol.push({
                      type: `client.${event.type}`,
                      atMs: now(),
                      connection,
                      eventId:
                        typeof event.event_id === 'string'
                          ? event.event_id
                          : null,
                      responseId:
                        typeof event.response_id === 'string'
                          ? event.response_id
                          : null,
                      scope: 'send_attempt_not_delivery_ack',
                    });
                }
              }
            } catch {
              /* Record only valid locally constructed protocol metadata. */
            }
            return (originalSend as (...args: any[]) => void)(raw, ...sendArgs);
          }) as WebSocket['send'];
        }
        socket.on('message', (raw: unknown) => {
          try {
            if (Buffer.byteLength(String(raw)) > 1024 * 1024) return;
            const event = captionProtocolEvidence(JSON.parse(String(raw)));
            if (event && protocol.length < MAX_EVENTS)
              protocol.push({ ...event, atMs: now(), connection });
            else if (event) fail('PROTOCOL_EVENT_LIMIT');
          } catch {
            /* The production client validates provider events. */
          }
        });
        return socket;
      },
    });
    await Promise.race([client.ready, deadline]);
    readyAtMs = now();
    const pacingStart = clock();
    for (let offset = 0; offset < source.length; offset += 160) {
      if (failure) throw new Error(failure);
      const target = pacingStart + offset / 8;
      await sleep(Math.max(0, target - clock()));
      if (clock() - target > 250) throw new Error('INPUT_PACING_STALL');
      const frame = source.subarray(offset, offset + 160);
      const pcm = converter.push(frame);
      const atMs = now();
      client.append(pcm);
      sentHash.update(frame);
      pcmHash.update(pcm);
      sentBytes += frame.length;
      pcmBytes += pcm.length;
      frames.push({
        atMs,
        targetAtMs: target - started,
        bytes: frame.length,
        offset,
      });
    }
    finishStartedAtMs = now();
    await Promise.race([client.finish(), deadline]);
    finishResolvedAtMs = now();
    if (failure) throw new Error(failure);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'CAPTION_REPLAY_FAILED');
  } finally {
    clearTimeout(hardLimit);
    client?.abort();
  }
  const captions = summarizeCaptions(transcripts);
  const inputEnergy = analyzePcmuPlayback(
    source.subarray(0, sentBytes),
    frames,
  );
  const boundaryDiff = (atMs: number | null, boundary: number | null) =>
    atMs === null || boundary === null
      ? null
      : Math.round((atMs - boundary) * 10) / 10;
  const timing = (series: typeof captions.translation) => ({
    firstNonemptyAfterFirstInputEnergyMs: boundaryDiff(
      series.firstNonemptyAtMs,
      inputEnergy.firstEnergyAtMs,
    ),
    firstNonemptyAfterLastInputEnergyMs: boundaryDiff(
      series.firstNonemptyAtMs,
      inputEnergy.lastEnergyAtMs,
    ),
    firstFinalAfterFirstInputEnergyMs: boundaryDiff(
      series.firstFinalAtMs,
      inputEnergy.firstEnergyAtMs,
    ),
    lastFinalAfterLastInputEnergyMs: boundaryDiff(
      series.lastFinalAtMs,
      inputEnergy.lastEnergyAtMs,
    ),
  });
  const incompleteResponses = protocol.filter(
    (event) => event.type === 'response.done' && event.status === 'incomplete',
  );
  const failedResponses = protocol.filter(
    (event) => event.type === 'response.done' && event.status === 'failed',
  );
  const committed = protocol
    .filter((event) => event.type === 'input_audio_buffer.committed')
    .map((event) => event.itemId);
  const transcribed = protocol
    .filter(
      (event) =>
        event.type === 'conversation.item.input_audio_transcription.completed',
    )
    .map((event) => event.itemId);
  const missingObservedFinals = committed.filter(
    (id) => !transcribed.includes(id),
  );
  const emptyOriginal = captions.original.finalItems.length === 0;
  const emptyTranslation = captions.translation.finalItems.length === 0;
  const unexpectedSilenceCaption =
    fixture.kind === 'synthetic_silence' &&
    transcripts.some((event) => event.text.trim());
  if (
    !failure &&
    (incompleteResponses.length ||
      failedResponses.length ||
      missingObservedFinals.length)
  )
    failure = 'INCOMPLETE_PROVIDER_OUTPUT';
  if (
    !failure &&
    fixture.kind === 'human' &&
    (emptyOriginal || emptyTranslation)
  )
    failure = 'EMPTY_FINAL_CAPTION';
  if (
    !failure &&
    (captions.original.unsettledIds.length ||
      captions.translation.unsettledIds.length)
  )
    failure = 'UNSETTLED_CAPTION_ITEMS';
  if (
    !failure &&
    (captions.originalFinalsWithoutTranslation.length ||
      captions.translationFinalsWithoutOriginal.length)
  )
    failure = 'UNPAIRED_FINAL_CAPTION_ITEMS';
  if (
    !failure &&
    protocol.some((event) =>
      ['response.audio.delta', 'response.output_audio.delta'].includes(
        String(event.type),
      ),
    )
  )
    failure = 'UNEXPECTED_GENERATED_AUDIO';
  if (!failure && unexpectedSilenceCaption)
    failure = 'UNEXPECTED_SILENCE_CAPTION';
  if (!failure && (captions.finalRevisions || captions.draftAfterFinal))
    failure = 'FINAL_CAPTION_REVISED';
  return {
    schema: 'caption-route-replay/1',
    id: fixture.id,
    kind: fixture.kind,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: now(),
    realPhone: false,
    realEnvironmentAccepted: false,
    route: credentials.proxyUrl ? 'configured_proxy' : 'direct',
    provenance: fixture.provenance,
    source: {
      format: 'PCMU_8000_mono',
      bytes: fixture.input.length,
      sha256: sha256(fixture.input),
      durationMs: fixture.input.length / 8,
      prefixSilenceMs: PREFIX_BYTES / 8,
      suffixSilenceMs: SUFFIX_BYTES / 8,
      paddedBytes: source.length,
      paddedSha256: sha256(source),
    },
    input: {
      receiver: 'caption_client_append_before_client_vad',
      sentPcmuBytes: sentBytes,
      sentPcmuSha256: sentHash.digest('hex'),
      sourceFullySent: sentBytes === source.length,
      sentPcm24kBytes: pcmBytes,
      sentPcm24kSha256: pcmHash.digest('hex'),
      pacingMs: 20,
      lastFrameMayBeShort: true,
      maxPacingLatenessMs: frames.reduce(
        (max, frame) => Math.max(max, frame.atMs - frame.targetAtMs),
        0,
      ),
      energy: inputEnergy,
      frames,
    },
    lifecycle: {
      readyAtMs,
      finishStartedAtMs,
      finishResolvedAtMs,
      finishResolved: finishResolvedAtMs !== null,
      connectionCount,
    },
    quality: {
      status: failure
        ? 'REPLAY_FAILED_OR_INCOMPLETE'
        : 'REPLAY_COMPLETE_REVIEW_REQUIRED',
      failure,
      emptyOriginal,
      emptyTranslation,
      unexpectedSilenceCaption,
      missingObservedFinals,
      incompleteResponses,
      failedResponses,
      accuracyAccepted: false,
      semanticTailAccepted: false,
      pairedFinalItemCountsEqual:
        captions.original.finalItems.length ===
        captions.translation.finalItems.length,
    },
    captions,
    timing: {
      original: timing(captions.original),
      translation: timing(captions.translation),
    },
    transcripts,
    protocol,
    errors,
    limits: [
      'REAL_PROVIDER_REPLAY_NOT_TWILIO_PHONE_OR_EAR_TIMING',
      'ENERGY_BOUNDARIES_ARE_RMS300_20MS_APPROXIMATIONS_NOT_WORD_ALIGNMENT',
      'DRAFT_TEXT_CAN_CHANGE_AND_IS_NOT_STABLE_TRANSLATION',
      'FIRST_NONEMPTY_IS_NOT_AUTOMATICALLY_FIRST_USEFUL_CAPTION',
      'FINISH_RESOLUTION_AND_OBSERVED_FINALS_DO_NOT_PROVE_SEMANTIC_COMPLETENESS',
      'ACCURACY_AND_TAIL_CONTENT_REQUIRE_REVIEW_AGAINST_AUTHORIZED_SOURCE',
      'NO_GENERATED_AUDIO_OR_PASSTHROUGH_PHONE_LATENCY_MEASURED',
      'INPUT_HASHES_ARE_CLIENT_INPUT_NOT_PROVIDER_VAD_SELECTED_PAYLOAD',
    ],
  };
}

async function main() {
  const plan = prepareCaptionPlan(process.argv.slice(2));
  if (plan.dryRun) {
    console.log(
      JSON.stringify({
        phase: 'caption_dry_run',
        cases: plan.fixtures.map((item) => ({
          id: item.id,
          kind: item.kind,
          bytes: item.input.length,
          sha256: sha256(item.input),
        })),
        providerOpened: false,
      }),
    );
    return;
  }
  const envPath = resolve(plan.root, '.env');
  if (statSync(envPath).size > 256 * 1024)
    throw new Error('ENV_FILE_TOO_LARGE');
  const cfg = parse(readFileSync(envPath));
  if (!cfg.OPENAI_API_KEY?.trim())
    throw new Error('MISSING_EXISTING_PROJECT_KEY');
  const { createRemoteCaptionClient } = await import(
    '../src/solo/remote-caption-client'
  );
  mkdirSync(dirname(plan.outputRoot), { recursive: true });
  mkdirSync(plan.outputRoot); // Never overwrite a previous run, including failures.
  writeFileSync(
    resolve(plan.outputRoot, 'plan.json'),
    JSON.stringify(
      {
        schema: 'caption-route-replay-plan/1',
        startedAt: new Date().toISOString(),
        cases: plan.fixtures.map(({ id, kind, provenance }) => ({
          id,
          kind,
          provenance,
        })),
        automaticRetries: 0,
        realPhone: false,
        expectedTextSentToProvider: false,
        implementation: [
          'scripts/check-caption-route.ts',
          'src/solo/remote-caption-client.ts',
          'src/solo/translation-pcm.ts',
        ].map((file) => ({
          file,
          sha256: sha256(readFileSync(resolve(plan.root, file))),
        })),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  const summary: Record<string, unknown>[] = [];
  for (const fixture of plan.fixtures) {
    console.log(JSON.stringify({ phase: 'caption_start', id: fixture.id }));
    const result = await runCaptionReplay(
      fixture,
      { apiKey: cfg.OPENAI_API_KEY, proxyUrl: cfg.OPENAI_PROXY_URL || '' },
      { createClient: createRemoteCaptionClient },
    );
    writeFileSync(
      resolve(plan.outputRoot, `${fixture.id}.json`),
      JSON.stringify(result, null, 2),
      { flag: 'wx' },
    );
    const entry = {
      id: fixture.id,
      failure: result.quality.failure,
      status: result.quality.status,
      finishResolved: result.lifecycle.finishResolved,
      originalFinals: result.captions.original.finalItems.length,
      translationFinals: result.captions.translation.finalItems.length,
      timing: result.timing,
    };
    summary.push(entry);
    writeFileSync(
      resolve(plan.outputRoot, 'summary.json'),
      JSON.stringify(
        {
          schema: 'caption-route-replay-summary/1',
          runs: summary,
          plannedRuns: plan.fixtures.length,
          realPhone: false,
          accuracyAccepted: false,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ phase: 'caption_complete', ...entry }));
    if (result.quality.failure) {
      process.exitCode = 1;
      break; // Fail closed; subsequent paid sessions need a reviewed rerun.
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        phase: 'caption_failed',
        failure: safeCode(error instanceof Error ? error.message : error),
        realPhone: false,
      }),
    );
    process.exitCode = 1;
  });
}
