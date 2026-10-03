/** Isolated experiment; never imports phone startup, changes .env or creates a voice. */
import { readFile, stat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parse } from 'dotenv';

import { validatePrivateQualityOutput } from '../src/experiments/continuous-quality-matrix';
import {
  FIXED_VOICE_FORMAT,
  FIXED_VOICE_MODEL,
  FIXED_VOICE_SETTINGS,
  FixedSpeechError,
  fixedSpeechWave,
  synthesizeFixedSpeech,
  validFixedVoiceId,
} from '../src/experiments/elevenlabs-speech-client';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_TOTAL_CHARACTERS = 12_000;
const MAX_RUN_MS = 15 * 60_000;

export type FixedVoiceCase = {
  id: string;
  role: 'local' | 'remote';
  sourceText: string;
  expectedTranslation: string;
  targetLanguage: 'en' | 'zh';
  kind: 'short' | 'long';
};

export type FixedVoiceArgs = {
  fixtures: string;
  repeat: number;
  caseId?: string;
  voiceEn?: string;
  voiceZh?: string;
  dryRun: boolean;
  help: boolean;
};

function invalid(code: string): never {
  throw new FixedSpeechError(code);
}

export function parseFixedVoiceArgs(argv: string[]): FixedVoiceArgs {
  const args: FixedVoiceArgs = {
    fixtures: path.join(PROJECT_ROOT, 'tests/fixtures/phone-quality-v1.json'),
    repeat: 3,
    dryRun: false,
    help: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) invalid('DUPLICATE_ARGUMENT');
    seen.add(flag);
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--help') args.help = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) invalid('MISSING_ARGUMENT_VALUE');
      index += 1;
      if (flag === '--fixtures') args.fixtures = path.resolve(value);
      else if (flag === '--repeat') {
        if (!/^[1-3]$/.test(value)) invalid('REPEAT_MUST_BE_1_TO_3');
        args.repeat = Number(value);
      } else if (flag === '--case') {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(value)) invalid('INVALID_CASE_ID');
        args.caseId = value;
      } else if (flag === '--voice-en' || flag === '--voice-zh') {
        if (!validFixedVoiceId(value)) invalid('INVALID_VOICE_ID');
        if (flag === '--voice-en') args.voiceEn = value;
        else args.voiceZh = value;
      } else invalid('UNKNOWN_ARGUMENT');
    }
  }
  return args;
}

export function validateFixedVoiceFixtures(value: unknown): FixedVoiceCase[] {
  const fixture = value as { version?: unknown; cases?: unknown };
  if (
    !fixture ||
    fixture.version !== 'phone-quality-v1' ||
    !Array.isArray(fixture.cases) ||
    fixture.cases.length === 0 ||
    fixture.cases.length > 14
  )
    invalid('INVALID_FIXTURE');
  const ids = new Set<string>();
  return fixture.cases.map((entry: unknown) => {
    const item = entry as FixedVoiceCase;
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) ||
      ids.has(item.id) ||
      !['local', 'remote'].includes(item.role) ||
      !['short', 'long'].includes(item.kind) ||
      item.targetLanguage !== (item.role === 'local' ? 'en' : 'zh')
    )
      invalid('INVALID_FIXTURE_CASE');
    for (const text of [item.sourceText, item.expectedTranslation]) {
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
      )
        invalid('INVALID_FIXTURE_TEXT');
    }
    ids.add(item.id);
    // Ignore unrelated fields instead of copying unreviewed metadata into requests.
    return {
      id: item.id,
      role: item.role,
      sourceText: item.sourceText,
      expectedTranslation: item.expectedTranslation,
      targetLanguage: item.targetLanguage,
      kind: item.kind,
    };
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Validate every existing parent before creating private experiment files. */
export function fixedVoiceOutputPath(
  projectRoot: string,
  runName: string,
): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(runName)) invalid('INVALID_RUN_NAME');
  return validatePrivateQualityOutput(
    projectRoot,
    path.join('.runtime', 'fixed-voice-lab', runName),
  );
}

async function privateOutputDirectory(): Promise<string> {
  const root = await realpath(PROJECT_ROOT);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runName = `${stamp}-${randomUUID().slice(0, 8)}`;
  const output = fixedVoiceOutputPath(root, runName);
  await mkdir(path.dirname(output), { recursive: true });
  // Recheck after creating parents, before writing any input text or audio.
  fixedVoiceOutputPath(root, runName);
  await mkdir(output, { recursive: false });
  return output;
}

async function readPrivateConfig(): Promise<
  Record<string, string | undefined>
> {
  let fileValues: Record<string, string> = {};
  try {
    const envFile = path.join(PROJECT_ROOT, '.env');
    if ((await stat(envFile)).size > 256 * 1024) invalid('ENV_FILE_TOO_LARGE');
    fileValues = parse(await readFile(envFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    key: process.env.ELEVENLABS_API_KEY ?? fileValues.ELEVENLABS_API_KEY,
    en: process.env.ELEVENLABS_VOICE_ID_EN ?? fileValues.ELEVENLABS_VOICE_ID_EN,
    zh: process.env.ELEVENLABS_VOICE_ID_ZH ?? fileValues.ELEVENLABS_VOICE_ID_ZH,
  };
}

/** Exported for offline argument/fixture tests; importing never reads credentials. */
export async function runFixedVoiceLab(argv: string[]): Promise<number> {
  const args = parseFixedVoiceArgs(argv);
  if (args.help) {
    console.log(
      'Fixed voice lab: --fixtures <JSON> --case <id> --repeat <1..3> --voice-en <id> --voice-zh <id> --dry-run',
    );
    console.log(
      'Actual runs use ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID_EN/ZH from process.env or project .env. Dry-run reads neither.',
    );
    return 0;
  }
  if ((await stat(args.fixtures)).size > MAX_FIXTURE_BYTES)
    invalid('FIXTURE_TOO_LARGE');
  const cases = validateFixedVoiceFixtures(
    JSON.parse(await readFile(args.fixtures, 'utf8')),
  ).filter((item) => !args.caseId || item.id === args.caseId);
  if (cases.length === 0) invalid('CASE_NOT_FOUND');
  const characters =
    cases.reduce((sum, item) => sum + item.expectedTranslation.length, 0) *
    args.repeat;
  if (characters > MAX_TOTAL_CHARACTERS) invalid('TOTAL_CHARACTER_LIMIT');
  const output = await privateOutputDirectory();
  const report: Record<string, any> = {
    version: 'fixed-voice-lab/1',
    createdAt: new Date().toISOString(),
    status: 'PREPARED',
    plannedRequests: cases.length * args.repeat,
    inputCharacters: characters,
    model: FIXED_VOICE_MODEL,
    format: FIXED_VOICE_FORMAT,
    voiceSettings: FIXED_VOICE_SETTINGS,
    limits: {
      requests: 42,
      totalCharacters: MAX_TOTAL_CHARACTERS,
      runMs: MAX_RUN_MS,
      perRequestMs: 60_000,
      outputSecondsPerRequest: 60,
    },
    acceptance: {
      semantics: 'MANUAL_REVIEW_PENDING',
      voiceConsistency: 'MANUAL_REVIEW_PENDING',
      phoneAddedLatency: {
        status: 'UNKNOWN',
        targetMedianMs: 300,
        measuredMs: null,
        reason:
          'No matched phone-path baseline or human-hearing measurement; TTS arrival is not added phone latency.',
      },
    },
    attempts: [],
  };
  const persist = () =>
    writeFile(
      path.join(output, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  await writeFile(
    path.join(output, 'input.json'),
    `${JSON.stringify({ version: 'phone-quality-v1', cases }, null, 2)}\n`,
  );
  if (args.dryRun) {
    report.credentialAccess = false;
    report.providerRequests = 0;
    await persist();
    console.log(
      JSON.stringify({
        status: report.status,
        output,
        requests: report.plannedRequests,
        dryRun: true,
      }),
    );
    return 0;
  }
  const config = await readPrivateConfig();
  const voiceIds = {
    en: args.voiceEn ?? config.en,
    zh: args.voiceZh ?? config.zh,
  };
  const missing: string[] = [];
  if (!config.key) missing.push('ELEVENLABS_API_KEY');
  for (const language of new Set(cases.map((item) => item.targetLanguage))) {
    if (!validFixedVoiceId(voiceIds[language]))
      missing.push(`ELEVENLABS_VOICE_ID_${language.toUpperCase()}`);
  }
  if (missing.length) {
    report.status = 'BLOCKED';
    report.missingConfiguration = missing;
    report.providerRequests = 0;
    await persist();
    console.log(JSON.stringify({ status: 'BLOCKED', missing, output }));
    return 2;
  }
  report.voiceIds = voiceIds;
  report.status = 'RUNNING';
  await persist();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const started = performance.now();
  const runTimer = setTimeout(stop, MAX_RUN_MS);
  try {
    for (const item of cases) {
      for (let repetition = 1; repetition <= args.repeat; repetition += 1) {
        if (controller.signal.aborted) invalid('ABORTED');
        const name = `${item.id}-r${repetition}`;
        const attempt: Record<string, any> = {
          caseId: item.id,
          role: item.role,
          language: item.targetLanguage,
          repetition,
          status: 'STARTED',
          startedAt: new Date().toISOString(),
        };
        report.attempts.push(attempt);
        await persist();
        try {
          const result = await synthesizeFixedSpeech({
            apiKey: config.key!,
            voiceId: voiceIds[item.targetLanguage]!,
            language: item.targetLanguage,
            text: item.expectedTranslation,
            signal: controller.signal,
          });
          await writeFile(path.join(output, `${name}.ulaw`), result.pcmu);
          await writeFile(
            path.join(output, `${name}.wav`),
            fixedSpeechWave(result.pcmu),
          );
          await writeFile(
            path.join(output, `${name}.events.json`),
            `${JSON.stringify(result.events, null, 2)}\n`,
          );
          attempt.status = 'AUDIO_RECEIVED';
          attempt.metrics = result.metrics;
          attempt.files = {
            raw: `${name}.ulaw`,
            listen: `${name}.wav`,
            events: `${name}.events.json`,
          };
        } catch (error) {
          attempt.status = 'FAILED';
          attempt.error =
            error instanceof FixedSpeechError ? error.code : 'LOCAL_IO_FAILED';
          throw error;
        } finally {
          await persist();
        }
      }
    }
    report.status = 'AUDIO_RECEIVED_REVIEW_PENDING';
  } catch (error) {
    report.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
    report.error =
      error instanceof FixedSpeechError ? error.code : 'LOCAL_IO_FAILED';
  } finally {
    clearTimeout(runTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    report.elapsedMs = performance.now() - started;
    report.providerRequests = report.attempts.length;
    const completed = report.attempts.filter(
      (item: any) => item.status === 'AUDIO_RECEIVED',
    );
    report.clientArrivalSummary = {
      completedRequests: completed.length,
      medianFirstAudioFromTextMs: median(
        completed.map((item: any) => item.metrics.firstAudioFromTextMs),
      ),
      medianFirstNonSilentArrivalFromTextMs: median(
        completed
          .map((item: any) => item.metrics.firstNonSilentArrivalFromTextMs)
          .filter((value: unknown) => typeof value === 'number'),
      ),
      boundary:
        'Arrival after full verified text submission; excludes upstream recognition/translation, phone path and listener.',
    };
    await persist();
  }
  console.log(
    JSON.stringify({
      status: report.status,
      output,
      requests: report.providerRequests,
    }),
  );
  return report.status === 'AUDIO_RECEIVED_REVIEW_PENDING' ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runFixedVoiceLab(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          status: 'FAILED',
          error:
            error instanceof FixedSpeechError
              ? error.code
              : 'LOCAL_INPUT_OR_IO_FAILED',
        }),
      );
      process.exitCode = 1;
    });
}
