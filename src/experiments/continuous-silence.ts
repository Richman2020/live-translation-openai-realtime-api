/** Synthetic silence only: no microphone, phone or real-environment acceptance. */
import { createHash } from 'node:crypto';

import {
  type QualityPlan,
  type QualityRun,
  type PreparedQualityCase,
  type runQualitySession,
  validatePrivateQualityOutput,
} from './continuous-quality-matrix';

export type SilenceEvaluation = {
  status: 'FAIL' | 'INCONCLUSIVE' | 'SYNTHETIC_SILENCE_NO_ACTIVITY';
  reason: string;
  hasOutputText: boolean;
  rawEnergyDetected: boolean;
  phoneEnergyDetected: boolean;
  thresholdRms: 300;
  frameMs: 20;
  realEnvironmentAccepted: false;
  phoneCallSucceeded: false;
};

export function prepareSilencePlan(args: string[], cwd = process.cwd()) {
  let output: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dry-run' && !dryRun) dryRun = true;
    else if (
      flag === '--out' &&
      !output &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    ) {
      output = args[index + 1];
      index += 1;
    } else throw new Error('USE_PRIVATE_OUT_AND_OPTIONAL_DRY_RUN');
  }
  if (!output) throw new Error('REQUIRE_PRIVATE_OUT');
  const outputRoot = validatePrivateQualityOutput(cwd, output);
  const input = Buffer.alloc(8 * 8000, 0xff);
  const inputSha256 = createHash('sha256').update(input).digest('hex');
  const cases: PreparedQualityCase[] = (['en', 'zh'] as const).map(
    (language) => ({
      id: `silence-${language}`,
      role: language === 'en' ? 'local' : 'remote',
      inputFile: 'generated-eight-seconds-digital-silence',
      sourceText: '',
      expectedTranslation: '',
      targetLanguage: language,
      kind: 'short',
      input: Buffer.from(input),
      inputSha256,
    }),
  );
  const runs: QualityRun[] = cases.flatMap((item) =>
    (['off', 'near_field'] as const).map((condition) => ({
      id: `${item.id}-${condition}`,
      caseId: item.id,
      repetition: 1,
      condition,
      inputSha256,
    })),
  );
  const plan: QualityPlan = {
    kind: 'synthetic',
    cases,
    runs,
    repeat: 1,
    outputRoot,
  };
  return { plan, dryRun };
}

export function silenceDryRun(plan: QualityPlan) {
  return {
    version: 'continuous-silence/1',
    phase: 'dry_run',
    runCount: 4,
    sourceSilenceMs: 8000,
    prefixSilenceMs: 300,
    suffixSilenceMs: 4000,
    totalStreamSeconds: 49.2,
    inputs: plan.cases.map((item) => ({
      id: item.id,
      inputBytes: item.input.length,
      inputSha256: item.inputSha256,
    })),
    runs: plan.runs,
    credentialsRead: false,
    networkUsed: false,
    writesPerformed: false,
    realEnvironmentAccepted: false,
    phoneCallSucceeded: false,
  };
}

function rawPcmEnergy(pcm: Buffer): boolean {
  // Provider 24 kHz mono PCM16, 20 ms windows, including a partial final frame.
  for (let offset = 0; offset < pcm.length; offset += 960) {
    const end = Math.min(offset + 960, pcm.length);
    let sum = 0;
    for (let index = offset; index < end; index += 2) {
      const value = pcm.readInt16LE(index);
      sum += value * value;
    }
    if (Math.sqrt(sum / ((end - offset) / 2)) >= 300) return true;
  }
  return false;
}

export function evaluateSilence(
  result: Awaited<ReturnType<typeof runQualitySession>>,
): SilenceEvaluation {
  const hasOutputText = Boolean(result.report.outputTranscript.trim());
  const rawEnergyDetected =
    result.rawPcm.length % 2 === 0 && rawPcmEnergy(result.rawPcm);
  const phoneEnergyDetected = result.report.energy.firstEnergyAtMs !== null;
  const base = {
    hasOutputText,
    rawEnergyDetected,
    phoneEnergyDetected,
    thresholdRms: 300 as const,
    frameMs: 20 as const,
    realEnvironmentAccepted: false as const,
    phoneCallSucceeded: false as const,
  };
  if (
    !result.report.providerDrainConfirmed ||
    (result.report.failure !== null &&
      result.report.failure !== 'NO_CONTINUOUS_AUDIO') ||
    result.rawPcm.length % 2 !== 0
  ) {
    return {
      ...base,
      status: 'INCONCLUSIVE',
      reason: 'PROVIDER_DRAIN_OR_TRANSPORT_NOT_CONFIRMED',
    };
  }
  if (hasOutputText || rawEnergyDetected || phoneEnergyDetected)
    return {
      ...base,
      status: 'FAIL',
      reason: 'OUTPUT_ACTIVITY_ON_SYNTHETIC_SILENCE',
    };
  return {
    ...base,
    status: 'SYNTHETIC_SILENCE_NO_ACTIVITY',
    reason: 'NO_OUTPUT_TEXT_OR_ENERGY_ON_THIS_DIGITAL_SILENCE_FIXTURE',
  };
}

export function summarizeSilence(
  entries: { id: string; evaluation: SilenceEvaluation }[],
) {
  const inconclusive = entries.some(
    (item) => item.evaluation.status === 'INCONCLUSIVE',
  );
  const activityDetected = entries.some(
    (item) => item.evaluation.status === 'FAIL',
  );
  let status: SilenceEvaluation['status'] = 'SYNTHETIC_SILENCE_NO_ACTIVITY';
  if (activityDetected) status = 'FAIL';
  if (inconclusive || entries.length !== 4) status = 'INCONCLUSIVE';
  return {
    version: 'continuous-silence/1',
    plannedRuns: 4,
    attemptedRuns: entries.length,
    status,
    activityDetected,
    stoppedOnInconclusive: inconclusive,
    entries,
    realEnvironmentAccepted: false,
    phoneCallSucceeded: false,
    limitations: [
      'DIGITAL_SILENCE_DOES_NOT_TEST_BACKGROUND_NOISE_OR_ECHO',
      'NO_AUDIO_IS_NOT_A_SUCCESSFUL_PHONE_CALL',
      'NO_AUTOMATIC_RETRY',
    ],
  };
}
