import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';

import type { PreparedAuditionInput } from './realtime-audition-input';
import type { RealtimeAuditionResult } from './realtime-audition-runner';
import type {
  AuditionTransportSnapshot,
  AuditionUsage,
} from './realtime-audition-transport';

const MAX_OUTPUT_BYTES = 36 * 24000 * 2;
export const AUDITION_PUBLIC_RATES = {
  basis: 'official_public_rates_transferred_by_user_from_dot',
  verifiedAt: '2026-10-14T09:43:00+08:00',
  realtimeModelUrl:
    'https://developers.openai.com/api/docs/models/gpt-realtime-2.1',
  pricingUrl: 'https://developers.openai.com/api/docs/pricing',
  usdPerMillionTokens: {
    realtimeAudioInput: 32,
    realtimeCachedAudioInput: 0.4,
    realtimeTextInput: 4,
    realtimeCachedTextInput: 0.4,
    realtimeAudioOutput: 64,
    realtimeTextOutput: 24,
    transcriptionInputTableEntry: 2.5,
    transcriptionOutputTableEntry: 10,
  },
  transcriptionEstimatedUsdPerMinute: 0.006,
} as const;

function fail(code: string): never {
  throw new Error(`AUDITION_ARTIFACT_${code}`);
}

function count(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Unknown categories remain unknown; totals and their details are never added twice. */
export function calculateAuditionUsageCost(usage: AuditionUsage[]) {
  const entries = usage.map((item) => {
    if (item.source === 'transcription') {
      if (
        item.basis === 'duration' &&
        typeof item.seconds === 'number' &&
        Number.isFinite(item.seconds) &&
        item.seconds >= 0
      )
        return {
          source: item.source,
          sequence: item.sequence,
          basis: 'official_duration_estimate_only',
          calculatedUsd: null,
          estimatedUsd:
            (item.seconds / 60) *
            AUDITION_PUBLIC_RATES.transcriptionEstimatedUsdPerMinute,
          unknown: [
            'token-category-specific transcription rate/usage',
            'platform billed amount',
          ],
        };
      // The supplied table entries do not prove an ASR audio-input category
      // rate. Preserve usage without assigning that category a guessed price.
      return {
        source: item.source,
        sequence: item.sequence,
        basis: 'usage_retained_rate_mapping_pending',
        calculatedUsd: null,
        estimatedUsd: null,
        unknown: [
          'token-category-specific transcription rate/usage',
          'platform billed amount',
        ],
      };
    }
    const {
      inputTokens,
      outputTokens,
      audioInputTokens,
      textInputTokens,
      audioOutputTokens,
      textOutputTokens,
      cachedInputTokens,
    } = item;
    let cachedAudio = item.cachedAudioInputTokens;
    let cachedText = item.cachedTextInputTokens;
    if (cachedInputTokens === 0) {
      cachedAudio = 0;
      cachedText = 0;
    }
    const known =
      item.basis === 'tokens' &&
      count(inputTokens) &&
      count(outputTokens) &&
      count(audioInputTokens) &&
      count(textInputTokens) &&
      count(audioOutputTokens) &&
      count(textOutputTokens) &&
      count(cachedInputTokens) &&
      count(cachedAudio) &&
      count(cachedText) &&
      audioInputTokens + textInputTokens === inputTokens &&
      audioOutputTokens + textOutputTokens === outputTokens &&
      cachedAudio + cachedText === cachedInputTokens &&
      cachedAudio <= audioInputTokens &&
      cachedText <= textInputTokens;
    return {
      source: item.source,
      sequence: item.sequence,
      basis: known ? 'provider_usage_times_public_rate' : 'incomplete_usage',
      calculatedUsd: known
        ? ((audioInputTokens! - cachedAudio!) * 32 +
            cachedAudio! * 0.4 +
            (textInputTokens! - cachedText!) * 4 +
            cachedText! * 0.4 +
            audioOutputTokens! * 64 +
            textOutputTokens! * 24) /
          1e6
        : null,
      estimatedUsd: null,
      unknown: known
        ? ['platform billed amount']
        : [
            'complete audio/text/cache token breakdown',
            'platform billed amount',
          ],
    };
  });
  const knownSubtotalUsd = entries.reduce(
    (sum, entry) => sum + (entry.calculatedUsd ?? 0),
    0,
  );
  return {
    rates: AUDITION_PUBLIC_RATES,
    entries,
    knownSubtotalUsd,
    allUsagePriced:
      entries.length > 0 &&
      entries.every((entry) => entry.calculatedUsd !== null),
    totalCalculatedUsd:
      entries.length > 0 &&
      entries.every((entry) => entry.calculatedUsd !== null)
        ? knownSubtotalUsd
        : null,
    actualPlatformBilledUsd: null,
    actualPlatformBilledStatus: 'not_verified',
    note: 'Calculated usage is not a verified billed charge. Missing usage is not zero.',
  };
}

/** Count actual request bytes, while retaining token reservations as estimates. */
export function auditionAccountingReview(
  accounting: AuditionTransportSnapshot,
) {
  const requestTextBytes = accounting.requestAccounting.reduce(
    (sum, request) => sum + request.inputTextBytes,
    0,
  );
  const repeatedInstructionBytes = accounting.requestAccounting.reduce(
    (sum, request) => sum + request.instructionBytes,
    0,
  );
  const priorAudioResubmittedBytes = accounting.requestAccounting.reduce(
    (sum, request) => sum + request.priorAudioBytes,
    0,
  );
  const inlineAudioBytes = accounting.requestAccounting.reduce(
    (sum, request) => sum + request.audioBytes,
    0,
  );
  return {
    measuredLocalBytes: {
      sessionInstructionBytes: accounting.sessionInstructionBytes,
      requestTextBytes,
      repeatedInstructionBytes,
      asrPromptBytesPerCommit: accounting.asrPromptBytes,
      repeatedAsrPromptBytes: accounting.asrPromptBytes * accounting.commits,
      bufferAudioBytes: accounting.appendBytes,
      inlineAudioBytes,
      priorAudioResubmittedBytes,
      combinedBufferAndInlineAudioSeconds:
        (accounting.appendBytes + inlineAudioBytes) / (24000 * 2),
    },
    contextStrategy:
      'OOB conversation:none; each request contains current audio and bounded current/prior raw text, not previous response audio or the default conversation history. The same current PCM is submitted to the ASR buffer and explicitly to the response; billing duplication remains possible.',
    estimateReservations: {
      realtimeAudioInputTokens: 2048,
      realtimeTextInputTokens: 49152,
      realtimeOutputTokens: 3072,
      auxiliaryAsrUsd: 0.04,
      plannedUsd: 0.498752,
      suggestedApprovalUsd: 1,
      marginUsd: 0.501248,
      tokenReservationsAreProviderLimits: false,
      usdIsHardCap: false,
    },
    controlledBounds: {
      inputAudioSeconds: 24,
      sourceCommits: 6,
      responseRequests: 6,
      outputTokensPerResponse: 512,
      savedOutputSeconds: 36,
      automaticRetries: 0,
      automaticReconnects: 0,
      sessionCapConfirmed: accounting.sessionCapConfirmed,
      responseCapConfirmed: accounting.responseCapConfirmed,
    },
    note: 'Byte counts are not measured tokens. The USD 1 proposal is still a planning amount under standard public pricing, not a billing cap. Session framing, instructions, ASR, duplicated audio, generated-but-unplayed output and missing usage must be retained.',
  };
}

export function auditionWave(pcm: Buffer): Buffer {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > MAX_OUTPUT_BYTES)
    fail('INVALID_PCM');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function noSymlinks(path: string): void {
  const { root } = parse(path);
  let current = root;
  for (const component of path.slice(root.length).split(sep)) {
    if (component) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    }
  }
}

export type AuditionOutputReservation = Readonly<{ output: string }>;
const reservations = new WeakMap<
  AuditionOutputReservation,
  { dev: number; ino: number; consumed: boolean }
>();
const RESERVATION_FILE = 'reservation.json';
const RESERVATION_CONTENT =
  '{"version":1,"status":"reserved_before_credentials_and_model_connection"}\n';

/** Reserve a writable, private, new result destination before any paid action. */
export function reserveAuditionOutput(
  requestedOutput: string,
): AuditionOutputReservation {
  const output = resolve(requestedOutput);
  noSymlinks(dirname(output));
  mkdirSync(output, { recursive: false, mode: 0o700 });
  noSymlinks(output);
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== 0o700)
    fail('PRIVATE_DIRECTORY_REQUIRED');
  // A real exclusive file creation also checks writability before a model call.
  writeFileSync(join(output, RESERVATION_FILE), RESERVATION_CONTENT, {
    flag: 'wx',
    mode: 0o600,
  });
  const reservation = Object.freeze({ output });
  reservations.set(reservation, {
    dev: stat.dev,
    ino: stat.ino,
    consumed: false,
  });
  return reservation;
}

function assertReservation(
  output: string,
  reservation: AuditionOutputReservation,
) {
  const record = reservations.get(reservation);
  if (!record || record.consumed || reservation.output !== output)
    fail('INVALID_RESERVATION');
  noSymlinks(output);
  const stat = lstatSync(output);
  if (
    !stat.isDirectory() ||
    stat.dev !== record.dev ||
    stat.ino !== record.ino ||
    stat.mode % 0o1000 !== 0o700
  )
    fail('RESERVATION_CHANGED');
  return record;
}

/** Called only after a future explicitly approved run; never captures input audio. */
export function writeAuditionArtifacts(
  requestedOutput: string,
  input: PreparedAuditionInput,
  result: RealtimeAuditionResult,
  reservation?: AuditionOutputReservation,
) {
  const output = resolve(requestedOutput);
  noSymlinks(dirname(output));
  const totalBytes = result.responses.reduce(
    (sum, response) => sum + response.pcm.length,
    0,
  );
  if (totalBytes > MAX_OUTPUT_BYTES) fail('OUTPUT_EXCEEDS_36_SECONDS');
  for (const response of result.responses)
    if (response.pcm.length % 2) fail('INVALID_PCM');
  if (reservation) {
    const record = assertReservation(output, reservation);
    const files = readdirSync(output);
    if (files.length !== 1 || files[0] !== RESERVATION_FILE)
      fail('RESERVATION_NOT_EMPTY');
    record.consumed = true;
  } else mkdirSync(output, { recursive: false, mode: 0o700 });
  const hashes: { file: string; sha256: string; bytes: number }[] = [];
  const write = (file: string, bytes: Buffer | string) => {
    noSymlinks(output);
    if (reservation) {
      const record = reservations.get(reservation)!;
      const stat = lstatSync(output);
      if (stat.dev !== record.dev || stat.ino !== record.ino)
        fail('RESERVATION_CHANGED');
    }
    writeFileSync(join(output, file), bytes, { flag: 'wx', mode: 0o600 });
    hashes.push({
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: Buffer.byteLength(bytes),
    });
  };
  const responses = result.responses.map((response, index) => {
    const file = `response-${String(index + 1).padStart(2, '0')}.wav`;
    write(file, auditionWave(response.pcm));
    return {
      sourceSequence: response.sourceSequence,
      responseId: response.responseId,
      rawAsrText: response.rawAsrText ?? null,
      actualGeneratedTranslation: response.translationText ?? null,
      referenceTranslation: { status: 'not_loaded_by_executor', value: null },
      status: response.status,
      timing: response.timing,
      outputFile: file,
      savedOutputSeconds: response.pcm.length / 48000,
    };
  });
  write(
    'combined.wav',
    auditionWave(
      Buffer.concat(result.responses.map((response) => response.pcm)),
    ),
  );
  const report = {
    version: 1,
    result: {
      status: result.status,
      reason: result.reason ?? null,
      model: result.model,
      voice: result.voice,
      parentCandidate: result.parentCandidate,
    },
    source: {
      wavSha256: input.wavSha256,
      totalSeconds: input.totalSeconds,
      segments: input.segments.map(({ id, sourceText }) => ({
        id,
        suppliedSourceText: sourceText,
      })),
      note: 'Supplied source text, provider ASR and generated translation are separate observations. The executor never reads reference English answers.',
    },
    responses,
    transcripts: result.transcripts,
    corrections: result.corrections,
    counts: result.counts,
    timing: result.timing,
    latencyDefinitions: {
      monotonicOrigin: 'run start',
      inputToOutput:
        'first input energy to first generated output energy; includes segmentation, ASR and queue delay',
      commitToAudio: 'first generated PCM minus source commit',
      requestToAudio: 'first generated PCM minus response request',
      excludes: [
        'headphone playback',
        'human perception',
        'telephone transport',
      ],
    },
    usage: result.usage,
    accounting: auditionAccountingReview(result.accounting),
    costs: calculateAuditionUsageCost(result.usage),
    limitations: [
      'A fixed echo configuration is not evidence of masculine hearing or voice stability.',
      'This short audition cannot establish long-call stability or real telephone latency.',
      'Saved output duration is not a generation, token or dollar hard cap.',
      'Generated but unplayed or discarded audio may still be billed.',
    ],
  };
  write('report.json', `${JSON.stringify(report, null, 2)}\n`);
  write('files.sha256.json', `${JSON.stringify(hashes, null, 2)}\n`);
  return { output, files: hashes.map((item) => item.file) };
}
