import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertLiveTranslateAuditionPath,
  estimateLiveTranslateAuditionCost,
  reserveLiveTranslateAuditionOutput,
  writeLiveTranslateAuditionArtifacts,
} from '../src/experiments/livetranslate-audition-artifacts';
import {
  LIVETRANSLATE_AUDITION_MODEL,
  LIVETRANSLATE_AUDITION_PARENT,
  LIVETRANSLATE_AUDITION_SCOPE,
  LIVETRANSLATE_SINGLE_LOCAL_SCOPE,
  LIVETRANSLATE_SINGLE_LOCAL_PARENT,
  LIVETRANSLATE_AUDITION_VOICE,
  liveTranslateExactKeys,
  liveTranslateRecord,
  prepareLiveTranslateAuditionInput,
  readLiveTranslateAuditionFile,
  type PreparedLiveTranslateAuditionInput,
} from '../src/experiments/livetranslate-audition-input';
import {
  runLiveTranslateAudition,
  type LiveTranslateAuditionRunnerOptions,
  type LiveTranslateAuditionResult,
} from '../src/experiments/livetranslate-audition-runner';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fail(code: string): never {
  throw new Error(`LIVETRANSLATE_AUDITION_CLI_${code}`);
}
export type LiveTranslateAuditionArgs = {
  help: boolean;
  executeOnce: boolean;
  manifest?: string;
  approval?: string;
  output?: string;
};
export function parseLiveTranslateAuditionArgs(
  argv: string[],
): LiveTranslateAuditionArgs {
  if (argv.length === 1 && argv[0] === '--help')
    return { help: true, executeOnce: false };
  const args: LiveTranslateAuditionArgs = { help: false, executeOnce: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail('ARGS_INVALID');
    seen.add(flag);
    if (flag === '--run') args.executeOnce = true;
    else if (['--manifest', '--approval', '--out'].includes(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('ARGS_INVALID');
      if (flag === '--manifest') args.manifest = value;
      if (flag === '--approval') args.approval = value;
      if (flag === '--out') args.output = value;
      index += 1;
    } else fail('ARGS_INVALID');
  }
  if (!args.manifest) fail('ARGS_INVALID');
  if (args.executeOnce && (!args.approval || !args.output))
    fail('RUN_APPROVAL_AND_OUTPUT_REQUIRED');
  if (!args.executeOnce && (args.approval || args.output))
    fail('RUN_FLAG_REQUIRED');
  return args;
}
export type LiveTranslateAuditionApproval = {
  version: 1 | 2;
  mode?: 'single-local';
  scope:
    | typeof LIVETRANSLATE_AUDITION_SCOPE
    | typeof LIVETRANSLATE_SINGLE_LOCAL_SCOPE;
  parentCandidate:
    | typeof LIVETRANSLATE_AUDITION_PARENT
    | typeof LIVETRANSLATE_SINGLE_LOCAL_PARENT;
  candidateSha: string;
  model: typeof LIVETRANSLATE_AUDITION_MODEL;
  voice: 'Tina';
  spaceHost: string;
  manifestSha256: string;
  sampleHashes: { id: string; sha256: string }[];
  currency: 'CNY';
  approvedAmountCny: number;
  dataSendApproved: true;
  executeOnce: true;
  acceptsLocalStopsNotBillingCap: true;
  acceptsUnpricedHistoryRisk: true;
  approvalReference: string;
  approvedAt: string;
  preflight: {
    accountModelAccessVerified: true;
    exactHostNetworkPolicyVerified: true;
    currentPriceVerified: true;
    checkedAt: string;
    evidenceReference: string;
  };
};
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));
const reference = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 300;
/** Records an explicit new user decision, not an authorization template or API capability probe. */
export function readLiveTranslateAuditionApproval(
  path: string,
  input: PreparedLiveTranslateAuditionInput,
  candidateSha: string | undefined,
  now = Date.now(),
): LiveTranslateAuditionApproval {
  let value: unknown;
  try {
    value = JSON.parse(
      readLiveTranslateAuditionFile(path, 32768).toString('utf8'),
    );
  } catch {
    fail('APPROVAL_FILE_INVALID');
  }
  const single = input.mode === 'single-local';
  const minimum =
    estimateLiveTranslateAuditionCost(input).planningReserve.estimatedCny;
  if (
    !liveTranslateRecord(value) ||
    !liveTranslateExactKeys(value, [
      'version',
      ...(single ? ['mode'] : []),
      'scope',
      'parentCandidate',
      'candidateSha',
      'model',
      'voice',
      'spaceHost',
      'manifestSha256',
      'sampleHashes',
      'currency',
      'approvedAmountCny',
      'dataSendApproved',
      'executeOnce',
      'acceptsLocalStopsNotBillingCap',
      'acceptsUnpricedHistoryRisk',
      'approvalReference',
      'approvedAt',
      'preflight',
    ]) ||
    value.version !== (single ? 2 : 1) ||
    (single && value.mode !== 'single-local') ||
    value.scope !==
      (single
        ? LIVETRANSLATE_SINGLE_LOCAL_SCOPE
        : LIVETRANSLATE_AUDITION_SCOPE) ||
    value.parentCandidate !==
      (single
        ? LIVETRANSLATE_SINGLE_LOCAL_PARENT
        : LIVETRANSLATE_AUDITION_PARENT) ||
    typeof value.candidateSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(value.candidateSha) ||
    (candidateSha !== undefined && value.candidateSha !== candidateSha) ||
    value.model !== LIVETRANSLATE_AUDITION_MODEL ||
    value.voice !== LIVETRANSLATE_AUDITION_VOICE ||
    value.spaceHost !== input.spaceHost ||
    value.manifestSha256 !== input.manifestSha256 ||
    value.currency !== 'CNY' ||
    typeof value.approvedAmountCny !== 'number' ||
    !Number.isFinite(value.approvedAmountCny) ||
    value.approvedAmountCny < minimum ||
    value.dataSendApproved !== true ||
    value.executeOnce !== true ||
    value.acceptsLocalStopsNotBillingCap !== true ||
    value.acceptsUnpricedHistoryRisk !== true ||
    !reference(value.approvalReference) ||
    !date(value.approvedAt) ||
    !Array.isArray(value.sampleHashes) ||
    value.sampleHashes.length !== input.clips.length ||
    value.sampleHashes.some(
      (sample: unknown, index: number) =>
        !liveTranslateRecord(sample) ||
        !liveTranslateExactKeys(sample, ['id', 'sha256']) ||
        sample.id !== input.clips[index].id ||
        sample.sha256 !== input.clips[index].sha256,
    )
  )
    fail('APPROVAL_BINDING_INVALID');
  const evidence = value.preflight;
  if (
    !liveTranslateRecord(evidence) ||
    !liveTranslateExactKeys(evidence, [
      'accountModelAccessVerified',
      'exactHostNetworkPolicyVerified',
      'currentPriceVerified',
      'checkedAt',
      'evidenceReference',
    ]) ||
    evidence.accountModelAccessVerified !== true ||
    evidence.exactHostNetworkPolicyVerified !== true ||
    evidence.currentPriceVerified !== true ||
    !date(evidence.checkedAt) ||
    !reference(evidence.evidenceReference)
  )
    fail('PREFLIGHT_EVIDENCE_REQUIRED');
  if (
    [value.approvedAt, evidence.checkedAt].some(
      (time) =>
        now - Date.parse(time) > 24 * 60 * 60 * 1000 ||
        Date.parse(time) > now + 5 * 60 * 1000,
    )
  )
    fail('FRESH_APPROVAL_AND_PREFLIGHT_REQUIRED');
  return value as LiveTranslateAuditionApproval;
}
function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16384,
  });
  if (result.status !== 0) fail('CANDIDATE_UNAVAILABLE');
  return result.stdout.trim();
}
export function verifyLiveTranslateAuditionRuntime(cwd = repo) {
  const sha = git(['rev-parse', 'HEAD'], cwd);
  const status = git(
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      'src',
      'scripts',
      'public',
      'package.json',
      'package-lock.json',
      'tsconfig*.json',
      '.gitignore',
    ],
    cwd,
  );
  if (status) fail('CANDIDATE_FILES_CHANGED');
  return sha;
}
function consumeApproval(
  approval: LiveTranslateAuditionApproval,
  stateDirectory?: string,
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        approval.scope,
        approval.mode ?? 'dual',
        approval.candidateSha,
        approval.manifestSha256,
        approval.spaceHost,
        approval.model,
        approval.voice,
        approval.approvalReference,
        approval.approvedAt,
      ]),
    )
    .digest('hex');
  const state = resolve(
    stateDirectory ??
      resolve(
        git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
        'livetranslate-audition-runs',
      ),
  );
  assertLiveTranslateAuditionPath(dirname(state));
  try {
    mkdirSync(state, { mode: 0o700 });
  } catch {
    /* Check an existing directory below. */
  }
  assertLiveTranslateAuditionPath(state);
  const stat = lstatSync(state);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== 0o700)
    fail('APPROVAL_STATE_INVALID');
  let fd: number;
  try {
    fd = openSync(
      resolve(state, `${digest}.spent`),
      // eslint-disable-next-line no-bitwise -- Exclusive one-use record, never follow symlinks.
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail('APPROVAL_ALREADY_SPENT_OR_LOCK_UNAVAILABLE');
  }
  try {
    if (!fstatSync(fd).isFile()) fail('APPROVAL_LOCK_INVALID');
    writeFileSync(
      fd,
      `${JSON.stringify({ version: 1, scope: approval.scope, manifestSha256: approval.manifestSha256, status: 'spent_before_first_supplier_request', consumedAt: new Date().toISOString() })}\n`,
    );
  } finally {
    closeSync(fd);
  }
}
const safeCodes = new Set([
  ...[
    'ARGS_INVALID',
    'RUN_APPROVAL_AND_OUTPUT_REQUIRED',
    'RUN_FLAG_REQUIRED',
    'APPROVAL_FILE_INVALID',
    'APPROVAL_BINDING_INVALID',
    'PREFLIGHT_EVIDENCE_REQUIRED',
    'FRESH_APPROVAL_AND_PREFLIGHT_REQUIRED',
    'CANDIDATE_UNAVAILABLE',
    'CANDIDATE_FILES_CHANGED',
    'CANDIDATE_MISMATCH',
    'APPROVAL_STATE_INVALID',
    'APPROVAL_ALREADY_SPENT_OR_LOCK_UNAVAILABLE',
    'APPROVAL_LOCK_INVALID',
    'CANCELLED_BEFORE_RUN',
    'KEY_UNAVAILABLE',
  ].map((code) => `LIVETRANSLATE_AUDITION_CLI_${code}`),
  ...[
    'SYMLINK_FORBIDDEN',
    'REGULAR_FILE_REQUIRED',
    'FILE_SIZE_INVALID',
    'FILE_CHANGED',
    'FILE_UNREADABLE',
    'WORKSPACE_INVALID',
    'WAV_INVALID',
    'WAV_REQUIRES_PCM16_MONO_16K',
    'MANIFEST_INVALID',
    'CLIP_INVALID',
    'PATH_OUTSIDE_MANIFEST',
    'HASH_MISMATCH',
    'DUPLICATE_SAMPLE',
    'SAMPLE_TOO_SHORT',
    'INPUT_LIMIT_EXCEEDED',
    'SPEECH_ENDPOINT_INVALID',
  ].map((code) => `LIVETRANSLATE_AUDITION_INPUT_${code}`),
  ...[
    'SYMLINK_FORBIDDEN',
    'REGULAR_FILE_REQUIRED',
    'PRIVATE_DIRECTORY_REQUIRED',
    'INVALID_PCM',
    'RESERVATION_CHANGED',
    'RESERVATION_INVALID',
    'RESERVATION_NOT_EMPTY',
    'OUTPUT_LIMIT',
    'ESTIMATE_INPUT_INVALID',
    'REMOTE_AUDIO_FORBIDDEN',
  ].map((code) => `LIVETRANSLATE_AUDITION_ARTIFACT_${code}`),
]);
function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return safeCodes.has(code) ? code : 'LIVETRANSLATE_AUDITION_CLI_FAILED';
}
export type LiveTranslateAuditionCliDependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  write?: (line: string) => void;
  run?: (
    options: LiveTranslateAuditionRunnerOptions,
  ) => Promise<LiveTranslateAuditionResult>;
  signal?: AbortSignal;
  now?: () => number;
  /** Trusted offline test ports, never user-selectable flags. */
  candidate?: () => string;
  stateDirectory?: string;
};
export async function liveTranslateAuditionMain(
  argv: string[],
  deps: LiveTranslateAuditionCliDependencies = {},
): Promise<number> {
  const write =
    deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const args = parseLiveTranslateAuditionArgs(argv);
    if (args.help) {
      write(
        'Offline only by default: node --import tsx scripts/livetranslate-audition.mts --manifest PATH. Future --run also requires --approval PATH --out NEW_PRIVATE_DIRECTORY and a new model/Tina/space-host/data/CNY authorization. No microphone, phone, automatic playback, retry or reconnect.',
      );
      return 0;
    }
    const input = prepareLiveTranslateAuditionInput(args.manifest!);
    const planning = estimateLiveTranslateAuditionCost(input);
    if (!args.executeOnce) {
      write(
        JSON.stringify({
          mode: 'offline_preflight',
          auditionMode: input.mode ?? 'dual',
          scope:
            input.mode === 'single-local'
              ? LIVETRANSLATE_SINGLE_LOCAL_SCOPE
              : LIVETRANSLATE_AUDITION_SCOPE,
          parentCandidate:
            input.mode === 'single-local'
              ? LIVETRANSLATE_SINGLE_LOCAL_PARENT
              : LIVETRANSLATE_AUDITION_PARENT,
          model: LIVETRANSLATE_AUDITION_MODEL,
          voice: LIVETRANSLATE_AUDITION_VOICE,
          spaceHost: input.spaceHost,
          manifestSha256: input.manifestSha256,
          samples: input.clips.map(
            ({ id, role, durationMs, sha256, speechEndMs }) => ({
              id,
              role,
              durationMs,
              sha256,
              speechEndMs: speechEndMs ?? null,
            }),
          ),
          totalSeconds: input.totalSeconds,
          planning,
          credentialRead: false,
          credentialStatus: 'not_checked_offline',
          domainStatus:
            'requires_current_authorized_environment_metadata_evidence',
          supplierRequests: 0,
          referenceAnswers: 'not_read_or_uploaded',
          authorization:
            'new_LiveTranslate_sample_send_and_explicit_CNY_amount_required',
          oldAuthorizations: 'OpenAI_USD1_and_previous_PlanB_CNY1_not_reusable',
          comparison: planning.comparison,
        }),
      );
      return 0;
    }
    // Approval files are inspected before accessing any credential, even when runtime files are uncommitted.
    if (!args.approval || !args.output)
      fail('RUN_APPROVAL_AND_OUTPUT_REQUIRED');
    const approval = readLiveTranslateAuditionApproval(
      args.approval,
      input,
      undefined,
      deps.now?.() ?? Date.now(),
    );
    const candidateSha = (
      deps.candidate ?? verifyLiveTranslateAuditionRuntime
    )();
    if (candidateSha !== approval.candidateSha) fail('CANDIDATE_MISMATCH');
    if (deps.signal?.aborted) fail('CANCELLED_BEFORE_RUN');
    const reservation = reserveLiveTranslateAuditionOutput(args.output);
    const env = deps.env ?? process.env;
    const key = env.ALIYUN_BEIJING_API_KEY;
    if (typeof key !== 'string' || !key.trim()) fail('KEY_UNAVAILABLE');
    consumeApproval(approval, deps.stateDirectory);
    const controller = new AbortController();
    const abort = () => controller.abort();
    deps.signal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    let result: LiveTranslateAuditionResult;
    try {
      result = await (deps.run ?? runLiveTranslateAudition)({
        input,
        apiKey: key,
        signal: controller.signal,
      });
    } finally {
      deps.signal?.removeEventListener('abort', abort);
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    const artifacts = writeLiveTranslateAuditionArtifacts(
      input,
      result,
      reservation,
    );
    write(
      JSON.stringify({
        mode: 'one_shot_complete',
        status: result.status,
        errorCode: result.errorCode
          ? 'LIVETRANSLATE_AUDITION_STOPPED_SEE_PRIVATE_REPORT'
          : null,
        files: artifacts.files,
        approvalConsumed: true,
        playedAudio: false,
        invoice: 'not_verified',
        isBillingHardCap: false,
      }),
    );
    return result.status === 'completed' ? 0 : 1;
  } catch (error) {
    write(JSON.stringify({ status: 'stopped', errorCode: safeCode(error) }));
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await liveTranslateAuditionMain(process.argv.slice(2));
