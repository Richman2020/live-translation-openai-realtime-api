// eslint-disable-next-line max-classes-per-file -- Keep the typed lease conflict beside its policy.
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessContext,
} from './cloud-access';

export type ControllerProof = Readonly<{
  tabId: string;
  leaseId: string;
  epoch: number;
}>;
export type ControllerLeaseView = ControllerProof &
  Readonly<{ expiresAt: number }>;
/** Server-issued handle: matching fields or a copied object do not issue it. */
export type BoundControllerLease = ControllerLeaseView;
/** Informational only: matching a claimed tab never grants controller rights. */
export type ControllerLeaseStatus = Readonly<{
  mode: 'available' | 'held';
  ownSession: boolean;
  tabMatches: boolean;
  epoch: number;
  expiresAt: number | null;
  /** Informational only; it cannot restore a document's private proof. */
  serverMaintained?: true;
}>;

export class ControllerLeaseError extends Error {
  readonly code = 'CONTROLLER_BUSY';

  readonly statusCode = 409;

  constructor() {
    super('CONTROLLER_BUSY');
  }
}

type LeaseRecord = {
  owner: CloudAccessContext;
  tabId: string;
  leaseId: string;
  epoch: number;
  issuedAt: number;
  expiresAt: number;
  connection?: {
    callId: string;
    deadline: () => number | undefined;
  };
};
type BoundState = {
  context: CloudAccessContext;
  record: LeaseRecord;
};
const tabPattern = /^[A-Za-z0-9_-]{1,128}$/;
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

function sameOwner(left: CloudAccessContext, right: CloudAccessContext) {
  return (
    left.authSessionId === right.authSessionId &&
    left.principalId === right.principalId &&
    left.browserOwnerId === right.browserOwnerId &&
    left.epoch === right.epoch
  );
}

function requireTabId(tabId: string): void {
  if (typeof tabId !== 'string' || !tabPattern.test(tabId))
    throw new CloudAccessError('FORBIDDEN');
}

function proofFields(proof: ControllerProof): ControllerProof {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof))
    throw new CloudAccessError('FORBIDDEN');
  const tabId = Object.getOwnPropertyDescriptor(proof, 'tabId')?.value;
  const leaseId = Object.getOwnPropertyDescriptor(proof, 'leaseId')?.value;
  const epoch = Object.getOwnPropertyDescriptor(proof, 'epoch')?.value;
  requireTabId(tabId);
  if (
    typeof leaseId !== 'string' ||
    !opaquePattern.test(leaseId) ||
    Buffer.from(leaseId, 'base64url').toString('base64url') !== leaseId ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new CloudAccessError('FORBIDDEN');
  return { tabId, leaseId, epoch };
}

/** One in-memory controller. A verified call may supply a private, finite media
 * connection deadline. Reads do not extend that connection or its identity.
 * The caller must supply its active/preparing/unconfirmed-cleanup busy gate to
 * acquire. An expired lease does not prove that a provider call was cleaned up.
 */
export class CloudControllerLeases {
  readonly policy: CloudAccessPolicy;

  private readonly now: () => number;

  private readonly ttlMs: number;

  private current: LeaseRecord | undefined;

  private epoch = 0;

  private readonly issued = new WeakMap<BoundControllerLease, BoundState>();

  constructor(options: {
    policy: CloudAccessPolicy;
    now?: () => number;
    ttlMs?: number;
  }) {
    const ttlMs = options?.ttlMs ?? 30000;
    if (
      !(options?.policy instanceof CloudAccessPolicy) ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 60000
    )
      throw new CloudAccessError('FORBIDDEN');
    this.policy = options.policy;
    this.now = options.now ?? Date.now;
    this.ttlMs = ttlMs;
  }

  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new CloudAccessError('FORBIDDEN');
    return now;
  }

  private nextEpoch(): number {
    if (!Number.isSafeInteger(this.epoch + 1))
      throw new CloudAccessError('FORBIDDEN');
    this.epoch += 1;
    return this.epoch;
  }

  private view(record: LeaseRecord, expiresAt = record.expiresAt) {
    return Object.freeze({
      tabId: record.tabId,
      leaseId: record.leaseId,
      epoch: record.epoch,
      expiresAt,
    });
  }

  private connectionCurrent(record: LeaseRecord, now: number): boolean {
    if (!record.connection) return false;
    const deadline = record.connection.deadline();
    if (deadline === undefined) return false;
    if (!Number.isSafeInteger(deadline) || deadline <= now)
      throw new CloudAccessError('FORBIDDEN');
    // The witness deadline advances only when the verified transport answers
    // a server ping. Polling/SSE and silent model output cannot manufacture it.
    record.expiresAt = Math.min(
      deadline,
      this.policy.expiresAt(record.owner, 'mutate'),
    );
    return true;
  }

  /** Server-only binding: copied proofs or read contexts cannot install one.
   * The manager returns no witness before its original media admission passes.
   */
  bindCallConnection(
    bound: BoundControllerLease,
    callId: string,
    deadline: () => number | undefined,
  ): void {
    this.authorizeCurrent(bound);
    requireTabId(callId);
    if (Object.prototype.toString.call(deadline) !== '[object Function]')
      throw new CloudAccessError('FORBIDDEN');
    const state = this.issued.get(bound)!;
    if (
      state.record.connection &&
      state.record.connection.callId !== callId &&
      state.record.connection.deadline() !== undefined
    )
      throw new CloudAccessError('FORBIDDEN');
    state.record.connection = { callId, deadline };
  }

  /** After an accepted hangup, retain only a finite authenticated cleanup
   * response window. The ended manager never grants further media admission.
   */
  retainForCleanup(bound: BoundControllerLease, callId: string): void {
    this.authorizeCurrent(bound);
    const state = this.issued.get(bound)!;
    if (state.record.connection && state.record.connection.callId !== callId)
      return;
    const now = this.time();
    const expiresAt = Math.min(
      now + this.ttlMs,
      this.policy.expiresAt(state.context, 'mutate'),
    );
    state.record.connection = undefined;
    state.record.expiresAt = expiresAt;
  }

  /** Cleanup-only: callers must first prove that this exact call has accepted
   * an end intent. Fresh identity/CSRF and the original secret tab proof remain
   * mandatory, but a retired control TTL cannot prevent terminating its legs.
   * This returns no handle and cannot renew, join or restore a controller.
   */
  authorizeCleanup(
    context: CloudAccessContext,
    proof: ControllerProof,
    original: BoundControllerLease,
  ): void {
    this.policy.revalidate(context, 'mutate');
    const state = this.issued.get(original);
    if (!state) throw new CloudAccessError('UNAUTHORIZED');
    if (this.time() < state.record.issuedAt)
      throw new CloudAccessError('FORBIDDEN');
    const fields = proofFields(proof);
    if (
      !sameOwner(state.record.owner, context) ||
      fields.tabId !== state.record.tabId ||
      fields.epoch !== state.record.epoch ||
      !timingSafeEqual(
        Buffer.from(fields.leaseId),
        Buffer.from(state.record.leaseId),
      )
    )
      throw new CloudAccessError('FORBIDDEN');
    this.policy.revalidate(context, 'mutate');
  }

  private requireLease(context: CloudAccessContext, proof: ControllerProof) {
    this.policy.revalidate(context, 'mutate');
    const fields = proofFields(proof);
    const record = this.current;
    const now = this.time();
    if (record) this.connectionCurrent(record, now);
    if (
      !record ||
      now < record.issuedAt ||
      now >= record.expiresAt ||
      !sameOwner(record.owner, context) ||
      fields.tabId !== record.tabId ||
      fields.epoch !== record.epoch ||
      !timingSafeEqual(Buffer.from(fields.leaseId), Buffer.from(record.leaseId))
    )
      throw new CloudAccessError('FORBIDDEN');
    const authExpiresAt = this.policy.expiresAt(context, 'mutate');
    if (now >= authExpiresAt) throw new CloudAccessError('UNAUTHORIZED');
    return { record, now, authExpiresAt };
  }

  acquire(
    context: CloudAccessContext,
    tabId: string,
    options: { busy: boolean } = { busy: false },
  ): ControllerLeaseView {
    this.policy.revalidate(context, 'mutate');
    requireTabId(tabId);
    if (!options || typeof options.busy !== 'boolean')
      throw new CloudAccessError('FORBIDDEN');
    const now = this.time();
    if (this.current) this.connectionCurrent(this.current, now);
    if (options.busy || (this.current && now < this.current.expiresAt))
      throw new ControllerLeaseError();
    const authExpiresAt = this.policy.expiresAt(context, 'mutate');
    const expiresAt = Math.min(now + this.ttlMs, authExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new CloudAccessError('FORBIDDEN');
    const record: LeaseRecord = {
      owner: context,
      tabId,
      leaseId: randomBytes(32).toString('base64url'),
      epoch: this.nextEpoch(),
      issuedAt: now,
      expiresAt,
    };
    this.current = record;
    return this.view(record);
  }

  renew(
    context: CloudAccessContext,
    proof: ControllerProof,
  ): ControllerLeaseView {
    const { record, now, authExpiresAt } = this.requireLease(context, proof);
    const expiresAt = Math.min(now + this.ttlMs, authExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new CloudAccessError('FORBIDDEN');
    record.expiresAt = expiresAt;
    return this.view(record);
  }

  revoke(context: CloudAccessContext, proof: ControllerProof): void {
    this.requireLease(context, proof);
    this.nextEpoch();
    this.current = undefined;
  }

  authorize(
    context: CloudAccessContext,
    proof: ControllerProof,
  ): BoundControllerLease {
    const { record, authExpiresAt } = this.requireLease(context, proof);
    const bound = this.view(record, Math.min(record.expiresAt, authExpiresAt));
    this.issued.set(bound, { context, record });
    return bound;
  }

  authorizeCurrent(bound: BoundControllerLease): ControllerLeaseView {
    const state = this.issued.get(bound);
    if (!state) throw new CloudAccessError('UNAUTHORIZED');
    const now = this.time();
    if (state.record === this.current)
      this.connectionCurrent(state.record, now);
    if (
      state.record !== this.current ||
      now < state.record.issuedAt ||
      now >= state.record.expiresAt
    )
      throw new CloudAccessError('FORBIDDEN');
    const authExpiresAt = this.policy.expiresAt(state.context, 'mutate');
    if (now >= authExpiresAt) throw new CloudAccessError('UNAUTHORIZED');
    return this.view(
      state.record,
      Math.min(state.record.expiresAt, authExpiresAt),
    );
  }

  status(context: CloudAccessContext, tabId?: string): ControllerLeaseStatus {
    this.policy.revalidate(context, 'read');
    if (tabId !== undefined) requireTabId(tabId);
    const now = this.time();
    const record = this.current;
    const maintained = !!record && this.connectionCurrent(record, now);
    const active = record && now >= record.issuedAt && now < record.expiresAt;
    const ownSession = !!active && sameOwner(record.owner, context);
    return Object.freeze({
      mode: active ? 'held' : 'available',
      ownSession,
      tabMatches: ownSession && tabId === record.tabId,
      epoch: this.epoch,
      expiresAt: active ? record.expiresAt : null,
      ...(active && maintained ? { serverMaintained: true as const } : {}),
    });
  }
}
