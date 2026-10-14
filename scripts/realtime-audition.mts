/** One-shot audition entry. Importing and the default mode are offline only. */
import { spawnSync } from 'node:child_process';
import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  closeSync,
} from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import {
  prepareAuditionInput,
  type PreparedAuditionInput,
} from '../src/experiments/realtime-audition-input';
import {
  runRealtimeAudition,
  validateAuditionApproval,
  type AuditionApproval,
} from '../src/experiments/realtime-audition-runner';
import {
  reserveAuditionOutput,
  writeAuditionArtifacts,
  type AuditionOutputReservation,
} from '../src/experiments/realtime-audition-artifacts';

export const AUDITION_CANDIDATE = '320f01c4fa037989bddc8a26e0574e7282730c8a';
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export type AuditionCliArgs = {
  manifest?: string;
  approval?: string;
  output?: string;
  executeOnce: boolean;
  help: boolean;
};
function fail(code: string): never {
  throw new Error(`AUDITION_CLI_${code}`);
}

export function parseAuditionArgs(argv: string[]): AuditionCliArgs {
  const result: AuditionCliArgs = { executeOnce: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail('DUPLICATE_ARGUMENT');
    seen.add(flag);
    if (flag === '--help') result.help = true;
    else if (flag === '--execute-once') result.executeOnce = true;
    else if (flag === '--dry-run') {
      // Offline is the default. This flag only makes that choice explicit.
    } else if (['--manifest', '--approval', '--output'].includes(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--') || value.includes('\u0000'))
        fail('MISSING_ARGUMENT_VALUE');
      index += 1;
      if (flag === '--manifest') result.manifest = resolve(value);
      else if (flag === '--approval') result.approval = resolve(value);
      else result.output = resolve(value);
    } else fail('UNKNOWN_ARGUMENT');
  }
  if (result.executeOnce && seen.has('--dry-run')) fail('CONFLICTING_MODE');
  if (result.help) {
    if (argv.length !== 1) fail('HELP_MUST_BE_ALONE');
    return result;
  }
  if (!result.manifest) fail('MANIFEST_REQUIRED');
  if (result.executeOnce) {
    if (!result.approval || !result.output) fail('EXECUTION_APPROVAL_REQUIRED');
  } else if (result.approval || result.output) fail('DRY_RUN_HAS_NO_OUTPUT');
  return result;
}

function assertNoSymlinks(path: string): void {
  const { root } = parse(path);
  let current = root;
  for (const component of path.slice(root.length).split(sep)) {
    if (component) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    }
  }
}

/** No environment/secret reads, remote operations, or repository writes. */
export function assertAuditionCandidate(projectRoot = PROJECT_ROOT): void {
  const object = spawnSync(
    'git',
    ['--no-replace-objects', 'cat-file', '-t', AUDITION_CANDIDATE],
    { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (object.status !== 0 || object.stdout.trim() !== 'commit')
    fail('CANDIDATE_UNAVAILABLE');
  const unchanged = spawnSync(
    'git',
    [
      '--no-replace-objects',
      'diff',
      '--quiet',
      '--no-ext-diff',
      '--no-textconv',
      AUDITION_CANDIDATE,
      '--',
      'src/solo',
      'package.json',
      'package-lock.json',
    ],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  if (unchanged.status !== 0) fail('CANDIDATE_FILES_CHANGED');
}

/** Attestation records never replace the user's actual permission. */
export function readAuditionApproval(
  path: string,
  input: PreparedAuditionInput,
): AuditionApproval {
  let descriptor: number | undefined;
  let value: unknown;
  try {
    assertNoSymlinks(path);
    descriptor = openSync(
      path,
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > 32 * 1024)
      fail('APPROVAL_FILE_INVALID');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      current.isSymbolicLink()
    )
      fail('APPROVAL_FILE_CHANGED');
    assertNoSymlinks(path);
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AUDITION_CLI_'))
      throw error;
    return fail('APPROVAL_UNREADABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return validateAuditionApproval(value, input);
}

/** Validate, but do not create, a new private result directory. */
export function validateAuditionOutput(path: string): string {
  const output = resolve(path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(basename(output)))
    fail('OUTPUT_NAME_INVALID');
  try {
    assertNoSymlinks(dirname(output));
    if (!lstatSync(dirname(output)).isDirectory())
      fail('OUTPUT_PARENT_REQUIRED');
    try {
      lstatSync(output);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return output;
      throw error;
    }
    return fail('OUTPUT_ALREADY_EXISTS');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AUDITION_CLI_'))
      throw error;
    return fail('OUTPUT_PATH_INVALID');
  }
}

export function auditionDryRunSummary(input: PreparedAuditionInput) {
  return {
    mode: 'offline_dry_run',
    candidateSha: AUDITION_CANDIDATE,
    model: 'gpt-realtime-2.1',
    voice: 'echo',
    auxiliaryAsrModel: 'gpt-4o-transcribe',
    sessions: 1,
    automaticRetries: 0,
    automaticReconnects: 0,
    maxOutputTokensPerResponse: 512,
    maxResponses: 6,
    maxAsrCommits: 6,
    maxInputSeconds: 24,
    maxSavedOutputSeconds: 36,
    wavSha256: input.wavSha256,
    selectedInputSeconds: input.totalSeconds,
    plannedCommits: input.preflightCommits,
    submittedPcmSamples: input.preflightSubmittedSamples,
    paidCalls: 0,
    credentialsRead: false,
    filesWritten: false,
    budgetApproved: false,
  };
}

async function executeApprovedOnce(
  input: PreparedAuditionInput,
  authorization: AuditionApproval,
  output: string,
  environment: Record<string, string | undefined>,
  reservation: AuditionOutputReservation,
): Promise<void> {
  const proxyUrl = environment.HTTPS_PROXY ?? environment.HTTP_PROXY;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runRealtimeAudition({
      input,
      authorization,
      apiKey: environment.OPENAI_API_KEY!,
      proxyUrl,
      signal: controller.signal,
      // The parent client has already applied the inherited proxy agent.
      createWebSocket: (address, options) => new WebSocket(address, options),
    });
    writeAuditionArtifacts(output, input, result, reservation);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export type AuditionCliDependencies = {
  assertCandidate?: () => void;
  readEnvironment?: () => Record<string, string | undefined>;
  reserveOutput?: typeof reserveAuditionOutput;
  execute?: (
    input: PreparedAuditionInput,
    approval: AuditionApproval,
    output: string,
    environment: Record<string, string | undefined>,
    reservation: AuditionOutputReservation,
  ) => Promise<void>;
  stdout?: (value: string) => void;
};

/** Tests can prove dry-run never reaches environment reads or execution. */
export async function auditionMain(
  argv: string[],
  dependencies: AuditionCliDependencies = {},
): Promise<void> {
  const args = parseAuditionArgs(argv);
  const print = dependencies.stdout ?? ((value) => process.stdout.write(value));
  if (args.help) {
    print(
      'Offline default: --manifest PATH [--dry-run]\n' +
        'Future approved execution: --manifest PATH --execute-once --approval PATH --output NEWDIR\n',
    );
    return;
  }
  (dependencies.assertCandidate ?? assertAuditionCandidate)();
  const input = prepareAuditionInput(args.manifest!);
  if (!args.executeOnce) {
    print(`${JSON.stringify(auditionDryRunSummary(input), null, 2)}\n`);
    return;
  }
  const approval = readAuditionApproval(args.approval!, input);
  const output = validateAuditionOutput(args.output!);
  const reservation = (dependencies.reserveOutput ?? reserveAuditionOutput)(
    output,
  );
  // Deliberately last: no .env load, credential file, alternate key, or probing.
  const environment = (dependencies.readEnvironment ?? (() => process.env))();
  if (!environment.OPENAI_API_KEY?.trim()) fail('API_KEY_NOT_AVAILABLE');
  const execute = dependencies.execute ?? executeApprovedOnce;
  await execute(input, approval, output, environment, reservation);
  print('AUDITION_RESULT_SAVED\n');
}

const mainPath = process.argv[1];
if (mainPath && import.meta.url === pathToFileURL(resolve(mainPath)).href) {
  auditionMain(process.argv.slice(2)).catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^AUDITION_(?:CLI|INPUT|RUNNER)_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'AUDITION_CLI_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
