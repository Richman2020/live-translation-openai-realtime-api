import { createHash } from 'node:crypto';
import {
  CLOUD_USAGE_POLICY,
  type CloudCallCostEvidence,
  deriveCloudCallCostBound,
} from '../../src/solo/cloud-call-cost-bound';

/** SYNTHETIC ONLY. These integers are chosen for boundary tests, NOT provider
 * prices or completed real-world evidence. Never use this fixture in runtime. */
export function syntheticCostEvidence(
  paired = false,
  identity = {
    accountSid: `AC${'1'.repeat(32)}`,
    applicationSid: `AP${'3'.repeat(32)}`,
    target: '+12025550101',
  },
): CloudCallCostEvidence {
  const names = [
    'twilioBrowser',
    'twilioTarget',
    'twilioMediaStreams',
    'openaiTranslation',
    'openaiRemoteAsr',
    'openaiRemoteText',
    'taxesAndSurcharges',
    'inFlightAndTermination',
    ...(paired ? ['openaiOutgoingAsr', 'openaiOutgoingText'] : []),
  ];
  return {
    version: 1,
    basis: 'complete-liability-upper-bound',
    usagePolicy: CLOUD_USAGE_POLICY,
    accountSid: identity.accountSid,
    applicationSid: identity.applicationSid,
    targetSha256: createHash('sha256').update(identity.target).digest('hex'),
    outgoingPairedCaptions: paired,
    maxSeconds: 3600,
    cleanupSeconds: 5,
    coverage: {
      allMeteredInputAndOutput: true,
      automaticVadAndAsr: true,
      roundingAndMinimums: true,
      taxesAndSurcharges: true,
      inFlightAndUnknownTermination: true,
    },
    // Total fixed 2M, total slope 5000 microUSD/sec => exactly 600s at $5.
    charges: Object.fromEntries(
      names.map((name, index) => [
        name,
        {
          fixedUsdMicros: index === 0 ? 2_000_000 : 0,
          perSecondUsdMicros: index === 1 ? 5000 : 0,
          evidenceUrl: 'https://example.test/synthetic-offline-only',
        },
      ]),
    ),
  };
}

export function syntheticCostBound(now = 100000, paired = true) {
  const identity = {
    accountSid: `AC${'a'.repeat(32)}`,
    applicationSid: `AP${'a'.repeat(32)}`,
    target: '+14155550123',
  };
  return deriveCloudCallCostBound({
    evidence: syntheticCostEvidence(paired, identity),
    ...identity,
    outgoingPairedCaptions: paired,
    reservationUsdMicros: 5_000_000,
    checkedAt: now - 1000,
    validUntil: now + 3600000,
    serviceDeadline: now + 3600000,
    now,
  });
}
