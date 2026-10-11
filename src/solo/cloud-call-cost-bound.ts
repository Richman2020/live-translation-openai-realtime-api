import { createHash } from 'node:crypto';

// Version binds the existing 60 requests / 450k input proxies / 72k output
// reservations and fixed model/slot rules. Those proxies are NOT invoice units.
export const CLOUD_USAGE_POLICY = 'continuous-captions-usage-v2';
export const CLOUD_TRIAL_WINDOW_SECONDS = 3600;
const ERROR = 'CLOUD_CALL_COST_BOUND_REQUIRED';
const baseCharges = [
  'twilioBrowser',
  'twilioTarget',
  'twilioMediaStreams',
  'openaiTranslation',
  'openaiRemoteAsr',
  'openaiRemoteText',
  'taxesAndSurcharges',
  'inFlightAndTermination',
] as const;
const pairedCharges = ['openaiOutgoingAsr', 'openaiOutgoingText'] as const;

/** An externally reviewed, complete liability envelope, not a price estimate.
 * For every enabled charge, cost(D) <= fixed + perSecond * D, for all integer
 * D from 1 to maxSeconds. Fixed includes rounding, setup and unknown-result
 * termination exposure; model rows include ALL input/output, hidden tokens and
 * automatic VAD/ASR turns. Missing/unknown exposure is not representable as 0.
 * Software checks completeness/binding/math; it cannot verify a supplier bill.
 */
export type CloudCallCostEvidence = {
  version: 1;
  basis: 'complete-liability-upper-bound';
  usagePolicy: typeof CLOUD_USAGE_POLICY;
  accountSid: string;
  applicationSid: string;
  targetSha256: string;
  outgoingPairedCaptions: boolean;
  maxSeconds: number;
  cleanupSeconds: number;
  coverage: {
    allMeteredInputAndOutput: true;
    automaticVadAndAsr: true;
    roundingAndMinimums: true;
    taxesAndSurcharges: true;
    inFlightAndUnknownTermination: true;
  };
  charges: Record<
    string,
    {
      fixedUsdMicros: number;
      perSecondUsdMicros: number;
      evidenceUrl: string;
    }
  >;
};

export type CloudCallCostBound = Readonly<{
  usagePolicy: typeof CLOUD_USAGE_POLICY;
  evidenceDigest: string;
  outgoingPairedCaptions: boolean;
  maxCallSeconds: number;
  cleanupSeconds: number;
  admissionDeadline: number;
  reservationUsdMicros: number;
  upperBoundUsdMicros: number;
  pcmBytes: number;
  pcmuBytes: number;
  aggregateInputBytes: number;
  aggregateOutputBytes: number;
}>;

const integer = (
  n: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): n is number =>
  Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: unknown, keys: readonly string[]) =>
  record(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const deny = (): never => {
  throw new Error(ERROR);
};

export function cloudCallMediaLimits(seconds: number, paired: boolean) {
  if (
    !integer(seconds, 1, CLOUD_TRIAL_WINDOW_SECONDS) ||
    typeof paired !== 'boolean'
  )
    deny();
  const pcmBytes = seconds * 48000; // PCM16 mono, 24kHz; padding/drain included.
  const pcmuBytes = seconds * 8000; // PCMU mono, 8kHz.
  return {
    pcmBytes,
    pcmuBytes,
    // Include both ingress legs conservatively; each provider stream also has
    // its own PCM cap at the real send boundary, including padding and drain.
    aggregateInputBytes: pcmBytes * (paired ? 3 : 2) + 2 * pcmuBytes,
    aggregateOutputBytes: pcmBytes + pcmuBytes,
  };
}

/** Structural validation at every policy consumer; no unbounded numeric limits. */
export function validCloudCallCostBound(v: unknown): v is CloudCallCostBound {
  if (
    !record(v) ||
    v.usagePolicy !== CLOUD_USAGE_POLICY ||
    !/^[a-f0-9]{64}$/.test(v.evidenceDigest) ||
    typeof v.outgoingPairedCaptions !== 'boolean' ||
    !integer(v.maxCallSeconds, 1, CLOUD_TRIAL_WINDOW_SECONDS) ||
    !integer(v.cleanupSeconds, 1, CLOUD_TRIAL_WINDOW_SECONDS) ||
    !integer(v.admissionDeadline, 1) ||
    !integer(v.reservationUsdMicros, 2_000_001, 5_000_000) ||
    !integer(v.upperBoundUsdMicros, 1, v.reservationUsdMicros)
  )
    return false;
  const media = cloudCallMediaLimits(
    v.maxCallSeconds,
    v.outgoingPairedCaptions,
  );
  return Object.entries(media).every(([key, value]) => v[key] === value);
}

/** Pure/offline. Caller supplies existing identity/target and validated UTC dates.
 * No directory/model probe, provider request, credential or default price here.
 * The derived maximum is stable across restarts. A later reservation is shortened
 * by admissionDeadline in the durable journal, never given a fresh full window.
 */
export function deriveCloudCallCostBound(options: {
  evidence: unknown;
  accountSid: string;
  applicationSid: string;
  target: string;
  outgoingPairedCaptions: boolean;
  reservationUsdMicros: number;
  checkedAt: number;
  validUntil: number;
  serviceDeadline: number;
  now: number;
}): CloudCallCostBound {
  const e = options.evidence as CloudCallCostEvidence;
  if (
    !exactKeys(e, [
      'version',
      'basis',
      'usagePolicy',
      'accountSid',
      'applicationSid',
      'targetSha256',
      'outgoingPairedCaptions',
      'maxSeconds',
      'cleanupSeconds',
      'coverage',
      'charges',
    ]) ||
    e.version !== 1 ||
    e.basis !== 'complete-liability-upper-bound' ||
    e.usagePolicy !== CLOUD_USAGE_POLICY ||
    e.accountSid !== options.accountSid ||
    e.applicationSid !== options.applicationSid ||
    e.targetSha256 !==
      createHash('sha256').update(options.target).digest('hex') ||
    e.outgoingPairedCaptions !== options.outgoingPairedCaptions ||
    !integer(e.maxSeconds, 1, CLOUD_TRIAL_WINDOW_SECONDS) ||
    !integer(e.cleanupSeconds, 1, CLOUD_TRIAL_WINDOW_SECONDS) ||
    !integer(options.reservationUsdMicros, 2_000_001, 5_000_000) ||
    !integer(options.now, 0) ||
    !integer(options.checkedAt, 0, options.now) ||
    !integer(options.validUntil, options.now + 1) ||
    !integer(options.serviceDeadline, options.now + 1) ||
    options.validUntil - options.checkedAt > 86400000 ||
    !exactKeys(e.coverage, [
      'allMeteredInputAndOutput',
      'automaticVadAndAsr',
      'roundingAndMinimums',
      'taxesAndSurcharges',
      'inFlightAndUnknownTermination',
    ]) ||
    Object.values(e.coverage).some((v) => v !== true)
  )
    deny();
  const evidence = e as CloudCallCostEvidence;
  const names = [
    ...baseCharges,
    ...(options.outgoingPairedCaptions ? pairedCharges : []),
  ];
  if (!exactKeys(evidence.charges, names)) deny();
  let fixed = 0n;
  let perSecond = 0n;
  const rows = names.map((name) => {
    const row = evidence.charges[name];
    if (
      !exactKeys(row, [
        'fixedUsdMicros',
        'perSecondUsdMicros',
        'evidenceUrl',
      ]) ||
      !integer(row.fixedUsdMicros, 0) ||
      !integer(row.perSecondUsdMicros, 0) ||
      typeof row.evidenceUrl !== 'string' ||
      row.evidenceUrl.length > 2048
    )
      deny();
    try {
      const url = new URL(row.evidenceUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !url.hostname
      )
        deny();
    } catch {
      deny();
    }
    fixed += BigInt(row.fixedUsdMicros);
    perSecond += BigInt(row.perSecondUsdMicros);
    return [name, row.fixedUsdMicros, row.perSecondUsdMicros, row.evidenceUrl];
  });
  const budget = BigInt(options.reservationUsdMicros);
  if (fixed >= budget || perSecond <= 0n) deny();
  const affordable = (budget - fixed) / perSecond;
  const admissionDeadline =
    Math.min(options.serviceDeadline, options.validUntil) -
    evidence.cleanupSeconds * 1000;
  if (!integer(admissionDeadline, options.now + 1000)) deny();
  const windowSeconds = Math.floor(
    (admissionDeadline - options.checkedAt) / 1000,
  );
  const maxCallSeconds = Number(
    [affordable, BigInt(evidence.maxSeconds), BigInt(windowSeconds)].reduce(
      (a, b) => (a < b ? a : b),
    ),
  );
  if (!integer(maxCallSeconds, 1, CLOUD_TRIAL_WINDOW_SECONDS)) deny();
  const result: CloudCallCostBound = Object.freeze({
    usagePolicy: CLOUD_USAGE_POLICY,
    evidenceDigest: createHash('sha256')
      .update(
        JSON.stringify([
          evidence.version,
          evidence.basis,
          evidence.usagePolicy,
          evidence.accountSid,
          evidence.applicationSid,
          evidence.targetSha256,
          evidence.outgoingPairedCaptions,
          evidence.maxSeconds,
          evidence.cleanupSeconds,
          rows,
          options.checkedAt,
          options.validUntil,
          options.serviceDeadline,
        ]),
      )
      .digest('hex'),
    outgoingPairedCaptions: options.outgoingPairedCaptions,
    maxCallSeconds,
    cleanupSeconds: evidence.cleanupSeconds,
    admissionDeadline,
    reservationUsdMicros: options.reservationUsdMicros,
    upperBoundUsdMicros: Number(fixed + perSecond * BigInt(maxCallSeconds)),
    ...cloudCallMediaLimits(maxCallSeconds, options.outgoingPairedCaptions),
  });
  if (!validCloudCallCostBound(result)) deny();
  return result;
}
