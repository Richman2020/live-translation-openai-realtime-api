import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';

import {
  LIVETRANSLATE_AUDITION_PARENT,
  LIVETRANSLATE_SINGLE_LOCAL_PARENT,
  liveTranslateAuditionLimits,
  type PreparedLiveTranslateAuditionInput,
} from './livetranslate-audition-input';
import type { LiveTranslateAuditionResult } from './livetranslate-audition-runner';
import type { LiveTranslateUsage } from './livetranslate-types';
import { describeLiveTranslateProtocolEvidence } from './livetranslate-protocol-evidence';

export const LIVETRANSLATE_PUBLIC_RATES = Object.freeze({
  currency: 'CNY',
  region: 'beijing',
  checkedAt: '2026-10-15T12:46:00+08:00',
  modelSource:
    'https://help.aliyun.com/zh/model-studio/qwen3-8-livetranslate-flash-realtime',
  priceSource: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  audioInputPerMillion: 40,
  textOutputPerMillion: 100,
  audioOutputPerMillion: 160,
  textInputPerMillion: null,
  sourceTranscription: 'documented_free',
});
export function estimateLiveTranslateAuditionCost(
  input?: Pick<PreparedLiveTranslateAuditionInput, 'mode' | 'totalSeconds'>,
) {
  const mode = input?.mode ?? 'dual';
  const limits = liveTranslateAuditionLimits(mode);
  const inputSeconds = input?.totalSeconds ?? 24;
  if (!Number.isFinite(inputSeconds) || inputSeconds <= 0 || inputSeconds > 24)
    throw new Error('LIVETRANSLATE_AUDITION_ARTIFACT_ESTIMATE_INPUT_INVALID');
  const expected = {
    inputAudioTokens: inputSeconds * 7,
    outputAudioTokens: limits.savedOutputSeconds * 12.5,
    outputTextTokenReserve: mode === 'single-local' ? 1024 : 2048,
  };
  const expectedCny =
    (expected.inputAudioTokens * 40) / 1e6 +
    (expected.outputAudioTokens * 160) / 1e6 +
    (expected.outputTextTokenReserve * 100) / 1e6;
  const outputPlanningTokens = limits.acceptedResponses * 4096;
  const repeatedInputAudioTokens = inputSeconds * 7 * limits.acceptedResponses;
  const observationReserveCny =
    (outputPlanningTokens * 160) / 1e6 + (repeatedInputAudioTokens * 40) / 1e6;
  const recommendedApprovalCny = 5;
  return {
    rates: LIVETRANSLATE_PUBLIC_RATES,
    assumptions: {
      mode,
      sessions: limits.sessions,
      actualInputSeconds: inputSeconds,
      savedOutputSecondsPlanning: limits.savedOutputSeconds,
      acceptedResponsesObservation: limits.acceptedResponses,
    },
    expected: { ...expected, estimatedCny: expectedCny },
    planningReserve: {
      outputTokens: outputPlanningTokens,
      repeatedInputAudioTokens,
      estimatedCny: observationReserveCny,
      recommendedApprovalCny,
      marginCny: recommendedApprovalCny - observationReserveCny,
    },
    localStops: limits,
    legacyDual24SecondExample: {
      mode: 'dual',
      inputSeconds: 24,
      sessions: 2,
      estimatedCny: 0.28352,
      note: 'Historical two-direction planning example only; not the cost estimate for a supplied single-local file.',
    },
    unknown: [
      'Input-text/history billing mechanism and input-text rate are not established.',
      'Response count and saved output seconds are local observations; further generation before closure may be billed.',
      '4096 model-page output capacity is only a planning assumption, not a supported client parameter or a verified cross-modality maximum.',
      'Prices and account access need current authorized verification before execution.',
    ],
    isBillingHardCap: false,
    comparison:
      'pending matching baseline receipt; never rerun the old three-stage pipeline automatically',
  };
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function calculateLiveTranslateAuditionCost(
  usage: readonly LiveTranslateUsage[],
) {
  const responses = new Map<string, LiveTranslateUsage>();
  for (const item of usage) {
    const key = `${item.role}:${item.sessionId}:${item.responseId}`;
    const old = responses.get(key);
    const snapshot = { ...item };
    for (const field of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'inputAudioTokens',
      'inputTextTokens',
      'outputAudioTokens',
      'outputTextTokens',
    ] as const) {
      const values = [old?.[field], item[field]].filter(count);
      if (values.length) snapshot[field] = Math.max(...values);
    }
    responses.set(key, snapshot);
  }
  const entries = [...responses.values()].map((item) => {
    const priced = item.basis === 'provider_reported';
    const audioInputCny =
      priced && count(item.inputAudioTokens)
        ? (item.inputAudioTokens * 40) / 1e6
        : null;
    const audioOutputCny =
      priced && count(item.outputAudioTokens)
        ? (item.outputAudioTokens * 160) / 1e6
        : null;
    const textOutputCny =
      priced && count(item.outputTextTokens)
        ? (item.outputTextTokens * 100) / 1e6
        : null;
    const textInputCny = priced && item.inputTextTokens === 0 ? 0 : null;
    return {
      ...item,
      audioInputCny,
      audioOutputCny,
      textOutputCny,
      textInputCny,
      allReportedUsagePriced: [
        audioInputCny,
        audioOutputCny,
        textOutputCny,
        textInputCny,
      ].every((value) => value !== null),
    };
  });
  return {
    currency: 'CNY',
    rates: LIVETRANSLATE_PUBLIC_RATES,
    entries,
    knownSubtotalCny: entries.some(
      (item) =>
        item.audioInputCny !== null ||
        item.audioOutputCny !== null ||
        item.textOutputCny !== null,
    )
      ? entries.reduce(
          (sum, item) =>
            sum +
            (item.audioInputCny ?? 0) +
            (item.audioOutputCny ?? 0) +
            (item.textOutputCny ?? 0),
          0,
        )
      : null,
    allReportedUsagePriced:
      entries.length > 0 &&
      entries.every((item) => item.allReportedUsagePriced),
    actualPlatformBilledCny: null,
    actualPlatformBilledStatus: 'not_verified',
    note: 'Unknown counters or unlisted input-text prices are not zero. Returned usage may omit failed, late or discarded generation. This is not a verified invoice.',
  };
}
function fail(code: string): never {
  throw new Error(`LIVETRANSLATE_AUDITION_ARTIFACT_${code}`);
}
export function assertLiveTranslateAuditionPath(path: string) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
  }
}
function writeExclusive(path: string, bytes: Buffer | string) {
  const fd = openSync(
    path,
    // eslint-disable-next-line no-bitwise -- Exclusive no-follow private files.
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) fail('REGULAR_FILE_REQUIRED');
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
export type LiveTranslateAuditionReservation = Readonly<{ output: string }>;
const reservations = new WeakMap<
  LiveTranslateAuditionReservation,
  { dev: number; ino: number; consumed: boolean }
>();
export function reserveLiveTranslateAuditionOutput(
  path: string,
): LiveTranslateAuditionReservation {
  const output = resolve(path);
  assertLiveTranslateAuditionPath(dirname(output));
  mkdirSync(output, { mode: 0o700 });
  assertLiveTranslateAuditionPath(output);
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== 0o700)
    fail('PRIVATE_DIRECTORY_REQUIRED');
  writeExclusive(
    join(output, 'reservation.json'),
    '{"version":1,"status":"reserved_before_supplier_action"}\n',
  );
  const reservation = Object.freeze({ output });
  reservations.set(reservation, {
    dev: stat.dev,
    ino: stat.ino,
    consumed: false,
  });
  return reservation;
}
export function liveTranslateAuditionWave(pcm: Buffer): Buffer {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > 36 * 48000)
    fail('INVALID_PCM');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function writeLiveTranslateAuditionArtifacts(
  input: PreparedLiveTranslateAuditionInput,
  result: LiveTranslateAuditionResult,
  reservation: LiveTranslateAuditionReservation,
) {
  const record = reservations.get(reservation);
  const { output } = reservation;
  const check = () => {
    assertLiveTranslateAuditionPath(output);
    const stat = lstatSync(output);
    if (
      !record ||
      stat.dev !== record.dev ||
      stat.ino !== record.ino ||
      !stat.isDirectory() ||
      stat.mode % 0o1000 !== 0o700
    )
      fail('RESERVATION_CHANGED');
  };
  if (!record || record.consumed) fail('RESERVATION_INVALID');
  check();
  if (readdirSync(output).join(',') !== 'reservation.json')
    fail('RESERVATION_NOT_EMPTY');
  if (
    result.audio.reduce((sum, audio) => sum + audio.pcm.length, 0) >
    36 * 48000
  )
    fail('OUTPUT_LIMIT');
  record.consumed = true;
  const files: { file: string; sha256: string; bytes: number }[] = [];
  const write = (file: string, data: Buffer | string) => {
    check();
    writeExclusive(join(output, file), data);
    files.push({
      file,
      bytes: Buffer.byteLength(data),
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  };
  const audio = result.audio.map((item, index) => {
    if (item.metadata.role !== 'local') fail('REMOTE_AUDIO_FORBIDDEN');
    const { pcm, ...detail } = item;
    const outputFile = `english-${String(index + 1).padStart(2, '0')}.wav`;
    write(outputFile, liveTranslateAuditionWave(pcm));
    const source = item.metadata.sourceId
      ? result.sources
          .filter(
            (event) =>
              event.clipId === item.clipId &&
              event.sourceId === item.metadata.sourceId &&
              event.final,
          )
          .at(-1)
      : undefined;
    const textDone = result.timing
      .filter(
        (event) =>
          event.clipId === item.clipId &&
          event.responseId === item.metadata.responseId &&
          event.translationId === item.metadata.translationId &&
          event.stage === 'translation_completed',
      )
      .at(-1);
    const clipTiming = result.clips.find((clip) => clip.id === item.clipId);
    const providerEndEstimateAt =
      source?.endMs === undefined ||
      clipTiming?.sendStartedAt === null ||
      clipTiming?.sendStartedAt === undefined
        ? null
        : clipTiming.sendStartedAt + source.endMs;
    return {
      ...detail,
      outputFile,
      savedOutputSeconds: pcm.length / 48000,
      sourceFinalAt: source?.receivedAt ?? null,
      fullTranslationDoneAt: textDone?.at ?? null,
      providerEndEstimateAt,
      sourceEndBasis:
        providerEndEstimateAt === null
          ? 'unknown'
          : 'provider_stream_estimate_from_sent_audio_origin',
      providerEndToFirstPcmMs:
        providerEndEstimateAt === null || item.firstPcmAt === null
          ? null
          : item.firstPcmAt - providerEndEstimateAt,
      sourceFinalToFirstPcmMs:
        source && item.firstPcmAt !== null
          ? item.firstPcmAt - source.receivedAt
          : null,
      timingNote:
        'Integrated model events may overlap: a first audio sample may precede source/text final. These are observed intervals, not separate ASR/MT/TTS service timings. firstPcmAt comes only from the bound client receive event before FIFO delivery; missing receive timing leaves model/endpoint intervals null. clientFifoWaitMs separates receive from delivery. collectedQueueAt is local artifact collection, never a headset playback start.',
    };
  });
  const combined = Buffer.concat(result.audio.map((item) => item.pcm));
  if (combined.length)
    write('english-combined.wav', liveTranslateAuditionWave(combined));
  write(
    'report.json',
    `${JSON.stringify({ version: 1, parentCandidate: input.mode === 'single-local' ? LIVETRANSLATE_SINGLE_LOCAL_PARENT : LIVETRANSLATE_AUDITION_PARENT, provider: 'aliyun-livetranslate-independent-prototype', input: { mode: input.mode ?? 'dual', manifestSha256: input.manifestSha256, workspaceId: input.workspaceId, spaceHost: input.spaceHost, totalSeconds: input.totalSeconds, clips: input.clips.map(({ id, role, durationMs, sha256, speechEndMs }) => ({ id, role, durationMs, sha256, speechEndMs: speechEndMs ?? null })), referenceAnswers: 'not_read_or_uploaded' }, ...result, configurationBasis: 'requested_not_provider_ack', requestedConfiguration: result.configuration, actualEffectiveConfigurations: result.confirmedSessions, protocolEvidence: describeLiveTranslateProtocolEvidence(result), audio, audioCollectionCompletedAt: result.endedAt, audioCollectionTimeBasis: 'runner_monotonic_fence_closed', audioFilesSavedCompletedAtEpochMs: Date.now(), audioFileWriteBasis: 'synchronous_write_returned_not_fsync_or_playback', costs: calculateLiveTranslateAuditionCost(result.usage), planning: estimateLiveTranslateAuditionCost(input), actualPlaybackStart: 'unknown_no_automatic_playback', comparison: 'pending matching baseline receipt; no latency improvement claim without identical sample hashes and speech-end basis' }, null, 2)}\n`,
  );
  write('files.sha256.json', `${JSON.stringify(files, null, 2)}\n`);
  return { output, files: files.map((item) => item.file) };
}
