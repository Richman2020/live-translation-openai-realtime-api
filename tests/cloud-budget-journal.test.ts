import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';

import {
  CloudBudgetJournal,
  type CloudTrialBudgetPolicy,
} from '../src/solo/cloud-budget-journal';
import type { CloudVoiceGrant } from '../src/solo/cloud-voice-join';

// Offline fixtures ONLY. The URLs label synthetic evidence; these tests do not
// establish real rates, use credentials or contact any provider.
function fixture(
  t: TestContext,
  overrides: Partial<CloudTrialBudgetPolicy> = {},
) {
  const parent = mkdtempSync(join(tmpdir(), 'phone-budget-'));
  const directory = join(parent, 'journal');
  let now = 100_000;
  const policy: CloudTrialBudgetPolicy = {
    allowedTarget: '+12025550123',
    accountSid: `AC${'a'.repeat(32)}`,
    applicationSid: `AP${'a'.repeat(32)}`,
    budgetUsdMicros: 5_000_000,
    worstCaseCallUsdMicros: 2_500_000,
    maxCalls: 2,
    maxWallClockMs: 5000,
    maxInputBytes: 320,
    maxOutputBytes: 320,
    lateCallbackWindowMs: 1000,
    rates: {
      twilioReference: 'https://www.twilio.com/synthetic-test',
      openaiReference: 'https://openai.com/synthetic-test',
      checkedAt: 90_000,
      validUntil: 200_000,
    },
    ...overrides,
  };
  const handles: CloudBudgetJournal[] = [];
  const open = () => {
    const journal = CloudBudgetJournal.open({
      directory,
      policy,
      now: () => now,
    });
    handles.push(journal);
    return journal;
  };
  t.after(() => {
    for (const handle of handles) {
      try {
        handle.close();
      } catch {}
    }
    rmSync(parent, { recursive: true, force: true });
  });
  const grant = (
    callId = 'call_one',
    changes: Partial<CloudVoiceGrant> = {},
  ): CloudVoiceGrant => ({
    version: 1,
    authSessionId: 'session_one',
    principalId: 'principal_one',
    browserOwnerId: 'browser_one',
    authEpoch: 1,
    controller: { leaseId: 'lease_one', tabId: 'tab_one', epoch: 1 },
    callId,
    identity: 'voice_one',
    issuedAt: now,
    expiresAt: now + 1000,
    incomingAllow: false,
    outgoingApplicationSid: policy.applicationSid,
    outgoing: { callId, identity: 'voice_one' },
    ...changes,
  });
  return {
    parent,
    directory,
    policy,
    open,
    grant,
    advance: (ms: number) => {
      now += ms;
    },
    disk: () =>
      JSON.parse(readFileSync(join(directory, 'trial-budget.json'), 'utf8')),
  };
}

test('reservation and both creation intents commit together before a permission is returned; journal is private and redacted', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const reservation = await journal.reserve(f.grant());
  reservation.assertCurrent();
  const disk = f.disk();
  assert.equal(disk.chargedUsdMicros, 2_500_000);
  assert.equal(disk.intents.length, 1);
  assert.deepEqual(
    [disk.intents[0].local.phase, disk.intents[0].remote.phase],
    ['planned', 'planned'],
  );
  assert.match(disk.intents[0].ownerDigest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(disk).includes(f.policy.allowedTarget));
  assert.ok(!JSON.stringify(disk).includes('session_one'));
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(
    statSync(join(f.directory, 'trial-budget.json')).mode & 0o777,
    0o600,
  );
});

test('one live call and exact grant are idempotent; cross owner/epoch cannot reuse a reservation', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const grant = f.grant();
  const first = await journal.reserve(grant);
  assert.equal(await journal.reserve(grant), first);
  assert.equal(f.disk().intents.length, 1);
  await assert.rejects(
    journal.reserve(f.grant('call_one', { authEpoch: 2 })),
    /BUDGET_NOT_READY/,
  );
  await assert.rejects(
    journal.reserve(f.grant('call_one', { browserOwnerId: 'other_browser' })),
    /BUDGET_NOT_READY/,
  );
  await assert.rejects(
    journal.reserve(f.grant('call_two')),
    /BUDGET_CLEANUP_REQUIRED/,
  );
});

test('dialing is target allowlisted and each role starts once only after a durable intent', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  await journal.reserve(f.grant());
  assert.throws(
    () => journal.beginCreate('call_one', 'remote', '+12025550124'),
    /BUDGET_NOT_READY/,
  );
  assert.equal(f.disk().intents[0].remote.phase, 'planned');
  const key = journal.beginCreate('call_one', 'remote', f.policy.allowedTarget);
  assert.match(key, /_remote$/);
  assert.equal(f.disk().intents[0].remote.phase, 'started');
  assert.throws(
    () => journal.beginCreate('call_one', 'remote', f.policy.allowedTarget),
    /BUDGET_NOT_READY/,
  );
  journal.beginCreate('call_one', 'local');
  assert.equal(f.disk().intents[0].local.phase, 'started');
});

test('release invalidates immediately but never refunds, settles usage or erases a late-SID responsibility', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  journal.beginCreate('call_one', 'local');
  await held.release();
  assert.throws(() => held.assertCurrent(), /BUDGET_LIMIT_REACHED/);
  assert.equal(journal.remainingUsdMicros, 2_500_000);
  assert.equal(journal.cleanupRequired, true);
  await assert.rejects(
    journal.reserve(f.grant('call_two')),
    /BUDGET_CLEANUP_REQUIRED/,
  );
  journal.recordCreated('call_one', 'local', `CA${'1'.repeat(32)}`);
  assert.equal(f.disk().intents[0].phase, 'cleanup');
  assert.equal(f.disk().intents[0].local.phase, 'created');
  assert.throws(() => journal.settle('call_one'), /BUDGET_CLEANUP_REQUIRED/);
});

test('reopening keeps charges and converts a previously live reservation to cleanup-only with no restored handle', async (t) => {
  const f = fixture(t);
  const first = f.open();
  const grant = f.grant();
  const held = await first.reserve(grant);
  first.beginCreate('call_one', 'remote', f.policy.allowedTarget);
  first.close();
  assert.throws(() => held.assertCurrent(), /BUDGET_NOT_READY/);
  const reopened = f.open();
  assert.equal(reopened.remainingUsdMicros, 2_500_000);
  assert.equal(reopened.cleanupRequired, true);
  assert.equal(f.disk().intents[0].phase, 'cleanup');
  assert.equal(f.disk().intents[0].remote.phase, 'started');
  await assert.rejects(reopened.reserve(grant), /BUDGET_NOT_READY/);
  await assert.rejects(
    reopened.reserve(f.grant('call_two')),
    /BUDGET_CLEANUP_REQUIRED/,
  );
});

test('unknown create and unknown usage freeze all new admission; they are not interpreted as a free attempt', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  journal.beginCreate('call_one', 'remote', f.policy.allowedTarget);
  journal.markUnknown('call_one', 'remote');
  assert.throws(() => held.assertCurrent(), /BUDGET_LIMIT_REACHED/);
  assert.equal(f.disk().frozen, true);
  assert.equal(f.disk().intents[0].remote.phase, 'unknown');
  await assert.rejects(
    journal.reserve(f.grant('call_two')),
    /BUDGET_CLEANUP_REQUIRED/,
  );
  journal.markUnknown('call_one');
  assert.equal(f.disk().intents[0].usage, 'unknown');
});

test('a conflicting late SID is retained independently and must itself be terminated before settlement', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  const sid = `CA${'1'.repeat(32)}`;
  const late = `CA${'2'.repeat(32)}`;
  journal.beginCreate('call_one', 'local');
  journal.recordCreated('call_one', 'local', sid);
  await held.release();
  assert.throws(
    () => journal.recordCreated('call_one', 'local', late),
    /BUDGET_NOT_READY/,
  );
  assert.equal(f.disk().intents[0].local.sid, sid);
  assert.deepEqual(f.disk().intents[0].extraSids, [
    { role: 'local', sid: late, terminal: false },
  ]);
  journal.confirmTerminal('call_one', 'local', sid);
  journal.confirmAbsent('call_one', 'remote');
  journal.confirmUsage('call_one', 100);
  f.advance(2000);
  assert.throws(() => journal.settle('call_one'), /BUDGET_CLEANUP_REQUIRED/);
  journal.confirmTerminal('call_one', 'local', late);
  journal.settle('call_one');
  assert.equal(journal.cleanupRequired, false);
  assert.equal(journal.remainingUsdMicros, 2_500_000);
});

test('safe settlement requires confirmed legs, measured usage and the whole issued-ticket late window; budget and attempts never refill', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  for (const callId of ['call_one', 'call_two']) {
    const held = await journal.reserve(f.grant(callId));
    await held.release();
    journal.confirmAbsent(callId, 'local');
    journal.confirmAbsent(callId, 'remote');
    journal.confirmUsage(callId, 100);
    assert.throws(() => journal.settle(callId), /BUDGET_CLEANUP_REQUIRED/);
    f.advance(2000);
    journal.settle(callId);
  }
  assert.equal(journal.remainingUsdMicros, 0);
  assert.equal(f.disk().chargedUsdMicros, 5_000_000);
  await assert.rejects(
    journal.reserve(f.grant('call_three')),
    /BUDGET_EXHAUSTED/,
  );
});

test('over-reservation usage is frozen, never hidden by a successful release', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  assert.throws(
    () => journal.confirmUsage('call_one', 2_500_001),
    /BUDGET_NOT_READY/,
  );
  await held.release();
  assert.equal(f.disk().frozen, true);
  assert.equal(f.disk().intents[0].usage, 'unknown');
  await assert.rejects(
    journal.reserve(f.grant('call_two')),
    /BUDGET_CLEANUP_REQUIRED/,
  );
});

test('combined input/output gates reject excess before forwarding, and the wall-clock allowance cannot be renewed', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  journal.consumeMedia('call_one', 'input', 160);
  journal.consumeMedia('call_one', 'input', 160);
  journal.consumeMedia('call_one', 'output', 320);
  assert.throws(
    () => journal.consumeMedia('call_one', 'output', 1),
    /BUDGET_LIMIT_REACHED/,
  );
  assert.throws(() => held.assertCurrent(), /BUDGET_LIMIT_REACHED/);
  assert.equal(journal.cleanupRequired, true);
});

test('absolute call deadline and stale rate evidence reject current authorization synchronously', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  assert.deepEqual(journal.callLimits('call_one'), {
    deadline: 105_000,
    remainingWallClockMs: 5000,
  });
  f.advance(1000);
  assert.deepEqual(journal.callLimits('call_one'), {
    deadline: 105_000,
    remainingWallClockMs: 4000,
  });
  journal.assertCallCurrent('call_one');
  f.advance(4000);
  assert.throws(() => held.assertCurrent(), /BUDGET_LIMIT_REACHED/);
  assert.throws(
    () => journal.assertCallCurrent('call_one'),
    /BUDGET_LIMIT_REACHED/,
  );
  assert.throws(() => journal.callLimits('call_one'), /BUDGET_LIMIT_REACHED/);
  f.advance(100_000);
  assert.throws(
    () => journal.assertTarget(f.policy.allowedTarget),
    /BUDGET_NOT_READY/,
  );
});

test('validated native output chunks are allowed; zero-byte connects use a separate gate and malformed chunks are rejected', async (t) => {
  const f = fixture(t, { maxInputBytes: 100_000, maxOutputBytes: 1_000_000 });
  const journal = f.open();
  await journal.reserve(f.grant());
  journal.assertCallCurrent('call_one');
  journal.consumeMedia('call_one', 'output', 786_432);
  assert.throws(
    () => journal.consumeMedia('call_one', 'input', 0),
    /BUDGET_NOT_READY/,
  );
  assert.throws(
    () => journal.consumeMedia('call_one', 'input', 48_001),
    /BUDGET_NOT_READY/,
  );
  assert.throws(
    () => journal.consumeMedia('call_one', 'output', 1_048_577),
    /BUDGET_NOT_READY/,
  );
  assert.throws(
    () => journal.consumeMedia('call_one', 'input', NaN),
    /BUDGET_NOT_READY/,
  );
  journal.assertCallCurrent('call_one');
});

test('missing/unverified configuration, over-$5 budget, unexpected account/application and invalid grant do not create permission', async (t) => {
  for (const changes of [
    { budgetUsdMicros: 5_000_001 },
    { allowedTarget: '+442071234567' },
    { rates: undefined },
    { maxWallClockMs: 300_001 },
  ] as Partial<CloudTrialBudgetPolicy>[]) {
    const f = fixture(t, changes);
    assert.throws(() => f.open(), /BUDGET_NOT_READY/);
  }
  const f = fixture(t);
  const journal = f.open();
  await assert.rejects(
    journal.reserve(
      f.grant('call_one', { outgoingApplicationSid: `AP${'b'.repeat(32)}` }),
    ),
    /BUDGET_NOT_READY/,
  );
  await assert.rejects(
    journal.reserve(f.grant('call_one', { incomingAllow: true } as any)),
    /BUDGET_NOT_READY/,
  );
  assert.equal(f.disk().intents.length, 0);
});

test('an exclusive private-volume lock never auto-steals from a live or stale holder', (t) => {
  const f = fixture(t);
  const journal = f.open();
  assert.throws(() => f.open(), /BUDGET_LOCKED/);
  journal.close();
  writeFileSync(join(f.directory, 'trial-budget.lock'), '{"pid":9999999}', {
    mode: 0o600,
  });
  assert.throws(() => f.open(), /BUDGET_LOCKED/);
  rmSync(join(f.directory, 'trial-budget.lock'));
  const reopened = f.open();
  assert.equal(reopened.remainingUsdMicros, 5_000_000);
});

test('corrupt, public, symlinked or policy-swapped ledgers cannot silently reset the budget', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  await journal.reserve(f.grant());
  journal.close();
  const old = readFileSync(join(f.directory, 'trial-budget.json'));
  writeFileSync(join(f.directory, 'trial-budget.json'), '{"version":1}');
  assert.throws(() => f.open(), /BUDGET_NOT_READY/);
  writeFileSync(join(f.directory, 'trial-budget.json'), old);
  chmodSync(join(f.directory, 'trial-budget.json'), 0o644);
  assert.throws(() => f.open(), /BUDGET_NOT_READY/);
  chmodSync(join(f.directory, 'trial-budget.json'), 0o600);
  assert.throws(
    () =>
      CloudBudgetJournal.open({
        directory: f.directory,
        policy: { ...f.policy, allowedTarget: '+12025550124' },
        now: () => 100_000,
      }),
    /BUDGET_NOT_READY/,
  );
  const alias = join(f.parent, 'alias');
  symlinkSync(f.directory, alias);
  assert.throws(
    () =>
      CloudBudgetJournal.open({
        directory: alias,
        policy: f.policy,
        now: () => 100_000,
      }),
    /BUDGET_NOT_READY/,
  );
});

test('an uncertain atomic commit failure permanently fences the current process; restoring disk does not resume media or permit a retry', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  const held = await journal.reserve(f.grant());
  const file = join(f.directory, 'trial-budget.json');
  const saved = join(f.directory, 'old.json');
  renameSync(file, saved);
  mkdirSync(file);
  assert.throws(
    () => journal.beginCreate('call_one', 'local'),
    /BUDGET_NOT_READY/,
  );
  rmSync(file, { recursive: true });
  renameSync(saved, file);
  assert.throws(() => held.assertCurrent(), /BUDGET_NOT_READY/);
  await assert.rejects(
    journal.reserve(f.grant('call_two')),
    /BUDGET_NOT_READY/,
  );
  assert.equal(f.disk().intents[0].local.phase, 'planned');
  assert.equal(f.disk().chargedUsdMicros, 2_500_000);
});

test('a deleted ledger or corrupted initialization sentinel never recreates unused trial credit', async (t) => {
  const f = fixture(t);
  const journal = f.open();
  await journal.reserve(f.grant());
  journal.close();
  const file = join(f.directory, 'trial-budget.json');
  const old = readFileSync(file);
  rmSync(file);
  assert.throws(() => f.open(), /BUDGET_NOT_READY/);
  assert.throws(() => readFileSync(file), /ENOENT/);
  writeFileSync(file, old, { mode: 0o600 });
  writeFileSync(join(f.directory, 'trial-budget.initialized'), '0'.repeat(64));
  assert.throws(() => f.open(), /BUDGET_NOT_READY/);
  assert.equal(f.disk().chargedUsdMicros, 2_500_000);
});
