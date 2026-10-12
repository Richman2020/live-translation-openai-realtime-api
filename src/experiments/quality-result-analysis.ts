import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { analyzePcmuPlayback } from '../solo/translation-audio-measurement';
import { muLawToPcm16 } from '../solo/translation-pcm';

type Json = Record<string, any>;
type Window = { startMs: number; endMs: number; activeMs: number };
const CONDITIONS = ['off', 'near_field'] as const;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const nullableTime = (value: unknown) =>
  value === null || (finite(value) && value >= 0);
const digest = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Energy only: isolated short impulses remain visible outside sustained bounds.
 * Adjacent energetic frames/runs separated by <=120 ms form a cluster; a cluster
 * needs >=100 ms of actual energetic frames. This is not continuous voicing or VAD.
 */
export function analyzeInputEnergy(input: Buffer, thresholdRms = 300) {
  if (
    !input.length ||
    input.length > 60 * 8000 ||
    !finite(thresholdRms) ||
    thresholdRms <= 0
  )
    throw new Error('ANALYSIS_INVALID_INPUT_AUDIO');
  const rawRuns: Window[] = [];
  for (let offset = 0; offset < input.length; offset += 160) {
    const end = Math.min(offset + 160, input.length);
    let sum = 0;
    for (let index = offset; index < end; index += 1) {
      const sample = muLawToPcm16(input[index]);
      sum += sample * sample;
    }
    if (Math.sqrt(sum / (end - offset)) >= thresholdRms) {
      const previous = rawRuns[rawRuns.length - 1];
      if (previous?.endMs === offset / 8) {
        previous.endMs = end / 8;
        previous.activeMs += (end - offset) / 8;
      } else
        rawRuns.push({
          startMs: offset / 8,
          endMs: end / 8,
          activeMs: (end - offset) / 8,
        });
    }
  }
  const bridged: Window[] = [];
  for (const run of rawRuns) {
    const previous = bridged[bridged.length - 1];
    if (previous && run.startMs - previous.endMs <= 120) {
      previous.endMs = run.endMs;
      previous.activeMs += run.activeMs;
    } else bridged.push({ ...run });
  }
  // The 100 ms requirement counts actual energetic frames, never the bridged gap.
  const windows = bridged.filter((run) => run.activeMs >= 100);
  const firstMs = windows[0]?.startMs ?? null;
  const lastMs = windows[windows.length - 1]?.endMs ?? null;
  return {
    frameMs: 20,
    thresholdRms,
    minimumActiveMs: 100,
    bridgeGapMs: 120,
    durationMs: input.length / 8,
    rawRuns,
    windows,
    firstMs,
    lastMs,
    leadingLowEnergyMs: firstMs,
    trailingLowEnergyMs: lastMs === null ? null : input.length / 8 - lastMs,
  };
}

function below(root: string, candidate: string) {
  const suffix = relative(root, candidate);
  return (
    Boolean(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
  );
}

function checkedPath(root: string, path: string, allowMissingLeaf = false) {
  if (root !== path && !below(root, path))
    throw new Error('ANALYSIS_PATH_OUTSIDE_RUNTIME');
  let cursor = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) cursor = resolve(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (
        allowMissingLeaf &&
        cursor === path &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      )
        return path;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('ANALYSIS_LINK_NOT_ALLOWED');
    if (realpathSync(cursor).toLowerCase() !== cursor.toLowerCase())
      throw new Error('ANALYSIS_REDIRECT_NOT_ALLOWED');
    if (cursor !== path && !stat.isDirectory())
      throw new Error('ANALYSIS_PARENT_NOT_DIRECTORY');
  }
  return path;
}

function readBounded(root: string, name: string, limit: number) {
  const path = checkedPath(root, resolve(root, name));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
    throw new Error('ANALYSIS_INVALID_OR_LINKED_FILE');
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    bytes.length !== stat.size ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ino !== stat.ino
  )
    throw new Error('ANALYSIS_INPUT_CHANGED');
  return bytes;
}

function readJson(root: string, name: string): Json {
  const bytes = readBounded(root, name, 2 * 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('ANALYSIS_INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('ANALYSIS_INVALID_JSON');
  return value;
}

function validatePlan(plan: Json) {
  if (
    plan.phase !== 'planned' ||
    !['human', 'synthetic'].includes(plan.kind) ||
    !Array.isArray(plan.cases) ||
    plan.cases.length < 1 ||
    plan.cases.length > 14 ||
    !Array.isArray(plan.runs) ||
    plan.runs.length !== plan.runCount ||
    plan.runs.length < 2 ||
    plan.runs.length > 84
  )
    throw new Error('ANALYSIS_INVALID_PLAN');
  const cases = new Map<string, Json>();
  for (const item of plan.cases) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(item.id) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(item.id) ||
      cases.has(item.id.toLowerCase()) ||
      !digest(item.inputSha256) ||
      !Number.isInteger(item.inputBytes) ||
      item.inputBytes < 1 ||
      item.inputBytes > 480000 ||
      !['short', 'long'].includes(item.kind) ||
      !['local', 'remote'].includes(item.role) ||
      item.targetLanguage !== (item.role === 'local' ? 'en' : 'zh')
    )
      throw new Error('ANALYSIS_INVALID_CASE');
    cases.set(item.id.toLowerCase(), item);
  }
  if (plan.cases.length === 14) {
    const ids = [
      ...Array.from({ length: 12 }, (_, index) =>
        String(index + 1).padStart(2, '0'),
      ),
      'L01',
      'L02',
    ];
    if (
      ids.some((id, index) => {
        const item = cases.get(id.toLowerCase());
        return (
          !item ||
          item.id !== id ||
          item.role !== (index % 2 === 0 ? 'local' : 'remote') ||
          item.kind !== (index < 12 ? 'short' : 'long')
        );
      })
    )
      throw new Error('ANALYSIS_INVALID_FULL_V1_CORPUS');
  }
  const repeat = plan.runs.length / (plan.cases.length * 2);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3)
    throw new Error('ANALYSIS_INVALID_MATRIX');
  const expected = new Map<string, Json>();
  for (const item of plan.cases) {
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      for (const condition of CONDITIONS) {
        const id = `${item.id}-r${repetition}-${condition}`;
        expected.set(id, {
          id,
          caseId: item.id,
          repetition,
          condition,
          inputSha256: item.inputSha256,
        });
      }
    }
  }
  const seen = new Set<string>();
  for (const run of plan.runs) {
    const want = run && expected.get(run.id);
    if (
      !want ||
      seen.has(run.id) ||
      Object.keys(want).some((key) => run[key] !== want[key])
    )
      throw new Error('ANALYSIS_INVALID_MATRIX');
    seen.add(run.id);
  }
  return repeat;
}

function validateResult(result: Json, run: Json, item: Json) {
  if (
    ['id', 'caseId', 'condition', 'repetition'].some(
      (key) => result[key] !== run[key],
    ) ||
    result.role !== item.role ||
    result.targetLanguage !== item.targetLanguage ||
    !digest(result.inputSha256) ||
    !Number.isInteger(result.inputBytes) ||
    typeof result.completed !== 'boolean' ||
    typeof result.providerDrainConfirmed !== 'boolean' ||
    !(
      result.failure === null ||
      (typeof result.failure === 'string' &&
        /^[A-Z][A-Z0-9_]{0,95}$/.test(result.failure))
    ) ||
    typeof result.outputTranscript !== 'string' ||
    !nullableTime(result.firstInputAtMs) ||
    !nullableTime(result.sourceFileEndAtMs) ||
    result.prefixSilenceMs !== 300 ||
    !Number.isInteger(result.phoneOutputBytes) ||
    result.phoneOutputBytes < 0 ||
    !Array.isArray(result.phoneDeltas) ||
    !result.energy ||
    !nullableTime(result.energy.firstEnergyAtMs) ||
    !nullableTime(result.energy.lastEnergyAtMs) ||
    !finite(result.energy.activeDurationMs) ||
    result.energy.activeDurationMs < 0 ||
    (result.completed &&
      (result.failure !== null || !result.providerDrainConfirmed))
  )
    throw new Error('ANALYSIS_INVALID_RESULT');
}

/** Offline only. The dependency graph includes PCM/measurement code, never providers or dotenv. */
export function analyzeQualityResults(options: {
  input: string;
  out: string;
  cwd?: string;
}) {
  const cwd = realpathSync(options.cwd ?? process.cwd());
  const privateRoot = resolve(cwd, '.runtime');
  const root = resolve(cwd, options.input);
  const output = resolve(cwd, options.out);
  if (!below(privateRoot, root) || !below(privateRoot, output))
    throw new Error('ANALYSIS_MUST_STAY_INSIDE_RUNTIME');
  // Keep strict resume directories unchanged: the resume reader rejects extra entries.
  if (output === root || below(root, output))
    throw new Error('ANALYSIS_OUTPUT_MUST_BE_OUTSIDE_RESULT_DIRECTORY');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.analysis\.private\.json$/.test(
      basename(output),
    )
  )
    throw new Error('ANALYSIS_REQUIRE_NAMED_PRIVATE_REPORT');
  checkedPath(cwd, root);
  checkedPath(cwd, output, true);
  if (
    !lstatSync(root).isDirectory() ||
    !lstatSync(dirname(output)).isDirectory()
  )
    throw new Error('ANALYSIS_DIRECTORY_REQUIRED');
  if (existsSync(output)) throw new Error('ANALYSIS_OUTPUT_ALREADY_EXISTS');
  const planBytes = readBounded(root, 'plan.private.json', 2 * 1024 * 1024);
  const plan = readJson(root, 'plan.private.json');
  const repeat = validatePlan(plan);
  const inflightAtStart = existsSync(
    checkedPath(root, resolve(root, 'inflight.private.json'), true),
  );
  const runs: Json[] = [];
  for (const run of plan.runs) {
    const runRoot = resolve(root, run.id);
    checkedPath(root, runRoot, true);
    if (!existsSync(runRoot)) {
      runs.push({ ...run, state: 'missing' });
      // eslint-disable-next-line no-continue -- Preserve planned rows without attempting absent artifacts.
      continue;
    }
    const resultPath = checkedPath(
      root,
      resolve(runRoot, 'result.private.json'),
      true,
    );
    if (!existsSync(resultPath)) {
      runs.push({ ...run, state: 'missing' });
      // eslint-disable-next-line no-continue -- A pending result is not a saved provider attempt.
      continue;
    }
    const item = plan.cases.find((entry: Json) => entry.id === run.caseId)!;
    const result = readJson(root, `${run.id}/result.private.json`);
    validateResult(result, run, item);
    const input = readBounded(root, `${run.id}/input.pcmu`, 480000);
    const inputHash = sha(input);
    const sameInput =
      inputHash === item.inputSha256 &&
      result.inputSha256 === inputHash &&
      input.length === item.inputBytes &&
      input.length === result.inputBytes;
    const primary = analyzeInputEnergy(input);
    const sensitivity = [100, 1000].map((threshold) =>
      analyzeInputEnergy(input, threshold),
    );
    const phone = readBounded(root, `${run.id}/phone.pcmu`, 120 * 8000 + 64);
    let energy: ReturnType<typeof analyzePcmuPlayback>;
    try {
      energy = analyzePcmuPlayback(phone, result.phoneDeltas);
    } catch {
      throw new Error('ANALYSIS_INVALID_OUTPUT_SCHEDULE');
    }
    const energyMatches =
      phone.length === result.phoneOutputBytes &&
      [
        'firstEnergyAtMs',
        'lastEnergyAtMs',
        'activeDurationMs',
        'totalAudioMs',
        'scheduledEndMs',
        'thresholdRms',
        'frameMs',
      ].every((key) => energy[key] === result.energy[key]);
    const issues: string[] = [];
    if (!sameInput) issues.push('INPUT_HASH_OR_LENGTH_MISMATCH');
    if (!energyMatches) issues.push('OUTPUT_MEASUREMENT_MISMATCH');
    if (!result.providerDrainConfirmed)
      issues.push('PROVIDER_DRAIN_NOT_CONFIRMED');
    if (result.failure) issues.push(result.failure);
    if (primary.firstMs === null) issues.push('NO_SUSTAINED_INPUT_ENERGY');
    if (energy.firstEnergyAtMs === null) issues.push('NO_OUTPUT_ENERGY');
    if (!finite(result.firstInputAtMs) || !finite(result.sourceFileEndAtMs))
      issues.push('MISSING_INPUT_CLOCK_ANCHOR');
    else {
      const clockSpan = result.sourceFileEndAtMs - result.firstInputAtMs;
      const expectedSpan = result.prefixSilenceMs + primary.durationMs;
      // The runner allows at most 250 ms scheduling lateness; the final 20 ms
      // source frame may include the beginning of its suffix silence.
      if (clockSpan < expectedSpan - 20 || clockSpan > expectedSpan + 270)
        issues.push('INPUT_CLOCK_ANCHORS_INCONSISTENT');
    }
    const eligible = issues.length === 0 && result.completed;
    const sourceFirstAtMs =
      finite(result.firstInputAtMs) && primary.firstMs !== null
        ? result.firstInputAtMs + result.prefixSilenceMs + primary.firstMs
        : null;
    const sourceLastAtMs =
      finite(result.sourceFileEndAtMs) && primary.trailingLowEnergyMs !== null
        ? result.sourceFileEndAtMs - primary.trailingLowEnergyMs
        : null;
    runs.push({
      ...run,
      state: 'saved',
      completed: result.completed,
      failure: result.failure,
      providerDrainConfirmed: result.providerDrainConfirmed,
      actualInputSha256: inputHash,
      sameSourceHash: sameInput,
      outputMeasurementMatchesSavedReport: energyMatches,
      noOutputEnergy: energy.firstEnergyAtMs === null,
      emptyText: result.outputTranscript.trim().length === 0,
      inputEnergy: primary,
      inputEnergySensitivity: sensitivity,
      original: {
        firstInputAtMs: result.firstInputAtMs,
        sourceFileEndAtMs: result.sourceFileEndAtMs,
        prefixSilenceMs: result.prefixSilenceMs,
        energy: result.energy,
        estimatedFirstEnergyAfterInputStartMs:
          result.estimatedFirstEnergyAfterInputStartMs ?? null,
        estimatedLastEnergyAfterSourceFileEndMs:
          result.estimatedLastEnergyAfterSourceFileEndMs ?? null,
      },
      aligned: {
        eligible,
        issues,
        sourceFirstSustainedEnergyAtMs: sourceFirstAtMs,
        sourceLastSustainedEnergyAtMs: sourceLastAtMs,
        estimatedFirstOutputEnergyAfterSustainedInputStartMs: eligible
          ? round(energy.firstEnergyAtMs! - sourceFirstAtMs!)
          : null,
        estimatedFirstOutputEnergyAfterSustainedInputEndMs: eligible
          ? round(energy.firstEnergyAtMs! - sourceLastAtMs!)
          : null,
        estimatedLastOutputEnergyAfterSustainedInputEndMs: eligible
          ? round(energy.lastEnergyAtMs! - sourceLastAtMs!)
          : null,
      },
    });
  }
  const inflightAtEnd = existsSync(
    checkedPath(root, resolve(root, 'inflight.private.json'), true),
  );
  if (
    !readBounded(root, 'plan.private.json', 2 * 1024 * 1024).equals(planBytes)
  )
    throw new Error('ANALYSIS_PLAN_CHANGED');
  const saved = runs.filter((run) => run.state === 'saved');
  const byCondition = CONDITIONS.map((condition) => {
    const selected = runs.filter((run) => run.condition === condition);
    const attempted = selected.filter((run) => run.state === 'saved');
    return {
      condition,
      planned: selected.length,
      savedAttempts: attempted.length,
      missingResults: selected.length - attempted.length,
      completed: attempted.filter((run) => run.completed).length,
      failed: attempted.filter((run) => !run.completed).length,
      noOutputEnergy: attempted.filter((run) => run.noOutputEnergy).length,
      emptyText: attempted.filter((run) => run.emptyText).length,
      alignedTimingEligible: attempted.filter((run) => run.aligned.eligible)
        .length,
    };
  });
  const completedMatrix =
    saved.length === runs.length && !inflightAtStart && !inflightAtEnd;
  const report = {
    version: 'continuous-quality-analysis/1',
    generatedAt: new Date().toISOString(),
    kind: plan.kind,
    planSha256: sha(planBytes),
    repeat,
    plannedRuns: runs.length,
    savedAttempts: saved.length,
    completedMatrix,
    fullV1Matrix: completedMatrix && plan.cases.length === 14 && repeat === 3,
    unresolvedInflight: inflightAtStart || inflightAtEnd,
    sameSourceHash: saved.length
      ? saved.every((run) => run.sameSourceHash)
      : null,
    allOutputMeasurementsMatch: saved.length
      ? saved.every((run) => run.outputMeasurementMatchesSavedReport)
      : null,
    allProviderDrainsConfirmed: saved.length
      ? saved.every((run) => run.providerDrainConfirmed)
      : null,
    byCondition,
    runs,
    humanReview: 'pending',
    realPhone: false,
    credentialsRead: false,
    networkUsed: false,
    limitations: [
      'ENERGY_IS_NOT_SPEECH_MEANING_OR_HUMAN_HEARING',
      'IDEAL_FIFO_EXCLUDES_PHONE_NETWORK_DEVICE_AND_ACTUAL_PLAYBACK',
      'INPUT_CLOCK_ALIGNMENT_ASSUMES_PACED_8KHZ_AND_HAS_FRAME_AND_SCHEDULER_ERROR',
      'SOURCE_LAST_ENERGY_IS_NOT_LAST_SPOKEN_PHONEME',
      'WEAK_ENDINGS_CAN_FALL_BELOW_THRESHOLD_SEE_SENSITIVITY',
      'ISOLATED_SHORT_IMPULSES_DO_NOT_DEFINE_BOUNDS_BUT_CLOSE_IMPULSES_CAN_ACCUMULATE_100MS',
      'NEGATIVE_WAIT_CAN_MEAN_OUTPUT_BEFORE_INPUT_END_NOT_SUCCESS',
      'COMPLETED_MATRIX_COUNTS_SAVED_ATTEMPTS_NOT_QUALITY_PASSES',
      'PARTIAL_SNAPSHOT_MAY_MISS_UNFINISHED_OR_NEW_ATTEMPTS',
      'NO_TRANSCRIPTION_OR_LISTENING_PERFORMED',
    ],
  };
  checkedPath(cwd, output, true);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  // Public stdout gets counters only. Source text and output transcripts are never copied.
  return {
    output,
    plannedRuns: runs.length,
    savedAttempts: saved.length,
    completedMatrix,
    sameSourceHash: report.sameSourceHash,
    byCondition,
    networkUsed: false,
    humanReview: 'pending',
  };
}
