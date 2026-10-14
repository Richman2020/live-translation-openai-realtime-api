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

import type { AliyunPlanBRegion, PlanBUsage } from '../solo/aliyun-planb-types';
import { ALIYUN_AUDITION_LIMITS } from './aliyun-audition-input';
import type { PreparedAliyunAuditionInput } from './aliyun-audition-input';
import type { AliyunAuditionResult } from './aliyun-audition-runner';

export const ALIYUN_AUDITION_PUBLIC_RATES = Object.freeze({
  currency: 'CNY',
  checkedAt: '2026-10-14',
  source: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  beijing: Object.freeze({
    asrPerSecond: 0.00033,
    translationInputPerMillion: 0.7,
    translationOutputPerMillion: 1.95,
    ttsPerTenThousandCharacters: 1,
  }),
  singapore: Object.freeze({
    asrPerSecond: 0.00066,
    translationInputPerMillion: 1.174,
    translationOutputPerMillion: 3.596,
    ttsPerTenThousandCharacters: 0.9541,
  }),
});

function fail(code: string): never {
  throw new Error(`ALIYUN_AUDITION_ARTIFACT_${code}`);
}

/** Token input is a planning reserve, never represented as a provider limit. */
export function estimateAliyunAuditionCost(region: AliyunPlanBRegion) {
  const rates = ALIYUN_AUDITION_PUBLIC_RATES[region];
  const inputTokenReservation = 200000;
  const asrCny = ALIYUN_AUDITION_LIMITS.inputSeconds * rates.asrPerSecond;
  const translationInputCny =
    (inputTokenReservation * rates.translationInputPerMillion) / 1e6;
  const translationOutputCny =
    (ALIYUN_AUDITION_LIMITS.translationRequests *
      ALIYUN_AUDITION_LIMITS.translationMaxTokens *
      rates.translationOutputPerMillion) /
    1e6;
  const ttsCny =
    (ALIYUN_AUDITION_LIMITS.ttsCharacters * rates.ttsPerTenThousandCharacters) /
    10000;
  const estimatedCny =
    asrCny + translationInputCny + translationOutputCny + ttsCny;
  return {
    currency: 'CNY',
    region,
    rates: ALIYUN_AUDITION_PUBLIC_RATES,
    estimate: {
      asrCny,
      translationInputCny,
      translationOutputCny,
      ttsCny,
      estimatedCny,
      recommendedApprovalCny: 1,
      marginCny: 1 - estimatedCny,
    },
    locallyControlled: {
      ...ALIYUN_AUDITION_LIMITS,
      automaticRetries: 0,
      automaticReconnects: 0,
    },
    estimatesOnly: {
      translationInputTokens: inputTokenReservation,
      includes:
        'Repeated per-request instructions, current source text and bounded prior raw context; repeated requests are charged separately. No prior audio is resubmitted as context.',
      excludes: 'Account-specific surcharges or pricing changes not verified.',
    },
    isBillingHardCap: false,
    note: 'Local request/audio/character limits and max_tokens reduce exposure; token reserve, saved output duration and CNY estimate cannot cap supplier billing. Generated but discarded or unplayed output may still be billed.',
  };
}

function validCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Task counters are cumulative; retain their maximum, never sum repeats. */
export function calculateAliyunAuditionCost(
  usage: readonly (PlanBUsage & { clipId?: string })[],
  region: AliyunPlanBRegion,
) {
  const rates = ALIYUN_AUDITION_PUBLIC_RATES[region];
  const tasks = new Map<string, PlanBUsage & { clipId?: string }>();
  for (const item of usage) {
    if (item.region !== region) fail('USAGE_REGION_MISMATCH');
    const key = `${item.clipId ?? ''}:${item.layer}:${item.role}:${item.taskSequence}`;
    const old = tasks.get(key);
    const maximum = (left?: number, right?: number) => {
      const values = [left, right].filter(validCount);
      return values.length ? Math.max(...values) : undefined;
    };
    tasks.set(key, {
      ...item,
      basis:
        old?.basis === 'provider_reported' || item.basis === 'provider_reported'
          ? 'provider_reported'
          : 'unknown',
      durationSeconds: maximum(old?.durationSeconds, item.durationSeconds),
      inputTokens: maximum(old?.inputTokens, item.inputTokens),
      outputTokens: maximum(old?.outputTokens, item.outputTokens),
      characters: maximum(old?.characters, item.characters),
    });
  }
  const entries = [...tasks.values()].map((item) => {
    let calculatedCny: number | null = null;
    if (item.basis === 'provider_reported') {
      if (item.layer === 'asr' && validCount(item.durationSeconds))
        calculatedCny = item.durationSeconds * rates.asrPerSecond;
      if (
        item.layer === 'translation' &&
        validCount(item.inputTokens) &&
        validCount(item.outputTokens)
      )
        calculatedCny =
          (item.inputTokens * rates.translationInputPerMillion +
            item.outputTokens * rates.translationOutputPerMillion) /
          1e6;
      if (item.layer === 'tts' && validCount(item.characters))
        calculatedCny =
          (item.characters * rates.ttsPerTenThousandCharacters) / 10000;
    }
    return {
      ...item,
      calculatedCny,
      status:
        calculatedCny === null ? 'usage_pending' : 'provider_usage_times_rate',
    };
  });
  const allReportedUsagePriced =
    entries.length > 0 &&
    entries.every((entry) => entry.calculatedCny !== null);
  return {
    currency: 'CNY',
    rates: ALIYUN_AUDITION_PUBLIC_RATES,
    entries,
    knownSubtotalCny: entries.reduce(
      (sum, entry) => sum + (entry.calculatedCny ?? 0),
      0,
    ),
    allReportedUsagePriced,
    actualPlatformBilledCny: null,
    actualPlatformBilledStatus: 'not_verified',
    note: 'Missing usage is not zero. Priced returned counters do not prove all tasks were reported, nor constitute the verified account bill.',
  };
}

export function aliyunAuditionWave(pcm: Buffer): Buffer {
  if (
    !Buffer.isBuffer(pcm) ||
    pcm.length % 2 ||
    pcm.length > ALIYUN_AUDITION_LIMITS.outputSeconds * 48000
  )
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

export function assertAliyunAuditionPath(path: string): void {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  for (const component of absolute.slice(root.length).split(sep)) {
    if (component) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    }
  }
}

export type AliyunAuditionOutputReservation = Readonly<{ output: string }>;
const reservations = new WeakMap<
  AliyunAuditionOutputReservation,
  { dev: number; ino: number; consumed: boolean }
>();

function writeExclusive(path: string, data: Buffer | string) {
  const descriptor = openSync(
    path,
    // eslint-disable-next-line no-bitwise -- Exclusive regular file creation, no symlink following.
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) fail('REGULAR_FILE_REQUIRED');
    writeFileSync(descriptor, data);
  } finally {
    closeSync(descriptor);
  }
}

export function reserveAliyunAuditionOutput(
  requested: string,
): AliyunAuditionOutputReservation {
  const output = resolve(requested);
  assertAliyunAuditionPath(dirname(output));
  mkdirSync(output, { recursive: false, mode: 0o700 });
  assertAliyunAuditionPath(output);
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== 0o700)
    fail('PRIVATE_DIRECTORY_REQUIRED');
  writeExclusive(
    join(output, 'reservation.json'),
    '{"version":1,"status":"reserved_before_paid_action"}\n',
  );
  const reservation = Object.freeze({ output });
  reservations.set(reservation, {
    dev: stat.dev,
    ino: stat.ino,
    consumed: false,
  });
  return reservation;
}

export function writeAliyunAuditionArtifacts(
  input: PreparedAliyunAuditionInput,
  result: AliyunAuditionResult,
  reservation: AliyunAuditionOutputReservation,
) {
  const record = reservations.get(reservation);
  const { output } = reservation;
  const check = () => {
    assertAliyunAuditionPath(output);
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
  if (!record || record.consumed) fail('INVALID_RESERVATION');
  check();
  const files = readdirSync(output);
  if (files.length !== 1 || files[0] !== 'reservation.json')
    fail('RESERVATION_NOT_EMPTY');
  const totalOutputBytes = result.segments.reduce(
    (sum, segment) => sum + segment.pcm.length,
    0,
  );
  if (totalOutputBytes > ALIYUN_AUDITION_LIMITS.outputSeconds * 48000)
    fail('OUTPUT_EXCEEDS_36_SECONDS');
  record.consumed = true;
  const hashes: { file: string; sha256: string; bytes: number }[] = [];
  const write = (file: string, data: Buffer | string) => {
    check();
    writeExclusive(join(output, file), data);
    hashes.push({
      file,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: Buffer.byteLength(data),
    });
  };
  const segments = result.segments.map((segment, index) => {
    const { pcm, ...details } = segment;
    const outputFile =
      segment.role === 'local' && pcm.length
        ? `english-${String(index + 1).padStart(2, '0')}.wav`
        : null;
    if (segment.role === 'remote' && pcm.length) fail('REMOTE_TTS_FORBIDDEN');
    if (outputFile) write(outputFile, aliyunAuditionWave(pcm));
    return { ...details, outputFile, savedOutputSeconds: pcm.length / 48000 };
  });
  const combined = Buffer.concat(
    result.segments
      .filter((segment) => segment.role === 'local')
      .map((segment) => segment.pcm),
  );
  if (combined.length)
    write('english-combined.wav', aliyunAuditionWave(combined));
  const resultDetails = {
    status: result.status,
    errorCode: result.errorCode ?? null,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    configuration: result.configuration,
    counters: result.counters,
    usage: result.usage,
    evidence: result.evidence,
    clips: result.clips,
  };
  const report = {
    version: 1,
    provider: 'aliyun-plan-b',
    parentCandidate: '108f22b70f327bb7b73cf67577741e711d1b0dc1',
    region: input.region,
    model: {
      asr: 'fun-asr-realtime',
      translation: 'qwen-mt-flash',
      tts: 'cosyvoice-v3-flash',
      voice: 'loongandy_v3',
    },
    input: {
      manifestSha256: input.manifestSha256,
      totalSeconds: input.totalSeconds,
      clips: input.clips.map(
        ({ id, role, durationMs, speechEndMs, sha256 }) => ({
          id,
          role,
          durationMs,
          speechEndMs: speechEndMs ?? null,
          sha256,
        }),
      ),
      referenceAnswers: 'not_read_or_uploaded',
    },
    ...resultDetails,
    segments,
    costs: calculateAliyunAuditionCost(result.usage, input.region),
    planning: estimateAliyunAuditionCost(input.region),
    latencyScope:
      'Source speech end to first generated English PCM includes ASR finalization, translation and TTS; per-layer timings are retained. No headphone/telephone transport timing is claimed. Missing speech-end annotation cannot be replaced with a guessed human speech ending.',
    limitations: [
      'Fixed voice configuration does not prove masculine hearing or audible stability.',
      'No audio is automatically played; English source remains a caption-only translation path.',
      'Generated but discarded/unplayed audio may be billed; no account invoice was read.',
      'A short audition does not establish long-call stability or natural long-speech segmentation.',
    ],
  };
  write('report.json', `${JSON.stringify(report, null, 2)}\n`);
  write('files.sha256.json', `${JSON.stringify(hashes, null, 2)}\n`);
  return { output, files: hashes.map((item) => item.file) };
}
