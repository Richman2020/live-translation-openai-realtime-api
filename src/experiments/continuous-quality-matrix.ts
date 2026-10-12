/* eslint-disable no-await-in-loop -- One paid session at a time, paced in source order. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createContinuousTranslationClient,
  type ContinuousTranslationOptions,
} from '../solo/continuous-translation-client';
import { analyzePcmuPlayback } from '../solo/translation-audio-measurement';
import {
  muLawToPcm16,
  Pcm24kToPcmu,
  PcmuToPcm24k,
} from '../solo/translation-pcm';

export type QualityCase = {
  id: string;
  role: 'local' | 'remote';
  inputFile: string;
  sourceText: string;
  expectedTranslation: string;
  targetLanguage: 'en' | 'zh';
  kind: 'short' | 'long';
};
export type PreparedQualityCase = QualityCase & {
  input: Buffer;
  inputSha256: string;
};
export type QualityCondition = 'off' | 'near_field';
export type QualityRun = {
  id: string;
  caseId: string;
  repetition: number;
  condition: QualityCondition;
  inputSha256: string;
};
export type QualityPlan = {
  kind: 'synthetic' | 'human';
  cases: PreparedQualityCase[];
  runs: QualityRun[];
  repeat: number;
  outputRoot: string;
};
export type QualityArguments = {
  manifest: string;
  out: string;
  repeat: number;
  caseId?: string;
  dryRun: boolean;
};

const INPUT_LIMIT = 60 * 8000;
const OUTPUT_LIMIT = 120 * 48000;
const PREFIX_BYTES = 300 * 8;
const SUFFIX_BYTES = 4000 * 8;
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

export function parseQualityArguments(args: string[]): QualityArguments {
  const values = new Map<string, string>();
  const names = ['--manifest', '--out', '--repeat', '--case', '--dry-run'];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!names.includes(name) || values.has(name))
      throw new Error('INVALID_ARGUMENTS');
    if (name === '--dry-run') values.set(name, 'true');
    else {
      index += 1;
      const value = args[index];
      if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
      values.set(name, value);
    }
  }
  const repeat = values.get('--repeat') ?? '3';
  if (!/^[1-3]$/.test(repeat)) throw new Error('REPEAT_MUST_BE_1_TO_3');
  if (!values.get('--manifest') || !values.get('--out'))
    throw new Error('REQUIRE_MANIFEST_AND_PRIVATE_OUT');
  return {
    manifest: values.get('--manifest')!,
    out: values.get('--out')!,
    repeat: Number(repeat),
    caseId: values.get('--case'),
    dryRun: values.has('--dry-run'),
  };
}

/** Reject existing output, traversal and junction/symlink escapes before keys. */
export function validatePrivateQualityOutput(cwd: string, out: string): string {
  const repoRoot = realpathSync(cwd);
  const privateRoot = resolve(repoRoot, '.runtime');
  const outputRoot = resolve(repoRoot, out);
  const inside = relative(privateRoot, outputRoot);
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    throw new Error('OUTPUT_MUST_BE_INSIDE_RUNTIME');
  let current = privateRoot;
  for (const part of ['', ...inside.split(sep)]) {
    if (part) current = resolve(current, part);
    if (existsSync(current)) {
      if (
        lstatSync(current).isSymbolicLink() ||
        !statSync(current).isDirectory()
      )
        throw new Error('OUTPUT_PATH_MUST_NOT_REDIRECT');
      if (realpathSync(current).toLowerCase() !== current.toLowerCase())
        throw new Error('OUTPUT_PATH_MUST_NOT_REDIRECT');
    }
  }
  if (existsSync(outputRoot)) throw new Error('OUTPUT_ALREADY_EXISTS');
  return outputRoot;
}

/** The full input corpus is validated, even when selecting one case to retry. */
export function prepareQualityPlan(
  args: QualityArguments,
  cwd = process.cwd(),
): QualityPlan {
  if (!Number.isInteger(args.repeat) || args.repeat < 1 || args.repeat > 3)
    throw new Error('REPEAT_MUST_BE_1_TO_3');
  const outputRoot = validatePrivateQualityOutput(cwd, args.out);
  const manifestPath = resolve(cwd, args.manifest);
  if (statSync(manifestPath).size > 256 * 1024)
    throw new Error('MANIFEST_TOO_LARGE');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest?.version !== 'phone-quality-inputs/1' ||
    !['synthetic', 'human'].includes(manifest.kind) ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== 14
  )
    throw new Error('REQUIRE_14_CASE_QUALITY_MANIFEST');
  if (manifest.kind === 'human' && manifest.format !== 'PCMU_8000_mono')
    throw new Error('REQUIRE_PCMU_8000_MONO_MANIFEST');
  if (
    manifest.kind === 'human' &&
    manifest.consentForProjectEvaluation !== true
  )
    throw new Error('HUMAN_EVALUATION_CONSENT_REQUIRED');
  const ids = new Set<string>();
  const cases: PreparedQualityCase[] = manifest.cases.map(
    (item: QualityCase) => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(item.id) ||
        ids.has(item.id) ||
        !['local', 'remote'].includes(item.role) ||
        item.targetLanguage !== (item.role === 'local' ? 'en' : 'zh') ||
        !['short', 'long'].includes(item.kind) ||
        typeof item.inputFile !== 'string' ||
        !item.inputFile.toLowerCase().endsWith('.pcmu') ||
        [item.sourceText, item.expectedTranslation].some(
          (text) =>
            typeof text !== 'string' || !text.trim() || text.length > 8000,
        )
      )
        throw new Error('INVALID_OR_DUPLICATE_QUALITY_CASE');
      ids.add(item.id);
      const inputFile = resolve(dirname(manifestPath), item.inputFile);
      const stats = statSync(inputFile);
      if (!stats.isFile() || stats.size < 1 || stats.size > INPUT_LIMIT)
        throw new Error('INPUT_LIMIT_60_SECONDS_PCMU_8000_MONO');
      const input = readFileSync(inputFile);
      if (
        input.length !== stats.size ||
        input.subarray(0, 4).toString() === 'RIFF'
      )
        throw new Error('INPUT_CHANGED_OR_HAS_WAVE_HEADER');
      return {
        id: item.id,
        role: item.role,
        targetLanguage: item.targetLanguage,
        kind: item.kind,
        inputFile,
        sourceText: item.sourceText,
        expectedTranslation: item.expectedTranslation,
        input,
        inputSha256: sha256(input),
      };
    },
  );
  for (const role of ['local', 'remote']) {
    if (
      cases.filter((item) => item.role === role && item.kind === 'short')
        .length !== 6 ||
      cases.filter((item) => item.role === role && item.kind === 'long')
        .length !== 1
    )
      throw new Error('REQUIRE_SIX_SHORT_ONE_LONG_PER_DIRECTION');
  }
  if (args.caseId && !ids.has(args.caseId)) throw new Error('UNKNOWN_CASE_ID');
  const selected = cases.filter(
    (item) => !args.caseId || item.id === args.caseId,
  );
  const runs: QualityRun[] = [];
  for (let repetition = 1; repetition <= args.repeat; repetition += 1) {
    selected.forEach((item, index) => {
      const order: QualityCondition[] =
        (repetition + index) % 2 === 1
          ? ['off', 'near_field']
          : ['near_field', 'off'];
      for (const condition of order)
        runs.push({
          id: `${item.id}-r${repetition}-${condition}`,
          caseId: item.id,
          repetition,
          condition,
          inputSha256: item.inputSha256,
        });
    });
  }
  return {
    kind: manifest.kind,
    cases: selected,
    runs,
    repeat: args.repeat,
    outputRoot,
  };
}

export function qualityDryRunSummary(plan: QualityPlan) {
  return {
    phase: 'dry_run',
    kind: plan.kind,
    credentialsRead: false,
    networkUsed: false,
    writesPerformed: false,
    cases: plan.cases.map((item) => ({
      id: item.id,
      role: item.role,
      kind: item.kind,
      inputBytes: item.input.length,
      inputSha256: item.inputSha256,
    })),
    runs: plan.runs,
    runCount: plan.runs.length,
    inputStreamSeconds: plan.runs.reduce(
      (total, run) =>
        total +
        plan.cases.find((item) => item.id === run.caseId)!.input.length / 8000 +
        4.3,
      0,
    ),
    humanReview: 'pending',
    addedPhoneLatency: null,
  };
}

export function pcm16Wav(pcm: Buffer, sampleRate: 8000 | 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function pcmuWav(pcmu: Buffer): Buffer {
  const pcm = Buffer.alloc(pcmu.length * 2);
  pcmu.forEach((code, index) =>
    pcm.writeInt16LE(muLawToPcm16(code), index * 2),
  );
  return pcm16Wav(pcm, 8000);
}

// Never serialize arbitrary exception messages, file paths, credentials or URLs.
export function safeQualityError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code)
    ? code
    : 'QUALITY_EXPERIMENT_FAILED';
}

type RunDependencies = {
  createClient?: typeof createContinuousTranslationClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  hardLimitMs?: number;
};

/** Isolated model session. No Twilio/browser/live microphone is imported. */
export async function runQualitySession(
  item: PreparedQualityCase,
  run: QualityRun,
  credentials: { apiKey: string; proxyUrl?: string },
  dependencies: RunDependencies = {},
) {
  const clock = dependencies.now ?? (() => performance.now());
  const start = clock();
  const now = () => Math.round((clock() - start) * 10) / 10;
  const sleep = dependencies.sleep ?? delay;
  const raw: Buffer[] = [];
  const phone: Buffer[] = [];
  const rawDeltas: { atMs: number; bytes: number }[] = [];
  const phoneDeltas: {
    atMs: number;
    bytes: number;
    localFilterDrain?: boolean;
  }[] = [];
  const transcripts: { atMs: number; text: string }[] = [];
  const source = Buffer.concat([
    Buffer.alloc(PREFIX_BYTES, 255),
    item.input,
    Buffer.alloc(SUFFIX_BYTES, 255),
  ]);
  const inputConverter = new PcmuToPcm24k();
  const outputConverter = new Pcm24kToPcmu();
  let rawBytes = 0;
  let sentInputBytes = 0;
  let firstInputAtMs: number | null = null;
  let sourceFileEndAtMs: number | null = null;
  let failure: string | null = null;
  let finished = false;
  let drainBytes = 0;
  let transcriptBytes = 0;
  let client: ReturnType<typeof createContinuousTranslationClient> | undefined;
  const pushPhone = (pcm: Buffer, localFilterDrain = false) => {
    const converted = outputConverter.push(pcm);
    if (converted.length) {
      phone.push(converted);
      phoneDeltas.push({
        atMs: now(),
        bytes: converted.length,
        localFilterDrain,
      });
    }
    return converted.length;
  };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_yes, reject) => {
    timer = setTimeout(
      () => {
        failure ||= 'HARD_LIMIT_100_SECONDS';
        client?.abort();
        reject(new Error(failure));
      },
      Math.min(dependencies.hardLimitMs ?? 100000, 100000),
    );
  });
  try {
    const options: ContinuousTranslationOptions = {
      ...credentials,
      targetLanguage: item.targetLanguage,
      noiseReduction: run.condition === 'off' ? null : 'near_field',
      timeoutMs: 15000,
      onAudio(pcm) {
        if (rawBytes + pcm.length > OUTPUT_LIMIT) {
          failure ||= 'OUTPUT_LIMIT_120_SECONDS';
          throw new Error(failure);
        }
        rawBytes += pcm.length;
        raw.push(Buffer.from(pcm));
        rawDeltas.push({ atMs: now(), bytes: pcm.length });
        pushPhone(pcm);
      },
      onTranscript(text) {
        transcriptBytes += Buffer.byteLength(text);
        if (transcriptBytes > 256 * 1024) {
          failure ||= 'TRANSCRIPT_LIMIT';
          client?.abort();
          return;
        }
        transcripts.push({ atMs: now(), text });
      },
      onError(code) {
        failure ||= safeQualityError(new Error(code));
      },
    };
    client = (dependencies.createClient ?? createContinuousTranslationClient)(
      options,
    );
    const stream = async () => {
      await client!.ready;
      firstInputAtMs = now();
      const pacingStart = clock();
      for (let offset = 0; offset < source.length; offset += 160) {
        if (failure) throw new Error(failure);
        const target = pacingStart + offset / 8;
        await sleep(Math.max(0, target - clock()));
        if (failure) throw new Error(failure);
        if (clock() - target > 250) throw new Error('INPUT_PACING_STALL');
        const frame = source.subarray(offset, offset + 160);
        client!.append(inputConverter.push(frame));
        sentInputBytes += frame.length;
        if (offset < PREFIX_BYTES + item.input.length)
          sourceFileEndAtMs = now() + frame.length / 8;
      }
      await client!.finish();
      finished = true;
      if (!raw.length) throw new Error('NO_CONTINUOUS_AUDIO');
      // Drain exactly eight milliseconds of local FIR tail, separately labelled.
      drainBytes = pushPhone(Buffer.alloc(384), true);
    };
    await Promise.race([stream(), deadline]);
  } catch (error) {
    failure ||= safeQualityError(error);
  } finally {
    clearTimeout(timer!);
    client?.abort();
  }
  const rawPcm = Buffer.concat(raw);
  const phonePcmu = Buffer.concat(phone);
  const energy = analyzePcmuPlayback(phonePcmu, phoneDeltas);
  const subtract = (value: number | null, from: number | null) =>
    value === null || from === null ? null : Math.round(value - from);
  return {
    input: item.input,
    sentInput: source.subarray(0, sentInputBytes),
    rawPcm,
    phonePcmu,
    report: {
      ...run,
      model: 'gpt-realtime-translate',
      targetLanguage: item.targetLanguage,
      role: item.role,
      sourceText: item.sourceText,
      expectedTranslation: item.expectedTranslation,
      inputBytes: item.input.length,
      sentInputBytes,
      sentInputSha256: sha256(source.subarray(0, sentInputBytes)),
      prefixSilenceMs: 300,
      suffixSilenceMs: 4000,
      elapsedMs: now(),
      failure,
      completed: finished && !failure,
      providerDrainConfirmed: finished,
      firstInputAtMs,
      sourceFileEndAtMs,
      rawOutputBytes: rawBytes,
      phoneOutputBytes: phonePcmu.length,
      localFilterDrainBytes: drainBytes,
      rawDeltas,
      phoneDeltas,
      transcripts,
      outputTranscript: transcripts.map((entry) => entry.text).join(''),
      energy,
      estimatedFirstEnergyAfterInputStartMs: subtract(
        energy.firstEnergyAtMs,
        firstInputAtMs,
      ),
      estimatedLastEnergyAfterSourceFileEndMs: subtract(
        energy.lastEnergyAtMs,
        sourceFileEndAtMs,
      ),
      humanReview: 'pending',
      translationAccuracy: null,
      voiceStability: null,
      addedPhoneLatency: null,
      realPhone: false,
      limits: [
        'ENERGY_IS_NOT_MEANING_OR_HUMAN_HEARING',
        'IDEAL_FIFO_EXCLUDES_PHONE_NETWORK_AND_DEVICE',
        'FILE_END_IS_NOT_LAST_SPOKEN_PHONEME',
        'TEXT_DOES_NOT_PROVE_SPOKEN_ACCURACY',
        'SUSTAINED_SEMANTIC_LAG_REQUIRES_HUMAN_ALIGNMENT',
      ],
    },
  };
}

export function saveQualityRun(
  root: string,
  result: Awaited<ReturnType<typeof runQualitySession>>,
) {
  const runRoot = resolve(root, result.report.id);
  mkdirSync(runRoot);
  const write = (name: string, data: string | Buffer) =>
    writeFileSync(resolve(runRoot, name), data, { flag: 'wx' });
  write('input.pcmu', result.input);
  write('input-8k.wav', pcmuWav(result.input));
  write('sent-input.pcmu', result.sentInput);
  write('provider-24k.wav', pcm16Wav(result.rawPcm, 24000));
  write('phone.pcmu', result.phonePcmu);
  write('phone-8k.wav', pcmuWav(result.phonePcmu));
  write('result.private.json', JSON.stringify(result.report, null, 2));
}

export function createQualityOutput(plan: QualityPlan) {
  mkdirSync(dirname(plan.outputRoot), { recursive: true });
  mkdirSync(plan.outputRoot);
  writeFileSync(
    resolve(plan.outputRoot, 'plan.private.json'),
    JSON.stringify(
      {
        ...qualityDryRunSummary(plan),
        phase: 'planned',
        cases: plan.cases.map(({ input, ...item }) => ({
          ...item,
          inputBytes: input.length,
        })),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}

export function summarizeQualityRuns(
  plan: QualityPlan,
  reports: Awaited<ReturnType<typeof runQualitySession>>['report'][],
) {
  const hasFailures = reports.some((report) => Boolean(report.failure));
  return {
    version: 'continuous-quality-results/1',
    kind: plan.kind,
    plannedRuns: plan.runs.length,
    attemptedRuns: reports.length,
    completedRuns: reports.filter((report) => report.completed).length,
    hasFailures,
    stoppedOnFailure: reports.length < plan.runs.length && hasFailures,
    cases: plan.cases.map((item) => ({
      id: item.id,
      inputSha256: item.inputSha256,
      conditions: ['off', 'near_field'].map((condition) => {
        const selected = reports.filter(
          (report) =>
            report.caseId === item.id && report.condition === condition,
        );
        return {
          condition,
          expectedRuns: plan.repeat,
          attemptedRuns: selected.length,
          completedRuns: selected.filter((report) => report.completed).length,
          sameSourceHash: selected.length
            ? selected.every(
                (report) => report.inputSha256 === item.inputSha256,
              )
            : null,
        };
      }),
    })),
    humanReview: 'pending',
    translationAccuracy: null,
    voiceStability: null,
    addedPhoneLatency: null,
    realPhone: false,
  };
}
