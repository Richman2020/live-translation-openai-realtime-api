import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  pcmuWav,
  summarizeQualityRuns,
  type QualityPlan,
  type QualityRun,
  type runQualitySession,
} from './continuous-quality-matrix';

type Report = Awaited<ReturnType<typeof runQualitySession>>['report'];
type Artifact = { runId: string; name: string; sha256: string; bytes: number };
export type ValidatedQualityResume = {
  sourceRoot: string;
  reports: Report[];
  artifacts: Artifact[];
};
const FILES = [
  'input.pcmu',
  'input-8k.wav',
  'sent-input.pcmu',
  'provider-24k.wav',
  'phone.pcmu',
  'phone-8k.wav',
  'result.private.json',
];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function extractQualityResumeArgument(args: string[]) {
  const index = args.indexOf('--resume-from');
  if (index === -1)
    return { args, resumeFrom: undefined as string | undefined };
  if (
    args.lastIndexOf('--resume-from') !== index ||
    !args[index + 1] ||
    args[index + 1].startsWith('--')
  )
    throw new Error('INVALID_RESUME_ARGUMENT');
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2)],
    resumeFrom: args[index + 1],
  };
}

function descendant(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    Boolean(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
  );
}

function checkedPath(root: string, path: string) {
  if (root !== path && !descendant(root, path))
    throw new Error('RESUME_PATH_OUTSIDE_PRIVATE_ROOT');
  let cursor = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw new Error('RESUME_LINK_NOT_ALLOWED');
    if (realpathSync(cursor).toLowerCase() !== cursor.toLowerCase())
      throw new Error('RESUME_REDIRECT_NOT_ALLOWED');
  }
  return path;
}

function readBounded(root: string, name: string, limit: number) {
  const path = checkedPath(root, resolve(root, name));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit)
    throw new Error('RESUME_FILE_TOO_LARGE_OR_NOT_FILE');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size || bytes.length > limit)
    throw new Error('RESUME_FILE_CHANGED');
  return bytes;
}

function readJson(root: string, name: string): any {
  let result: unknown;
  try {
    result = JSON.parse(
      readBounded(root, name, 2 * 1024 * 1024).toString('utf8'),
    );
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('RESUME_INVALID_JSON');
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('RESUME_INVALID_JSON');
  return result;
}

export function isContinuableQualityFailure(
  report: Pick<
    Report,
    'failure' | 'providerDrainConfirmed' | 'rawOutputBytes' | 'completed'
  >,
) {
  return (
    report.failure === 'NO_CONTINUOUS_AUDIO' &&
    report.providerDrainConfirmed === true &&
    report.rawOutputBytes === 0 &&
    report.completed === false
  );
}

function waveData(bytes: Buffer, rate: number) {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== rate ||
    bytes.readUInt32LE(28) !== rate * 2 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    bytes.length % 2
  )
    throw new Error('RESUME_INVALID_WAVE');
  return bytes.subarray(44);
}

/** Validate every old attempt before any credential read, copy or paid request. */
export function validateQualityResume(
  plan: QualityPlan,
  from: string,
  cwd = process.cwd(),
): ValidatedQualityResume {
  const repo = realpathSync(cwd);
  const privateRoot = resolve(repo, '.runtime');
  const sourceRoot = resolve(repo, from);
  if (!descendant(privateRoot, sourceRoot))
    throw new Error('RESUME_SOURCE_MUST_BE_INSIDE_RUNTIME');
  checkedPath(repo, sourceRoot);
  if (!lstatSync(sourceRoot).isDirectory())
    throw new Error('RESUME_SOURCE_MUST_BE_DIRECTORY');
  if (
    sourceRoot === plan.outputRoot ||
    descendant(sourceRoot, plan.outputRoot) ||
    descendant(plan.outputRoot, sourceRoot)
  )
    throw new Error('RESUME_OUTPUT_MUST_BE_SEPARATE_NEW_DIRECTORY');
  const previous = readJson(sourceRoot, 'plan.private.json');
  if (
    previous.kind !== plan.kind ||
    !Array.isArray(previous.runs) ||
    previous.runs.length !== plan.runs.length ||
    !Array.isArray(previous.cases) ||
    previous.cases.length !== plan.cases.length
  )
    throw new Error('RESUME_PLAN_MISMATCH');
  plan.runs.forEach((run, index) => {
    const old = previous.runs[index];
    if (
      !old ||
      ['id', 'caseId', 'repetition', 'condition', 'inputSha256'].some(
        (key) => old[key] !== run[key],
      )
    )
      throw new Error('RESUME_RUN_PLAN_MISMATCH');
  });
  plan.cases.forEach((item, index) => {
    const old = previous.cases[index];
    if (
      !old ||
      [
        'id',
        'role',
        'targetLanguage',
        'kind',
        'sourceText',
        'expectedTranslation',
        'inputSha256',
      ].some((key) => old[key] !== item[key]) ||
      old.inputBytes !== item.input.length
    )
      throw new Error('RESUME_INPUT_PLAN_MISMATCH');
  });
  const rootEntries = readdirSync(sourceRoot);
  if (rootEntries.includes('inflight.private.json'))
    throw new Error('RESUME_UNRESOLVED_INFLIGHT_ATTEMPT_REQUIRES_REVIEW');
  const allowedRoots = new Set([
    'plan.private.json',
    'summary.json',
    'review.html',
    'resume.private.json',
    ...plan.runs.map((run) => run.id),
  ]);
  for (const entry of rootEntries) {
    if (!allowedRoots.has(entry)) throw new Error('RESUME_UNKNOWN_ROOT_ENTRY');
    checkedPath(sourceRoot, resolve(sourceRoot, entry));
    if (['review.html', 'resume.private.json'].includes(entry))
      readBounded(sourceRoot, entry, 2 * 1024 * 1024);
  }
  const reports: Report[] = [];
  const artifacts: Artifact[] = [];
  let absent = false;
  for (const run of plan.runs) {
    if (!rootEntries.includes(run.id)) {
      absent = true;
      // eslint-disable-next-line no-continue -- Scan all later IDs to reject holes in attempted history.
      continue;
    }
    if (absent) throw new Error('RESUME_ATTEMPT_PREFIX_HAS_HOLE');
    const runRoot = checkedPath(sourceRoot, resolve(sourceRoot, run.id));
    const files = readdirSync(runRoot).sort();
    if (JSON.stringify(files) !== JSON.stringify([...FILES].sort()))
      throw new Error('RESUME_UNKNOWN_OR_MISSING_RUN_FILE');
    const contents = new Map<string, Buffer>();
    for (const name of FILES) {
      const data = readBounded(
        sourceRoot,
        `${run.id}/${name}`,
        name === 'result.private.json' ? 2 * 1024 * 1024 : 6 * 1024 * 1024,
      );
      contents.set(name, data);
      artifacts.push({
        runId: run.id,
        name,
        sha256: sha(data),
        bytes: data.length,
      });
    }
    const report: Report = readJson(
      sourceRoot,
      `${run.id}/result.private.json`,
    );
    const item = plan.cases.find((candidate) => candidate.id === run.caseId)!;
    const expectedInput = Buffer.concat([
      Buffer.alloc(2400, 255),
      item.input,
      Buffer.alloc(32000, 255),
    ]);
    if (
      ['id', 'caseId', 'repetition', 'condition', 'inputSha256'].some(
        (key) => report[key] !== run[key],
      ) ||
      report.role !== item.role ||
      report.targetLanguage !== item.targetLanguage ||
      report.sourceText !== item.sourceText ||
      report.expectedTranslation !== item.expectedTranslation ||
      report.inputBytes !== item.input.length ||
      report.sentInputBytes !== expectedInput.length ||
      report.sentInputSha256 !== sha(expectedInput) ||
      !contents.get('input.pcmu')!.equals(item.input) ||
      !contents.get('sent-input.pcmu')!.equals(expectedInput) ||
      !contents.get('input-8k.wav')!.equals(pcmuWav(item.input)) ||
      !contents
        .get('phone-8k.wav')!
        .equals(pcmuWav(contents.get('phone.pcmu')!))
    )
      throw new Error('RESUME_ATTEMPT_INPUT_OR_ID_MISMATCH');
    if (
      waveData(contents.get('provider-24k.wav')!, 24000).length !==
        report.rawOutputBytes ||
      contents.get('phone.pcmu')!.length !== report.phoneOutputBytes
    )
      throw new Error('RESUME_OUTPUT_LENGTH_MISMATCH');
    if (
      !(
        (report.completed === true &&
          report.failure === null &&
          report.providerDrainConfirmed === true &&
          report.rawOutputBytes > 0) ||
        isContinuableQualityFailure(report)
      )
    )
      throw new Error('RESUME_UNRESOLVED_TRANSPORT_OR_PROTOCOL_FAILURE');
    if (
      isContinuableQualityFailure(report) &&
      (report.phoneOutputBytes !== 0 || report.localFilterDrainBytes !== 0)
    )
      throw new Error('RESUME_NO_AUDIO_FAILURE_HAS_AUDIO');
    reports.push(report);
  }
  if (!reports.length || reports.length === plan.runs.length)
    throw new Error('RESUME_REQUIRES_UNFINISHED_ATTEMPT_PREFIX');
  const summary = readJson(sourceRoot, 'summary.json');
  const expectedSummary = summarizeQualityRuns(plan, reports);
  if (
    summary.version !== expectedSummary.version ||
    summary.kind !== expectedSummary.kind ||
    summary.plannedRuns !== expectedSummary.plannedRuns ||
    summary.attemptedRuns !== expectedSummary.attemptedRuns ||
    summary.completedRuns !== expectedSummary.completedRuns ||
    JSON.stringify(summary.cases) !== JSON.stringify(expectedSummary.cases)
  )
    throw new Error('RESUME_SUMMARY_MISMATCH');
  // A previous explicit resume may already contain an acknowledged quality
  // failure followed by more attempts. The original run cannot have that shape.
  if (
    !rootEntries.includes('resume.private.json') &&
    reports.slice(0, -1).some((report) => report.failure)
  )
    throw new Error('RESUME_ATTEMPTS_AFTER_UNACKNOWLEDGED_FAILURE');
  if (rootEntries.includes('resume.private.json')) {
    const provenance = readJson(sourceRoot, 'resume.private.json');
    if (
      provenance.version !== 'continuous-quality-resume/1' ||
      provenance.policy !==
        'preserve_attempts_never_retry_continue_confirmed_no_audio_only' ||
      !Number.isInteger(provenance.priorAttemptedRuns) ||
      provenance.priorAttemptedRuns < 1 ||
      provenance.priorAttemptedRuns > reports.length ||
      JSON.stringify(provenance.copiedRunIds) !==
        JSON.stringify(
          reports
            .slice(0, provenance.priorAttemptedRuns)
            .map((report) => report.id),
        )
    )
      throw new Error('RESUME_INVALID_PROVENANCE');
  }
  return { sourceRoot, reports, artifacts };
}

/** Write before connecting: a process crash must never permit an unknown retry. */
export function beginQualityAttempt(root: string, run: QualityRun) {
  const path = resolve(root, 'inflight.private.json');
  checkedPath(root, root);
  writeFileSync(
    path,
    JSON.stringify(
      { version: 'continuous-quality-inflight/1', ...run },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}

/** Clear only after both immutable run artifacts and the summary are saved. */
export function finishQualityAttempt(root: string, run: QualityRun) {
  const marker = readJson(root, 'inflight.private.json');
  if (
    marker.version !== 'continuous-quality-inflight/1' ||
    ['id', 'caseId', 'condition', 'repetition', 'inputSha256'].some(
      (key) => marker[key] !== run[key],
    )
  )
    throw new Error('INFLIGHT_ATTEMPT_ID_MISMATCH');
  unlinkSync(resolve(root, 'inflight.private.json'));
}

/** Called only after createQualityOutput made a separate fresh private root. */
export function copyQualityResume(
  plan: QualityPlan,
  resume: ValidatedQualityResume,
  cwd = process.cwd(),
) {
  const target = checkedPath(realpathSync(cwd), plan.outputRoot);
  const expectedEntries = ['plan.private.json'];
  if (
    JSON.stringify(readdirSync(target).sort()) !==
    JSON.stringify(expectedEntries)
  )
    throw new Error('RESUME_DESTINATION_NOT_FRESH');
  for (const report of resume.reports) mkdirSync(resolve(target, report.id));
  for (const artifact of resume.artifacts) {
    const bytes = readBounded(
      resume.sourceRoot,
      `${artifact.runId}/${artifact.name}`,
      6 * 1024 * 1024,
    );
    if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256)
      throw new Error('RESUME_SOURCE_CHANGED_BEFORE_COPY');
    writeFileSync(resolve(target, artifact.runId, artifact.name), bytes, {
      flag: 'wx',
    });
  }
  writeFileSync(
    resolve(target, 'resume.private.json'),
    JSON.stringify(
      {
        version: 'continuous-quality-resume/1',
        sourceRoot: resume.sourceRoot,
        priorAttemptedRuns: resume.reports.length,
        copiedRunIds: resume.reports.map((report) => report.id),
        policy:
          'preserve_attempts_never_retry_continue_confirmed_no_audio_only',
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}
