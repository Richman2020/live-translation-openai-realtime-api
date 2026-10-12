import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

import {
  createQualityOutput,
  parseQualityArguments,
  prepareQualityPlan,
  qualityDryRunSummary,
  runQualitySession,
  safeQualityError,
  saveQualityRun,
  summarizeQualityRuns,
} from '../src/experiments/continuous-quality-matrix';
import {
  beginQualityAttempt,
  copyQualityResume,
  extractQualityResumeArgument,
  finishQualityAttempt,
  isContinuableQualityFailure,
  validateQualityResume,
} from '../src/experiments/quality-resume';

// Explicit isolated experiment, never called by the phone server. Dry-run reads
// neither .env nor any provider, and never writes files. All real inputs are
// validated before reading the already-authorized project key or opening WS.
async function main() {
  const extracted = extractQualityResumeArgument(process.argv.slice(2));
  const args = parseQualityArguments(extracted.args);
  const plan = prepareQualityPlan(args);
  const resume = extracted.resumeFrom
    ? validateQualityResume(plan, extracted.resumeFrom)
    : undefined;
  if (args.dryRun) {
    console.log(
      JSON.stringify({
        ...qualityDryRunSummary(plan),
        preservedAttempts: resume?.reports.length ?? 0,
        remainingPaidRequests: plan.runs.length - (resume?.reports.length ?? 0),
        explicitQualityFailureContinuation: Boolean(resume),
      }),
    );
    return;
  }
  const cfg = parse(readFileSync(resolve('.env')));
  if (!cfg.OPENAI_API_KEY?.trim())
    throw new Error('MISSING_EXISTING_PROJECT_KEY');
  createQualityOutput(plan);
  if (resume) copyQualityResume(plan, resume);
  const reports: Awaited<ReturnType<typeof runQualitySession>>['report'][] = [
    ...(resume?.reports ?? []),
  ];
  let stoppedEarly = false;
  const summary = () => ({
    ...summarizeQualityRuns(plan, reports),
    stoppedOnFailure: stoppedEarly && reports.length < plan.runs.length,
    hasFailures: reports.some((report) => Boolean(report.failure)),
    resumedAttempts: resume?.reports.length ?? 0,
    completedMatrix: reports.length === plan.runs.length,
  });
  if (resume)
    writeFileSync(
      resolve(plan.outputRoot, 'summary.json'),
      JSON.stringify(summary(), null, 2),
      { flag: 'wx' },
    );
  for (const run of plan.runs.slice(reports.length)) {
    beginQualityAttempt(plan.outputRoot, run);
    console.log(
      JSON.stringify({
        phase: 'start',
        id: run.id,
        index: reports.length + 1,
        total: plan.runs.length,
      }),
    );
    const item = plan.cases.find((candidate) => candidate.id === run.caseId)!;
    const result = await runQualitySession(item, run, {
      apiKey: cfg.OPENAI_API_KEY,
      proxyUrl: cfg.OPENAI_PROXY_URL || '',
    });
    saveQualityRun(plan.outputRoot, result);
    reports.push(result.report);
    stoppedEarly =
      Boolean(result.report.failure) &&
      !(resume && isContinuableQualityFailure(result.report));
    console.log(
      JSON.stringify({
        phase: 'complete',
        id: run.id,
        completed: result.report.completed,
        failure: result.report.failure,
        inputBytes: result.report.sentInputBytes,
        outputBytes: result.report.rawOutputBytes,
      }),
    );
    writeFileSync(
      resolve(plan.outputRoot, 'summary.json'),
      JSON.stringify(summary(), null, 2),
    );
    finishQualityAttempt(plan.outputRoot, run);
    if (stoppedEarly) {
      process.exitCode = 1;
      break;
    }
  }
  console.log(
    JSON.stringify({
      phase: 'matrix_complete',
      ...summary(),
    }),
  );
  if (reports.some((report) => report.failure)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify({ phase: 'failed', failure: safeQualityError(error) }),
  );
  process.exitCode = 1;
});
