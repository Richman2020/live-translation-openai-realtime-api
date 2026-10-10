/* eslint-disable max-classes-per-file -- Keep the fail-closed error beside the file-backed admission. */
/* eslint-disable no-bitwise -- POSIX private modes and O_NOFOLLOW flags are security checks. */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  CloudVoiceAdmission,
  CloudVoiceGrant,
  CloudVoiceReservation,
} from './cloud-voice-join';

const MAX_BUDGET_USD_MICROS = 5_000_000;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sidPattern = /^CA[0-9a-fA-F]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
type Role = 'local' | 'remote';
type Leg = {
  phase: 'planned' | 'started' | 'unknown' | 'created' | 'terminal' | 'absent';
  sid?: string;
};
type Intent = {
  callId: string;
  reservationId: string;
  operationKey: string;
  grantDigest: string;
  ownerDigest: string;
  phase: 'reserved' | 'cleanup' | 'settled';
  reservedUsdMicros: number;
  deadline: number;
  liabilityUntil: number;
  local: Leg;
  remote: Leg;
  usage: 'pending' | 'unknown' | 'confirmed';
  usageUsdMicros?: number;
  extraSids: Array<{ role: Role; sid: string; terminal: boolean }>;
};
type Ledger = {
  version: 1;
  revision: number;
  scopeDigest: string;
  targetDigest: string;
  budgetUsdMicros: number;
  chargedUsdMicros: number;
  frozen: boolean;
  intents: Intent[];
};

/** Trusted runtime configuration, never browser input. The operator must obtain
 * current Twilio + all enabled OpenAI sessions' rate bounds before supplying
 * evidence (three default sessions, five with optional outgoing paired text).
 * This is a conservative trial allowance, not a billing meter or hard cap on
 * a provider invoice. Delayed billing/termination must be included in the bound.
 */
export type CloudTrialBudgetPolicy = Readonly<{
  allowedTarget: string;
  accountSid: string;
  applicationSid: string;
  budgetUsdMicros: number;
  worstCaseCallUsdMicros: number;
  maxCalls: number;
  maxWallClockMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  lateCallbackWindowMs: number;
  rates: Readonly<{
    twilioReference: string;
    openaiReference: string;
    checkedAt: number;
    validUntil: number;
  }>;
}>;

export class CloudBudgetError extends Error {
  readonly statusCode = 503;

  constructor(
    readonly code:
      | 'BUDGET_NOT_READY'
      | 'BUDGET_LOCKED'
      | 'BUDGET_CLEANUP_REQUIRED'
      | 'BUDGET_EXHAUSTED'
      | 'BUDGET_LIMIT_REACHED',
  ) {
    super(code);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function boundedInteger(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}
function deny(): never {
  throw new CloudBudgetError('BUDGET_NOT_READY');
}
function validPolicy(policy: CloudTrialBudgetPolicy, now: number): void {
  if (
    !policy ||
    !/^\+1[2-9][0-9]{9}$/.test(policy.allowedTarget) ||
    !/^AC[0-9a-fA-F]{32}$/.test(policy.accountSid) ||
    !/^AP[0-9a-fA-F]{32}$/.test(policy.applicationSid) ||
    !boundedInteger(policy.budgetUsdMicros, 1, MAX_BUDGET_USD_MICROS) ||
    !boundedInteger(policy.worstCaseCallUsdMicros, 1, policy.budgetUsdMicros) ||
    !boundedInteger(policy.maxCalls, 1, 10) ||
    !boundedInteger(policy.maxWallClockMs, 1000, 300000) ||
    !boundedInteger(policy.maxInputBytes, 1, 100_000_000) ||
    !boundedInteger(policy.maxOutputBytes, 1, 100_000_000) ||
    !boundedInteger(policy.lateCallbackWindowMs, 1000, 60000) ||
    !policy.rates ||
    typeof policy.rates.twilioReference !== 'string' ||
    !policy.rates.twilioReference.startsWith('https://www.twilio.com/') ||
    typeof policy.rates.openaiReference !== 'string' ||
    !/^https:\/\/(?:openai\.com|developers\.openai\.com)\//.test(
      policy.rates.openaiReference,
    ) ||
    !boundedInteger(policy.rates.checkedAt, 0, now) ||
    !boundedInteger(policy.rates.validUntil, now + 1) ||
    policy.rates.validUntil - policy.rates.checkedAt > 86400000
  )
    deny();
}
function binding(
  grant: CloudVoiceGrant,
  policy: CloudTrialBudgetPolicy,
  now: number,
): { grantDigest: string; ownerDigest: string } {
  if (
    !grant ||
    grant.version !== 1 ||
    ![
      grant.callId,
      grant.identity,
      grant.authSessionId,
      grant.principalId,
      grant.browserOwnerId,
      grant.controller?.leaseId,
      grant.controller?.tabId,
    ].every((value) => typeof value === 'string' && idPattern.test(value)) ||
    !boundedInteger(grant.authEpoch, 0) ||
    !boundedInteger(grant.controller.epoch, 0) ||
    !boundedInteger(grant.issuedAt, 0, now) ||
    !boundedInteger(grant.expiresAt, now + 1) ||
    grant.expiresAt - grant.issuedAt > 60000 ||
    grant.incomingAllow !== false ||
    grant.outgoingApplicationSid !== policy.applicationSid ||
    grant.outgoing?.callId !== grant.callId ||
    grant.outgoing?.identity !== grant.identity
  )
    deny();
  return {
    grantDigest: digest(grant),
    ownerDigest: digest([
      grant.authSessionId,
      grant.principalId,
      grant.browserOwnerId,
      grant.authEpoch,
      grant.controller,
    ]),
  };
}
function validLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== 'object') return false;
  const ledger = value as Ledger;
  if (
    ledger.version !== 1 ||
    !boundedInteger(ledger.revision, 0) ||
    !hashPattern.test(ledger.scopeDigest) ||
    !hashPattern.test(ledger.targetDigest) ||
    !boundedInteger(ledger.budgetUsdMicros, 1, MAX_BUDGET_USD_MICROS) ||
    !boundedInteger(ledger.chargedUsdMicros, 0, ledger.budgetUsdMicros) ||
    typeof ledger.frozen !== 'boolean' ||
    !Array.isArray(ledger.intents) ||
    ledger.intents.length > 10
  )
    return false;
  const calls = new Set<string>();
  let charge = 0;
  for (const entry of ledger.intents) {
    if (
      !entry ||
      !idPattern.test(entry.callId) ||
      calls.has(entry.callId) ||
      !idPattern.test(entry.reservationId) ||
      !idPattern.test(entry.operationKey) ||
      !hashPattern.test(entry.grantDigest) ||
      !hashPattern.test(entry.ownerDigest) ||
      !['reserved', 'cleanup', 'settled'].includes(entry.phase) ||
      !boundedInteger(entry.reservedUsdMicros, 1, ledger.budgetUsdMicros) ||
      !boundedInteger(entry.deadline, 0) ||
      !boundedInteger(entry.liabilityUntil, 0) ||
      !['pending', 'unknown', 'confirmed'].includes(entry.usage) ||
      (entry.usageUsdMicros !== undefined &&
        !boundedInteger(entry.usageUsdMicros, 0))
    )
      return false;
    if (
      !Array.isArray(entry.extraSids) ||
      entry.extraSids.length > 100 ||
      entry.extraSids.some(
        (item) =>
          !item ||
          !['local', 'remote'].includes(item.role) ||
          !sidPattern.test(item.sid) ||
          typeof item.terminal !== 'boolean',
      )
    )
      return false;
    for (const role of ['local', 'remote'] as const) {
      const leg = entry[role];
      if (
        !leg ||
        ![
          'planned',
          'started',
          'unknown',
          'created',
          'terminal',
          'absent',
        ].includes(leg.phase) ||
        (leg.sid !== undefined && !sidPattern.test(leg.sid)) ||
        (['created', 'terminal'].includes(leg.phase) && !leg.sid)
      )
        return false;
    }
    if (
      entry.phase === 'settled' &&
      (entry.usage !== 'confirmed' ||
        ![entry.local, entry.remote].every((leg) =>
          ['terminal', 'absent'].includes(leg.phase),
        ) ||
        entry.extraSids.some((item) => !item.terminal))
    )
      return false;
    calls.add(entry.callId);
    charge += entry.reservedUsdMicros;
  }
  return charge === ledger.chargedUsdMicros;
}

/** One resident process on a private persistent volume. No automatic stale-lock
 * takeover: a crash lock requires operator-confirmed single-instance recovery.
 * Reopening a cleanly closed ledger never restores old authority. Frame counters
 * stay in memory; restart enters cleanup only, so replay cannot reset an allowance.
 */
export class CloudBudgetJournal implements CloudVoiceAdmission {
  private readonly file: string;

  private readonly lockFile: string;

  private readonly lockFd: number;

  private readonly policy: CloudTrialBudgetPolicy;

  private ledger: Ledger;

  private closed = false;

  private fault = false;

  private readonly live = new Map<
    string,
    { reservation: CloudVoiceReservation; input: number; output: number }
  >();

  private constructor(
    private readonly directory: string,
    policy: CloudTrialBudgetPolicy,
    private readonly now: () => number,
  ) {
    validPolicy(policy, this.time());
    this.policy = Object.freeze({
      ...policy,
      rates: Object.freeze({ ...policy.rates }),
    });
    this.file = join(directory, 'trial-budget.json');
    this.lockFile = join(directory, 'trial-budget.lock');
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0 ||
      directoryStat.uid !== process.getuid?.()
    )
      deny();
    try {
      this.lockFd = openSync(
        this.lockFile,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new CloudBudgetError('BUDGET_LOCKED');
    }
    try {
      writeFileSync(
        this.lockFd,
        JSON.stringify({
          pid: process.pid,
          instance: randomBytes(24).toString('hex'),
        }),
      );
      fsyncSync(this.lockFd);
      const scopeDigest = digest([
        policy.accountSid,
        policy.applicationSid,
        policy.budgetUsdMicros,
        policy.worstCaseCallUsdMicros,
        policy.maxCalls,
        policy.maxWallClockMs,
        policy.maxInputBytes,
        policy.maxOutputBytes,
        policy.lateCallbackWindowMs,
      ]);
      const targetDigest = digest(policy.allowedTarget);
      // A separate durable sentinel prevents a deleted/corrupt ledger from
      // silently refilling this trial. Losing the WHOLE volume is an operator
      // deployment failure, so a real persistent volume remains mandatory.
      const sentinel = join(this.directory, 'trial-budget.initialized');
      const sentinelValue = digest([scopeDigest, targetDigest]);
      if (existsSync(sentinel) !== existsSync(this.file)) deny();
      if (existsSync(sentinel)) {
        const fd = openSync(
          sentinel,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = fstatSync(fd);
          if (
            !stat.isFile() ||
            stat.size !== 64 ||
            (stat.mode & 0o077) !== 0 ||
            stat.uid !== process.getuid?.() ||
            readFileSync(fd, 'utf8') !== sentinelValue
          )
            deny();
        } finally {
          closeSync(fd);
        }
      } else {
        const fd = openSync(
          sentinel,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, sentinelValue);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const directoryFd = openSync(
          this.directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
      if (existsSync(this.file)) {
        const fd = openSync(
          this.file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let existing: unknown;
        try {
          const stat = fstatSync(fd);
          if (
            !stat.isFile() ||
            stat.size > 65536 ||
            (stat.mode & 0o077) !== 0 ||
            stat.uid !== process.getuid?.()
          )
            deny();
          existing = JSON.parse(readFileSync(fd, 'utf8'));
        } finally {
          closeSync(fd);
        }
        if (
          !validLedger(existing) ||
          existing.scopeDigest !== scopeDigest ||
          existing.targetDigest !== targetDigest
        )
          deny();
        this.ledger = existing;
        if (existing.intents.some((entry) => entry.phase === 'reserved'))
          this.commit((next) => {
            next.intents.forEach((entry) => {
              if (entry.phase === 'reserved') entry.phase = 'cleanup';
            });
          });
      } else {
        this.ledger = {
          version: 1,
          revision: 0,
          scopeDigest,
          targetDigest,
          budgetUsdMicros: policy.budgetUsdMicros,
          chargedUsdMicros: 0,
          frozen: false,
          intents: [],
        };
        this.commit(() => {});
      }
    } catch (error) {
      closeSync(this.lockFd);
      unlinkSync(this.lockFile);
      throw error instanceof CloudBudgetError
        ? error
        : new CloudBudgetError('BUDGET_NOT_READY');
    }
  }

  static open(options: {
    directory: string;
    policy: CloudTrialBudgetPolicy;
    now?: () => number;
  }): CloudBudgetJournal {
    if (
      !options ||
      !isAbsolute(options.directory) ||
      resolve(options.directory) !== options.directory ||
      (options.now !== undefined && typeof options.now !== 'function')
    )
      deny();
    // The containing volume path is chosen by the operator, never a request.
    if (!existsSync(options.directory))
      mkdirSync(options.directory, { mode: 0o700 });
    if (realpathSync(options.directory) !== options.directory) deny();
    return new CloudBudgetJournal(
      options.directory,
      options.policy,
      options.now ?? Date.now,
    );
  }

  private time(): number {
    const now = this.now();
    if (!boundedInteger(now, 0)) deny();
    return now;
  }

  private current(): void {
    if (this.closed || this.fault) deny();
    validPolicy(this.policy, this.time());
  }

  private entry(callId: string): Intent {
    const entry = this.ledger.intents.find((item) => item.callId === callId);
    if (!entry) deny();
    return entry;
  }

  private commit(change: (next: Ledger) => void): void {
    if (this.closed || this.fault) deny();
    const next: Ledger = JSON.parse(JSON.stringify(this.ledger));
    change(next);
    next.revision += 1;
    if (!validLedger(next)) deny();
    const temporary = join(
      this.directory,
      `.budget-${randomBytes(16).toString('hex')}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
      const directoryFd = openSync(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      this.ledger = next;
    } catch {
      this.fault = true;
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {
        /* A renamed transaction may already be durable: never roll it back. */
      }
      deny();
    }
  }

  get cleanupRequired(): boolean {
    return (
      this.closed ||
      this.fault ||
      this.ledger.frozen ||
      this.ledger.intents.some((entry) => entry.phase === 'cleanup')
    );
  }

  get remainingUsdMicros(): number {
    return this.ledger.budgetUsdMicros - this.ledger.chargedUsdMicros;
  }

  /** Redacted recovery records; no numbers, tokens, cookies, names or grant. */
  recoveryIntents(): ReadonlyArray<Readonly<Intent>> {
    return Object.freeze(JSON.parse(JSON.stringify(this.ledger.intents)));
  }

  assertTarget(target: string): void {
    this.current();
    if (target !== this.policy.allowedTarget) deny();
  }

  /** Inject this synchronous gate before every billed stream/request operation.
   * The caller retains separate auth/controller checks; this never grants them.
   */
  assertCallCurrent(callId: string): void {
    const live = this.live.get(callId);
    if (!live) deny();
    live.reservation.assertCurrent();
  }

  /** Absolute deadline is never extended by reconnect, controller renewal,
   * frames or usage. Apply it to both Twilio timeLimit and the resident timer.
   */
  callLimits(
    callId: string,
  ): Readonly<{ deadline: number; remainingWallClockMs: number }> {
    this.assertCallCurrent(callId);
    const { deadline } = this.entry(callId);
    const remainingWallClockMs = deadline - this.time();
    if (remainingWallClockMs <= 0)
      throw new CloudBudgetError('BUDGET_LIMIT_REACHED');
    return Object.freeze({ deadline, remainingWallClockMs });
  }

  async reserve(grant: CloudVoiceGrant): Promise<CloudVoiceReservation> {
    this.current();
    const hashes = binding(grant, this.policy, this.time());
    const old = this.ledger.intents.find(
      (entry) => entry.callId === grant.callId,
    );
    if (old) {
      const handle = this.live.get(grant.callId);
      if (old.grantDigest !== hashes.grantDigest || !handle) deny();
      handle.reservation.assertCurrent();
      return handle.reservation;
    }
    if (
      this.cleanupRequired ||
      this.ledger.intents.some((entry) => entry.phase === 'reserved')
    )
      throw new CloudBudgetError('BUDGET_CLEANUP_REQUIRED');
    if (
      this.ledger.intents.length >= this.policy.maxCalls ||
      this.remainingUsdMicros < this.policy.worstCaseCallUsdMicros
    )
      throw new CloudBudgetError('BUDGET_EXHAUSTED');
    const now = this.time();
    const reservationId = randomBytes(24).toString('base64url');
    this.commit((next) => {
      next.chargedUsdMicros += this.policy.worstCaseCallUsdMicros;
      next.intents.push({
        callId: grant.callId,
        reservationId,
        operationKey: randomBytes(24).toString('base64url'),
        ...hashes,
        phase: 'reserved',
        reservedUsdMicros: this.policy.worstCaseCallUsdMicros,
        deadline: now + this.policy.maxWallClockMs,
        liabilityUntil: grant.expiresAt + this.policy.lateCallbackWindowMs,
        local: { phase: 'planned' },
        remote: { phase: 'planned' },
        usage: 'pending',
        extraSids: [],
      });
    });
    const reservation = Object.freeze({
      assertCurrent: () => {
        this.current();
        const record = this.entry(grant.callId);
        if (
          this.ledger.frozen ||
          record.phase !== 'reserved' ||
          record.reservationId !== reservationId ||
          record.grantDigest !== hashes.grantDigest ||
          this.time() >= record.deadline
        )
          throw new CloudBudgetError('BUDGET_LIMIT_REACHED');
      },
      release: async () => {
        if (this.closed || this.fault) deny();
        if (this.entry(grant.callId).phase === 'reserved')
          this.commit((next) => {
            next.intents.find((entry) => entry.callId === grant.callId)!.phase =
              'cleanup';
          });
        this.live.delete(grant.callId);
      },
    });
    this.live.set(grant.callId, { reservation, input: 0, output: 0 });
    return reservation;
  }

  /** Must finish before an external create/sign operation starts. */
  beginCreate(callId: string, role: Role, target?: string): string {
    if (role !== 'local' && role !== 'remote') deny();
    if (role === 'remote') this.assertTarget(target!);
    const live = this.live.get(callId);
    if (!live) deny();
    live.reservation.assertCurrent();
    const leg = this.entry(callId)[role];
    if (leg.phase !== 'planned') deny();
    this.commit((next) => {
      next.intents.find((entry) => entry.callId === callId)![role].phase =
        'started';
    });
    return `${this.entry(callId).operationKey}_${role}`;
  }

  /** Signed/provider-account validated callbacks only. LATE SIDs are retained
   * for cleanup, never converted into revived admission. */
  recordCreated(callId: string, role: Role, sid: string): void {
    if (!['local', 'remote'].includes(role) || !sidPattern.test(sid)) deny();
    const leg = this.entry(callId)[role];
    if (leg.sid && leg.sid !== sid) {
      this.commit((next) => {
        const entry = next.intents.find((item) => item.callId === callId)!;
        if (!entry.extraSids.some((item) => item.sid === sid))
          entry.extraSids.push({ role, sid, terminal: false });
        entry.phase = 'cleanup';
        next.frozen = true;
      });
      this.live.delete(callId);
      deny();
    }
    if (!['started', 'unknown', 'created', 'terminal'].includes(leg.phase))
      deny();
    if (leg.sid === sid) return;
    this.commit((next) => {
      const entry = next.intents.find((item) => item.callId === callId)!;
      entry[role] = { phase: 'created', sid };
    });
  }

  markUnknown(callId: string, role?: Role): void {
    if (role !== undefined && role !== 'local' && role !== 'remote') deny();
    this.entry(callId);
    this.commit((next) => {
      const entry = next.intents.find((item) => item.callId === callId)!;
      entry.phase = 'cleanup';
      next.frozen = true;
      if (role) entry[role].phase = 'unknown';
      else entry.usage = 'unknown';
    });
    this.live.delete(callId);
  }

  confirmTerminal(callId: string, role: Role, sid: string): void {
    if (!['local', 'remote'].includes(role) || !sidPattern.test(sid)) deny();
    const entry = this.entry(callId);
    const leg = entry[role];
    if (
      leg.sid !== sid &&
      !entry.extraSids.some((item) => item.sid === sid && item.role === role)
    )
      deny();
    this.commit((next) => {
      const record = next.intents.find((item) => item.callId === callId)!;
      if (record[role].sid === sid) record[role].phase = 'terminal';
      else
        record.extraSids.find(
          (item) => item.sid === sid && item.role === role,
        )!.terminal = true;
    });
  }

  /** Authoritative reconciliation port, not "timeout means no call". */
  confirmAbsent(callId: string, role: Role): void {
    if (!['local', 'remote'].includes(role) || this.entry(callId)[role].sid)
      deny();
    this.commit((next) => {
      next.intents.find((item) => item.callId === callId)![role].phase =
        'absent';
    });
  }

  confirmUsage(callId: string, usdMicros: number): void {
    if (
      !boundedInteger(usdMicros, 0) ||
      usdMicros > this.entry(callId).reservedUsdMicros
    ) {
      this.markUnknown(callId);
      deny();
    }
    this.commit((next) => {
      const entry = next.intents.find((item) => item.callId === callId)!;
      entry.usage = 'confirmed';
      entry.usageUsdMicros = usdMicros;
    });
  }

  /** No refund: the full conservative reservation stays charged forever. */
  settle(callId: string): void {
    const entry = this.entry(callId);
    if (
      entry.phase !== 'cleanup' ||
      entry.usage !== 'confirmed' ||
      this.time() < entry.liabilityUntil ||
      ![entry.local, entry.remote].every((leg) =>
        ['terminal', 'absent'].includes(leg.phase),
      ) ||
      entry.extraSids.some((item) => !item.terminal)
    )
      throw new CloudBudgetError('BUDGET_CLEANUP_REQUIRED');
    this.commit((next) => {
      next.intents.find((item) => item.callId === callId)!.phase = 'settled';
      next.frozen = next.intents.some(
        (item) =>
          item.phase !== 'settled' &&
          (item.usage === 'unknown' ||
            item.local.phase === 'unknown' ||
            item.remote.phase === 'unknown'),
      );
    });
  }

  /** Synchronous gate before media upload/playback. A full call was reserved in
   * advance; no disk write per 20ms frame. On restart ALL old calls lose authority.
   */
  consumeMedia(
    callId: string,
    direction: 'input' | 'output',
    bytes: number,
  ): void {
    const live = this.live.get(callId);
    if (
      !live ||
      !['input', 'output'].includes(direction) ||
      !boundedInteger(bytes, 1, direction === 'input' ? 48000 : 1048576)
    )
      deny();
    live.reservation.assertCurrent();
    const maximum =
      direction === 'input'
        ? this.policy.maxInputBytes
        : this.policy.maxOutputBytes;
    if (live[direction] + bytes > maximum) {
      this.markUnknown(callId);
      throw new CloudBudgetError('BUDGET_LIMIT_REACHED');
    }
    live[direction] += bytes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.live.clear();
    closeSync(this.lockFd);
    unlinkSync(this.lockFile);
    const fd = openSync(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
