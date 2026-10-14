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
  estimateAliyunAuditionCost,
  assertAliyunAuditionPath,
  reserveAliyunAuditionOutput,
  writeAliyunAuditionArtifacts,
} from '../src/experiments/aliyun-audition-artifacts';
import {
  prepareAliyunAuditionInput,
  readAliyunAuditionFile,
  type PreparedAliyunAuditionInput,
} from '../src/experiments/aliyun-audition-input';
import {
  runAliyunAudition,
  type AliyunAuditionRunnerOptions,
  type AliyunAuditionResult,
} from '../src/experiments/aliyun-audition-runner';
import { parsePhoneTranslationSelection } from '../src/solo/aliyun-planb-config';

export const ALIYUN_AUDITION_PARENT =
  '108f22b70f327bb7b73cf67577741e711d1b0dc1';
export type AliyunAuditionArgs = {
  manifest?: string;
  executeOnce: boolean;
  approval?: string;
  output?: string;
  help: boolean;
};

function fail(code: string): never {
  throw new Error(`ALIYUN_AUDITION_CLI_${code}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

export function parseAliyunAuditionArgs(args: string[]): AliyunAuditionArgs {
  if (args.length === 1 && args[0] === '--help')
    return { executeOnce: false, help: true };
  const result: AliyunAuditionArgs = { executeOnce: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) fail('ARGS_INVALID');
    seen.add(flag);
    if (flag === '--run') result.executeOnce = true;
    else if (['--manifest', '--approval', '--out'].includes(flag)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) fail('ARGS_INVALID');
      if (flag === '--manifest') result.manifest = value;
      if (flag === '--approval') result.approval = value;
      if (flag === '--out') result.output = value;
      index += 1;
    } else fail('ARGS_INVALID');
  }
  if (!result.manifest) fail('ARGS_INVALID');
  if (result.executeOnce && (!result.approval || !result.output))
    fail('RUN_APPROVAL_AND_OUTPUT_REQUIRED');
  if (!result.executeOnce && (result.approval || result.output))
    fail('RUN_FLAG_REQUIRED');
  return result;
}

export type AliyunAuditionApproval = {
  version: 1;
  provider: 'aliyun-plan-b';
  parentCandidate: typeof ALIYUN_AUDITION_PARENT;
  region: PreparedAliyunAuditionInput['region'];
  manifestSha256: string;
  sampleHashes: { id: string; sha256: string }[];
  models: {
    asr: 'fun-asr-realtime';
    translation: 'qwen-mt-flash';
    tts: 'cosyvoice-v3-flash';
  };
  voice: 'loongandy_v3';
  currency: 'CNY';
  approvedAmountCny: number;
  dataSendApproved: true;
  executeOnce: true;
  approvalReference: string;
  approvedAt: string;
};

/** A future authorization record; templates do not grant chat authorization. */
export function readAliyunAuditionApproval(
  path: string,
  input: PreparedAliyunAuditionInput,
): AliyunAuditionApproval {
  let value: unknown;
  try {
    value = JSON.parse(readAliyunAuditionFile(path, 32768).toString('utf8'));
  } catch {
    fail('APPROVAL_FILE_INVALID');
  }
  if (
    !record(value) ||
    !exactKeys(value, [
      'version',
      'provider',
      'parentCandidate',
      'region',
      'manifestSha256',
      'sampleHashes',
      'models',
      'voice',
      'currency',
      'approvedAmountCny',
      'dataSendApproved',
      'executeOnce',
      'approvalReference',
      'approvedAt',
    ]) ||
    value.version !== 1 ||
    value.provider !== 'aliyun-plan-b' ||
    value.parentCandidate !== ALIYUN_AUDITION_PARENT ||
    value.region !== input.region ||
    value.manifestSha256 !== input.manifestSha256 ||
    value.voice !== 'loongandy_v3' ||
    value.currency !== 'CNY' ||
    typeof value.approvedAmountCny !== 'number' ||
    !Number.isFinite(value.approvedAmountCny) ||
    value.approvedAmountCny < 1 ||
    value.dataSendApproved !== true ||
    value.executeOnce !== true ||
    typeof value.approvalReference !== 'string' ||
    !value.approvalReference.trim() ||
    value.approvalReference.length > 500 ||
    typeof value.approvedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value.approvedAt,
    ) ||
    !Number.isFinite(Date.parse(value.approvedAt)) ||
    !record(value.models) ||
    !exactKeys(value.models, ['asr', 'translation', 'tts']) ||
    value.models.asr !== 'fun-asr-realtime' ||
    value.models.translation !== 'qwen-mt-flash' ||
    value.models.tts !== 'cosyvoice-v3-flash' ||
    !Array.isArray(value.sampleHashes) ||
    value.sampleHashes.length !== input.clips.length ||
    value.sampleHashes.some((sample: unknown, index: number) => {
      const clip = input.clips[index];
      return (
        !record(sample) ||
        !exactKeys(sample, ['id', 'sha256']) ||
        sample.id !== clip.id ||
        sample.sha256 !== clip.sha256
      );
    })
  )
    fail('APPROVAL_BINDING_INVALID');
  return value as AliyunAuditionApproval;
}

/** Deterministic content binding survives copies/reformatting of one approval. */
function consumeApproval(
  input: PreparedAliyunAuditionInput,
  approval: AliyunAuditionApproval,
  stateDirectory?: string,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        approval.provider,
        approval.parentCandidate,
        approval.region,
        approval.manifestSha256,
        approval.sampleHashes.map((sample) => [sample.id, sample.sha256]),
        approval.approvalReference,
        approval.approvedAt,
      ]),
    )
    .digest('hex');
  let state = stateDirectory;
  if (!state) {
    const common = spawnSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        encoding: 'utf8',
        maxBuffer: 4096,
        timeout: 5000,
      },
    );
    if (common.status !== 0 || !common.stdout.trim())
      fail('APPROVAL_STATE_UNAVAILABLE');
    state = resolve(common.stdout.trim(), 'aliyun-audition-runs');
  }
  state = resolve(state);
  assertAliyunAuditionPath(dirname(state));
  try {
    mkdirSync(state, { mode: 0o700 });
  } catch {
    // The following directory and mode checks reject unsafe existing paths.
  }
  assertAliyunAuditionPath(state);
  const stat = lstatSync(state);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== 0o700)
    fail('APPROVAL_STATE_INVALID');
  const lock = resolve(state, `${digest}.spent`);
  let descriptor: number;
  try {
    descriptor = openSync(
      lock,
      // eslint-disable-next-line no-bitwise -- Exclusive private one-shot file, no symlink following.
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
    if (!fstatSync(descriptor).isFile()) fail('APPROVAL_LOCK_INVALID');
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        version: 1,
        status: 'spent_before_first_supplier_request',
        manifestSha256: input.manifestSha256,
        approvalFingerprint: digest,
        consumedAt: new Date().toISOString(),
      })}\n`,
    );
  } finally {
    closeSync(descriptor);
  }
  return lock;
}

function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:ALIYUN_AUDITION_|PLAN_B_)[A-Z_]{1,100}$/.test(message))
    return message;
  if (
    /^CLOUD_PLAN_B_(?:KEY_MISSING|CONFIG_INVALID):[A-Z_]{1,64}$/.test(message)
  )
    return message;
  return 'ALIYUN_AUDITION_CLI_FAILED';
}

export type AliyunAuditionCliDependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  write?: (line: string) => void;
  run?: (options: AliyunAuditionRunnerOptions) => Promise<AliyunAuditionResult>;
  signal?: AbortSignal;
  /** Trusted offline fixture port; not user-selectable from command arguments. */
  stateDirectory?: string;
};

export async function aliyunAuditionMain(
  argv: string[],
  dependencies: AliyunAuditionCliDependencies = {},
): Promise<number> {
  const write =
    dependencies.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const args = parseAliyunAuditionArgs(argv);
    if (args.help) {
      write(
        'Offline: node --import tsx scripts/aliyun-audition.mts --manifest PATH\nFuture authorized one-shot: add --run --approval PATH --out NEW_DIRECTORY. Requires a new Alibaba sample-data and CNY amount approval; never reuse an OpenAI approval. No microphone, playback, Twilio, retry or reconnect.',
      );
      return 0;
    }
    const input = prepareAliyunAuditionInput(args.manifest!);
    const planning = estimateAliyunAuditionCost(input.region);
    if (!args.executeOnce) {
      write(
        JSON.stringify({
          mode: 'offline_preflight',
          parentCandidate: ALIYUN_AUDITION_PARENT,
          model: {
            asr: 'fun-asr-realtime',
            translation: 'qwen-mt-flash',
            tts: 'cosyvoice-v3-flash',
            voice: 'loongandy_v3',
          },
          region: input.region,
          manifestSha256: input.manifestSha256,
          samples: input.clips.map(
            ({ id, role, sha256, durationMs, speechEndMs }) => ({
              id,
              role,
              sha256,
              durationMs,
              speechEndMs: speechEndMs ?? null,
            }),
          ),
          totalSeconds: input.totalSeconds,
          planning,
          credentialRead: false,
          supplierRequests: 0,
          approval: 'new_Alibaba_data_send_and_CNY_amount_approval_required',
          referenceAnswers: 'not_read_or_uploaded',
        }),
      );
      return 0;
    }
    const approval = readAliyunAuditionApproval(args.approval!, input);
    const reservation = reserveAliyunAuditionOutput(args.output!);
    const env = dependencies.env ?? process.env;
    const keyName =
      input.region === 'beijing'
        ? 'ALIYUN_BEIJING_API_KEY'
        : 'ALIYUN_SINGAPORE_API_KEY';
    const selection = parsePhoneTranslationSelection({
      CLOUD_PHONE_TRANSLATION_PROVIDER: 'aliyun-plan-b',
      ALIYUN_PLAN_B_REGION: input.region,
      [keyName]: env[keyName],
      ...(env.ALIYUN_PLAN_B_PROXY_URL
        ? { ALIYUN_PLAN_B_PROXY_URL: env.ALIYUN_PLAN_B_PROXY_URL }
        : {}),
    });
    if (selection.provider !== 'aliyun-plan-b') fail('PROVIDER_INVALID');
    if (dependencies.signal?.aborted) fail('CANCELLED_BEFORE_RUN');
    consumeApproval(input, approval, dependencies.stateDirectory);
    const controller = new AbortController();
    const abort = () => controller.abort();
    dependencies.signal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    let result: AliyunAuditionResult;
    try {
      result = await (dependencies.run ?? runAliyunAudition)({
        config: selection.config,
        clips: input.clips,
        signal: controller.signal,
      });
    } finally {
      dependencies.signal?.removeEventListener('abort', abort);
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    const artifacts = writeAliyunAuditionArtifacts(input, result, reservation);
    write(
      JSON.stringify({
        mode: 'one_shot_complete',
        status: result.status,
        ...(result.errorCode
          ? { errorCode: safeCode(new Error(result.errorCode)) }
          : {}),
        region: input.region,
        files: artifacts.files,
        costs: 'report.json; calculated usage is not a verified invoice',
        playedAudio: false,
        approvalConsumed: true,
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
) {
  process.exitCode = await aliyunAuditionMain(process.argv.slice(2));
}
