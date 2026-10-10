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

/** One in-memory controller. No identity provider, persistence or implicit lease
 * extension: only explicit authenticated POST renew extends the deadline.
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

  private requireLease(context: CloudAccessContext, proof: ControllerProof) {
    this.policy.revalidate(context, 'mutate');
    const fields = proofFields(proof);
    const record = this.current;
    const now = this.time();
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
    const active = record && now >= record.issuedAt && now < record.expiresAt;
    const ownSession = !!active && sameOwner(record.owner, context);
    return Object.freeze({
      mode: active ? 'held' : 'available',
      ownSession,
      tabMatches: ownSession && tabId === record.tabId,
      epoch: this.epoch,
      expiresAt: active ? record.expiresAt : null,
    });
  }
}
