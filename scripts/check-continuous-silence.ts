import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

import {
  createQualityOutput,
  runQualitySession,
  safeQualityError,
  saveQualityRun,
} from '../src/experiments/continuous-quality-matrix';
import {
  evaluateSilence,
  prepareSilencePlan,
  silenceDryRun,
  summarizeSilence,
} from '../src/experiments/continuous-silence';

/** Exactly four sequential synthetic sessions, no retries or changes to phone configuration. */
async function main() {
  const { plan, dryRun } = prepareSilencePlan(process.argv.slice(2));
  if (dryRun) {
    console.log(JSON.stringify(silenceDryRun(plan)));
    return;
  }
  const envPath = resolve('.env');
  if (statSync(envPath).size > 256 * 1024)
    throw new Error('ENV_FILE_TOO_LARGE');
  const cfg = parse(readFileSync(envPath));
  if (!cfg.OPENAI_API_KEY?.trim())
    throw new Error('MISSING_EXISTING_PROJECT_KEY');
  createQualityOutput(plan);
  const entries: Parameters<typeof summarizeSilence>[0] = [];
  for (const run of plan.runs) {
    console.log(
      JSON.stringify({
        phase: 'silence_start',
        id: run.id,
        index: entries.length + 1,
        total: 4,
      }),
    );
    const item = plan.cases.find((candidate) => candidate.id === run.caseId)!;
    const result = await runQualitySession(item, run, {
      apiKey: cfg.OPENAI_API_KEY,
      proxyUrl: cfg.OPENAI_PROXY_URL || '',
    });
    saveQualityRun(plan.outputRoot, result);
    const evaluation = evaluateSilence(result);
    entries.push({ id: run.id, evaluation });
    writeFileSync(
      resolve(plan.outputRoot, run.id, 'silence-evaluation.json'),
      JSON.stringify(evaluation, null, 2),
      { flag: 'wx' },
    );
    writeFileSync(
      resolve(plan.outputRoot, 'silence-summary.json'),
      JSON.stringify(summarizeSilence(entries), null, 2),
    );
    console.log(
      JSON.stringify({
        phase: 'silence_complete',
        id: run.id,
        status: evaluation.status,
        failure: result.report.failure,
      }),
    );
    if (evaluation.status === 'INCONCLUSIVE') break;
  }
  const summary = summarizeSilence(entries);
  console.log(JSON.stringify(summary));
  if (summary.status !== 'SYNTHETIC_SILENCE_NO_ACTIVITY') process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      phase: 'silence_failed',
      failure: safeQualityError(error),
      realEnvironmentAccepted: false,
      phoneCallSucceeded: false,
    }),
  );
  process.exitCode = 1;
});
