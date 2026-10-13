import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  deriveCloudCallCostBound,
  cloudCallMediaLimits,
} from '../src/solo/cloud-call-cost-bound';
import {
  CloudBudgetJournal,
  type CloudTrialBudgetPolicy,
} from '../src/solo/cloud-budget-journal';
import type { CloudVoiceGrant } from '../src/solo/cloud-voice-join';
import { createCloudCallUsageBudget } from '../src/solo/cloud-call-usage';
import { syntheticCostEvidence } from './fixtures/cloud-cost-evidence';

const now = 100000;
const inputs = () => ({
  evidence: syntheticCostEvidence(),
  accountSid: `AC${'1'.repeat(32)}`,
  applicationSid: `AP${'3'.repeat(32)}`,
  target: '+12025550101',
  outgoingPairedCaptions: false,
  reservationUsdMicros: 5_000_000,
  checkedAt: now - 1000,
  validUntil: now + 3600000,
  serviceDeadline: now + 3600000,
  now,
});

test('complete synthetic envelope derives 600 seconds, never a five-minute or unlimited default', () => {
  const value = deriveCloudCallCostBound(inputs());
  assert.equal(value.maxCallSeconds, 600);
  assert.equal(value.upperBoundUsdMicros, 5_000_000);
  assert.equal(value.pcmBytes, 28_800_000);
  assert.equal(value.pcmuBytes, 4_800_000);
  assert.equal(value.aggregateInputBytes, 67_200_000);
  assert.equal(value.aggregateOutputBytes, 33_600_000);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(
    deriveCloudCallCostBound({ ...inputs(), reservationUsdMicros: 3_000_000 })
      .maxCallSeconds,
    200,
  );
  assert.equal(
    deriveCloudCallCostBound({ ...inputs(), reservationUsdMicros: 3_500_000 })
      .maxCallSeconds,
    300,
  );
  assert.equal(
    deriveCloudCallCostBound({ ...inputs(), reservationUsdMicros: 3_505_001 })
      .maxCallSeconds,
    301,
  );
});

test('every missing charge, unknown liability or incomplete coverage rejects instead of assuming a price', () => {
  for (const name of Object.keys(inputs().evidence.charges)) {
    const f = inputs();
    delete f.evidence.charges[name];
    assert.throws(
      () => deriveCloudCallCostBound(f),
      /CLOUD_CALL_COST_BOUND_REQUIRED/,
    );
  }
  for (const name of Object.keys(inputs().evidence.coverage)) {
    for (const unknown of [false, null, undefined]) {
      const f = inputs();
      (f.evidence.coverage as any)[name] = unknown;
      assert.throws(
        () => deriveCloudCallCostBound(f),
        /CLOUD_CALL_COST_BOUND_REQUIRED/,
      );
    }
  }
  for (const evidence of [
    undefined,
    null,
    {},
    { ...inputs().evidence, basis: 'estimated' },
  ])
    assert.throws(
      () => deriveCloudCallCostBound({ ...inputs(), evidence }),
      /CLOUD_CALL_COST_BOUND_REQUIRED/,
    );
});

test('bound is tied to account, exact destination, application, selected models and shared usage policy', () => {
  for (const change of [
    { accountSid: `AC${'2'.repeat(32)}` },
    { applicationSid: `AP${'4'.repeat(32)}` },
    { target: '+12025550102' },
    { outgoingPairedCaptions: true },
  ])
    assert.throws(
      () => deriveCloudCallCostBound({ ...inputs(), ...change }),
      /CLOUD_CALL_COST_BOUND_REQUIRED/,
    );
  const f = inputs();
  f.evidence.usagePolicy = 'older-usage-policy' as any;
  assert.throws(
    () => deriveCloudCallCostBound(f),
    /CLOUD_CALL_COST_BOUND_REQUIRED/,
  );
  const paired = deriveCloudCallCostBound({
    ...inputs(),
    evidence: syntheticCostEvidence(true),
    outgoingPairedCaptions: true,
  });
  assert.equal(paired.maxCallSeconds, 600);
  assert.equal(paired.aggregateInputBytes, 96_000_000);
  const missing = syntheticCostEvidence(true);
  delete missing.charges.openaiOutgoingAsr;
  assert.throws(() =>
    deriveCloudCallCostBound({
      ...inputs(),
      evidence: missing,
      outgoingPairedCaptions: true,
    }),
  );
});

test('integer arithmetic rejects malformed, overflowing, unaffordable and zero-slope evidence', () => {
  for (const invalid of [
    NaN,
    Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    null,
  ]) {
    const f = inputs();
    f.evidence.charges.twilioTarget.perSecondUsdMicros = invalid as number;
    assert.throws(
      () => deriveCloudCallCostBound(f),
      /CLOUD_CALL_COST_BOUND_REQUIRED/,
    );
  }
  for (const value of [0, Number.MAX_SAFE_INTEGER, 5_000_000]) {
    const f = inputs();
    f.evidence.charges.twilioTarget.perSecondUsdMicros = value;
    assert.throws(
      () => deriveCloudCallCostBound(f),
      /CLOUD_CALL_COST_BOUND_REQUIRED/,
    );
  }
  const f = inputs();
  f.evidence.charges.twilioBrowser.fixedUsdMicros = 5_000_000;
  assert.throws(
    () => deriveCloudCallCostBound(f),
    /CLOUD_CALL_COST_BOUND_REQUIRED/,
  );
  for (const value of [0, 1.1, 3601, Number.MAX_SAFE_INTEGER])
    assert.throws(() => cloudCallMediaLimits(value, true));
});

test('evidence validity and service cutoff leave cleanup time and never renew a restart window', () => {
  const f = inputs();
  const stable = deriveCloudCallCostBound(f);
  assert.deepEqual(
    deriveCloudCallCostBound({ ...f, now: now + 200000 }),
    stable,
  );
  const sooner = deriveCloudCallCostBound({ ...f, validUntil: now + 305000 });
  assert.equal(sooner.admissionDeadline, now + 300000);
  assert.equal(sooner.maxCallSeconds, 301); // checkedAt is one second before now.
  assert.throws(
    () => deriveCloudCallCostBound({ ...f, now: stable.admissionDeadline }),
    /CLOUD_CALL_COST_BOUND_REQUIRED/,
  );
  for (const change of [
    { checkedAt: now + 1 },
    { validUntil: now },
    { serviceDeadline: now + 5000 },
    { validUntil: now + 86400001 },
  ])
    assert.throws(() => deriveCloudCallCostBound({ ...f, ...change }));
});

test('evidence metadata changes bind the durable scope even at identical numeric limits', () => {
  const f = inputs();
  const before = deriveCloudCallCostBound(f);
  f.evidence.charges.twilioTarget.evidenceUrl =
    'https://example.test/updated-review';
  const after = deriveCloudCallCostBound(f);
  assert.equal(before.maxCallSeconds, after.maxCallSeconds);
  assert.notEqual(before.evidenceDigest, after.evidenceDigest);
});

function journalFixture(
  t: TestContext,
  overrides: Partial<ReturnType<typeof inputs>> = {},
) {
  const f = { ...inputs(), ...overrides };
  const bound = deriveCloudCallCostBound(f);
  const directory = mkdtempSync(join(tmpdir(), 'duration-journal-offline-'));
  let time = now;
  const policy: CloudTrialBudgetPolicy = {
    allowedTarget: f.target,
    accountSid: f.accountSid,
    applicationSid: f.applicationSid,
    budgetUsdMicros: 5_000_000,
    worstCaseCallUsdMicros: bound.reservationUsdMicros,
    maxCalls: 1,
    maxWallClockMs: bound.maxCallSeconds * 1000,
    maxInputBytes: bound.aggregateInputBytes,
    maxOutputBytes: bound.aggregateOutputBytes,
    lateCallbackWindowMs: 1000,
    costBound: bound,
    rates: {
      twilioReference: 'https://www.twilio.com/offline-only',
      openaiReference: 'https://openai.com/offline-only',
      checkedAt: f.checkedAt,
      validUntil: f.validUntil,
    },
  };
  const journals: CloudBudgetJournal[] = [];
  const open = (p = policy) => {
    const j = CloudBudgetJournal.open({
      directory,
      policy: p,
      now: () => time,
    });
    journals.push(j);
    return j;
  };
  const grant = (callId = 'call_one'): CloudVoiceGrant => ({
    version: 1,
    callId,
    identity: 'identity',
    authSessionId: 'session',
    principalId: 'principal',
    browserOwnerId: 'browser',
    authEpoch: 1,
    controller: { leaseId: 'lease', tabId: 'tab', epoch: 1 },
    issuedAt: time,
    expiresAt: time + 1000,
    authExpiresAt: time + 1000,
    tokenExpiresAt: time + 1000,
    incomingAllow: false,
    outgoingApplicationSid: f.applicationSid,
    outgoing: { callId, identity: 'identity' },
  });
  t.after(() => {
    journals.forEach((j) => j.close());
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    policy,
    bound,
    open,
    grant,
    advance: (n: number) => {
      time += n;
    },
    disk: () => readFileSync(join(directory, 'trial-budget.json'), 'utf8'),
    sentinel: () =>
      readFileSync(join(directory, 'trial-budget.initialized'), 'utf8'),
  };
}

test('600-second journal survives 300 seconds, serializes concurrent admission and remains exhausted after settlement/restart', async (t) => {
  const f = journalFixture(t);
  const j = f.open();
  const results = await Promise.allSettled([
    j.reserve(f.grant()),
    j.reserve(f.grant('call_two')),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected'],
  );
  f.advance(301000);
  assert.equal(j.callLimits('call_one').remainingWallClockMs, 299000);
  assert.equal(j.remainingUsdMicros, 0);
  j.confirmAbsent('call_one', 'local');
  j.confirmAbsent('call_one', 'remote');
  j.confirmUsage('call_one', 1);
  assert.equal(results[0].status, 'fulfilled');
  if (results[0].status === 'fulfilled') await results[0].value.release();
  j.settle('call_one');
  await assert.rejects(j.reserve(f.grant('call_three')), /BUDGET_EXHAUSTED/);
  j.close();
  const reopened = f.open();
  assert.equal(reopened.remainingUsdMicros, 0);
  await assert.rejects(
    reopened.reserve(f.grant('call_four')),
    /BUDGET_EXHAUSTED/,
  );
  assert.equal(JSON.parse(f.disk()).chargedUsdMicros, 5_000_000);
});

test('later reservation gets only the remaining absolute window, then cannot create a one-second overrun', async (t) => {
  const f = journalFixture(t, { serviceDeadline: now + 360000 });
  const j = f.open();
  f.advance(300000);
  await j.reserve(f.grant());
  assert.deepEqual(j.callLimits('call_one'), {
    deadline: now + 355000,
    remainingWallClockMs: 55000,
  });
  f.advance(55000);
  assert.throws(() => j.assertCallCurrent('call_one'), /BUDGET_LIMIT_REACHED/);
});

test('reopening an unresolved long call preserves full charges and unknown two-leg responsibility', async (t) => {
  const f = journalFixture(t);
  const j = f.open();
  await j.reserve(f.grant());
  j.beginCreate('call_one', 'local');
  j.beginCreate('call_one', 'remote', f.policy.allowedTarget);
  j.markUnknown('call_one', 'remote');
  j.close();
  f.advance(301000);
  const reopened = f.open();
  assert.equal(reopened.remainingUsdMicros, 0);
  assert.equal(reopened.cleanupRequired, true);
  const disk = JSON.parse(f.disk());
  assert.equal(disk.intents[0].remote.phase, 'unknown');
  assert.equal(disk.intents[0].local.phase, 'started');
  await assert.rejects(
    reopened.reserve(f.grant('next')),
    /BUDGET_CLEANUP_REQUIRED/,
  );
});

test('old journal schema/digest remains readable for recovery; new policy cannot migrate or refill it', async (t) => {
  const f = journalFixture(t);
  const old = {
    ...f.policy,
    costBound: undefined,
    maxWallClockMs: 300000,
    maxInputBytes: 72_000_000,
    maxOutputBytes: 72_000_000,
  };
  const j = f.open(old);
  await j.reserve(f.grant());
  j.close();
  const disk = f.disk(),
    sentinel = f.sentinel();
  assert.throws(() => f.open(), /BUDGET_NOT_READY/);
  assert.equal(f.disk(), disk);
  assert.equal(f.sentinel(), sentinel);
  const legacy = f.open(old);
  assert.equal(legacy.remainingUsdMicros, 0);
  assert.equal(legacy.cleanupRequired, true);
  assert.equal(JSON.parse(f.disk()).version, 1);
});

test('changed duration, evidence or shared limits reject existing scope without touching its ledger', async (t) => {
  const f = journalFixture(t);
  f.open().close();
  const before = f.disk();
  assert.throws(
    () => f.open({ ...f.policy, maxWallClockMs: 301000 }),
    /BUDGET_NOT_READY/,
  );
  assert.throws(
    () => f.open({ ...f.policy, maxInputBytes: f.policy.maxInputBytes + 1 }),
    /BUDGET_NOT_READY/,
  );
  assert.throws(
    () =>
      f.open({
        ...f.policy,
        costBound: { ...f.bound, evidenceDigest: 'a'.repeat(64) },
      }),
    /BUDGET_NOT_READY/,
  );
  assert.equal(f.disk(), before);
});

test('600-second per-stream quotas include exact PCM and PCMU boundaries without changing text allowance or invoice claims', () => {
  for (const path of ['native_translation', 'return_original'] as const) {
    const b = createCloudCallUsageBudget({
      reservationUsdMicros: 5_000_000,
      outgoingPairedCaptions: true,
      maxWallClockMs: 600000,
    });
    const bytes = path === 'native_translation' ? 28_800_000 : 4_800_000;
    b.consumePlayback({ path, bytes });
    assert.throws(
      () => b.consumePlayback({ path, bytes: 2 }),
      /CLOUD_CALL_USAGE_REJECTED/,
    );
    assert.equal(b.snapshot.costBoundVerified, false);
    assert.equal(b.snapshot.billed, false);
    assert.equal(b.snapshot.textRequests, 0);
    assert.equal(b.snapshot.maxWallClockMs, 600000);
  }
});
