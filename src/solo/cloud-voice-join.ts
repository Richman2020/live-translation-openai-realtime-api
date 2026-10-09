// eslint-disable-next-line max-classes-per-file -- Keep typed denial beside the admission policy.
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessContext,
} from './cloud-access';

export type CloudVoiceController = Readonly<{
  leaseId: string;
  tabId: string;
  epoch: number;
  /** The current lease deadline, clamped to the current login session deadline. */
  expiresAt: number;
}>;
export type CloudVoiceCall = Readonly<{
  callId: string;
  identity: string;
  nonce: string;
}>;
/** This is an input to an explicitly injected signer, not a Twilio JWT.
 * A JWT's outgoing application grant cannot enforce a single call. The signed
 * /voice/client callback must also consume the private per-call join capability.
 * The public application SID is explicit; credentials and a real signer are
 * intentionally absent here. The SID is an identifier, not authentication.
 */
export type CloudVoiceGrant = Readonly<{
  version: 1;
  authSessionId: string;
  principalId: string;
  browserOwnerId: string;
  authEpoch: number;
  controller: Readonly<
    Pick<CloudVoiceController, 'leaseId' | 'tabId' | 'epoch'>
  >;
  callId: string;
  identity: string;
  issuedAt: number;
  expiresAt: number;
  incomingAllow: false;
  outgoingApplicationSid: string;
  outgoing: Readonly<{ callId: string; identity: string }>;
}>;
export type CloudVoiceReservation = Readonly<{
  /** Synchronous CURRENT budget/intent reservation validation, never a boolean. */
  assertCurrent: () => void;
  /** Confirm safe rollback/line cleanup and release current admission occupancy.
   * This is not a refund or permission to erase the durable journal: a future
   * implementation must retain recoverable intent/liability for a late browser
   * SID until any issued JWT's validity window and cleanup obligations finish.
   */
  release: () => Promise<void>;
}>;
/** A future durable implementation must persist budget and creation/cleanup
 * intent before returning a reservation. This module implements no persistence
 * or recovery, and provides no default approval. Tests inject explicit fakes.
 */
export type CloudVoiceAdmission = Readonly<{
  reserve: (grant: CloudVoiceGrant) => Promise<CloudVoiceReservation>;
}>;
export type CloudVoiceSigner = (grant: CloudVoiceGrant) => Promise<string>;
export type PreparedCloudVoice = Readonly<{
  token: string;
  join: string;
  grant: CloudVoiceGrant;
  params: Readonly<{ sessionId: string; nonce: string; join: string }>;
}>;
export type CloudVoiceJoinFields = Readonly<{
  sessionId: string;
  nonce: string;
  From: string;
  CallSid: string;
  join: string;
}>;

export class CloudVoiceJoinError extends Error {
  readonly statusCode: 403 | 409 | 503;

  constructor(
    readonly code:
      | 'INVALID_VOICE_JOIN'
      | 'VOICE_PREPARATION_IN_PROGRESS'
      | 'VOICE_CONNECTION_NOT_READY',
  ) {
    super(code);
    this.statusCode = {
      INVALID_VOICE_JOIN: 403,
      VOICE_PREPARATION_IN_PROGRESS: 409,
      VOICE_CONNECTION_NOT_READY: 503,
    }[code] as 403 | 409 | 503;
  }
}

type RecordEntry = {
  context: CloudAccessContext;
  call: CloudVoiceCall;
  authorizeController: () => CloudVoiceController;
  controllerBinding?: Readonly<
    Pick<CloudVoiceController, 'leaseId' | 'tabId' | 'epoch'>
  >;
  pending: boolean;
  disposed: boolean;
  prepared?: PreparedCloudVoice;
  reservation?: CloudVoiceReservation;
  sid?: string;
  releaseTask?: Promise<void>;
};
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const joinCapability = /^[A-Za-z0-9_-]{43}$/;
const callSid = /^CA[0-9a-fA-F]{32}$/;

function data(record: unknown, field: string): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor || !('value' in descriptor))
    throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
  return descriptor.value;
}
function synchronous(check: () => unknown): void {
  if (Object.prototype.toString.call(check) !== '[object Function]')
    throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
  let result: unknown;
  try {
    result = check();
  } catch {
    throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
  }
  if (result !== undefined)
    throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
}
function reservation(input: unknown): CloudVoiceReservation {
  try {
    const assertCurrent = data(input, 'assertCurrent');
    const release = data(input, 'release');
    if (
      typeof assertCurrent !== 'function' ||
      Object.prototype.toString.call(assertCurrent) !== '[object Function]' ||
      typeof release !== 'function'
    )
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    return Object.freeze({
      assertCurrent: assertCurrent.bind(input) as () => void,
      release: release.bind(input) as () => Promise<void>,
    });
  } catch {
    throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
  }
}
function sameCapability(left: string, right: string): boolean {
  if (!joinCapability.test(left) || !joinCapability.test(right)) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Server-only single-call Voice admission, with no real credential defaults.
 * All externally asynchronous steps start after a fresh synchronous permission
 * check and are checked again after completion. They are not made atomic by it.
 */
export class CloudVoiceJoin {
  readonly policy: CloudAccessPolicy;

  /** Public application identifier only; never an account signing secret. */
  readonly outgoingApplicationSid: string | undefined;

  private readonly signer: CloudVoiceSigner | undefined;

  private readonly admission: CloudVoiceAdmission | undefined;

  private readonly now: () => number;

  private readonly maxTokenLifetimeMs: number;

  private readonly maxCalls: number;

  private readonly calls = new Map<string, RecordEntry>();

  private readonly unconfirmedReleases = new Set<RecordEntry>();

  constructor(options: {
    policy: CloudAccessPolicy;
    signer?: CloudVoiceSigner;
    admission?: CloudVoiceAdmission;
    outgoingApplicationSid?: string;
    now?: () => number;
    maxTokenLifetimeMs?: number;
    maxCalls?: number;
  }) {
    const lifetime = options?.maxTokenLifetimeMs ?? 30000;
    const maxCalls = options?.maxCalls ?? 100;
    if (
      !(options?.policy instanceof CloudAccessPolicy) ||
      (options.signer !== undefined && typeof options.signer !== 'function') ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.outgoingApplicationSid !== undefined &&
        !/^AP[0-9a-fA-F]{32}$/.test(options.outgoingApplicationSid)) ||
      (options.admission !== undefined &&
        typeof data(options.admission, 'reserve') !== 'function') ||
      !Number.isSafeInteger(lifetime) ||
      lifetime < 1000 ||
      lifetime > 60000 ||
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 100
    )
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    this.policy = options.policy;
    this.outgoingApplicationSid = options.outgoingApplicationSid;
    this.signer = options.signer;
    this.admission = options.admission;
    this.now = options.now ?? Date.now;
    this.maxTokenLifetimeMs = lifetime;
    this.maxCalls = maxCalls;
  }

  get cleanupUnconfirmed(): boolean {
    return this.unconfirmedReleases.size > 0;
  }

  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    return now;
  }

  /** Registration follows policy call ownership registration, before publish.
   * The disposer is solely for an unpublished admission rollback. Published and
   * uncertain calls retain their binding, including late cleanup callbacks.
   */
  registerCall(
    context: CloudAccessContext,
    call: CloudVoiceCall,
    authorizeController: () => CloudVoiceController,
  ): () => void {
    const copied = Object.freeze({
      callId: data(call, 'callId'),
      identity: data(call, 'identity'),
      nonce: data(call, 'nonce'),
    });
    if (
      ![copied.callId, copied.identity, copied.nonce].every(
        (value) => typeof value === 'string' && identifier.test(value),
      ) ||
      copied.identity === 'ai-phone' ||
      typeof authorizeController !== 'function'
    )
      throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
    const stored: RecordEntry = {
      context,
      call: copied as CloudVoiceCall,
      authorizeController,
      pending: false,
      disposed: false,
    };
    this.policy.runAuthorizedCall(context, stored.call.callId, 'mutate', () => {
      const controller = this.controller(stored);
      stored.controllerBinding = Object.freeze({
        leaseId: controller.leaseId,
        tabId: controller.tabId,
        epoch: controller.epoch,
      });
      if (
        this.calls.has(stored.call.callId) ||
        this.calls.size >= this.maxCalls
      )
        throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
      this.calls.set(stored.call.callId, stored);
    });
    return () => {
      if (stored.disposed) return;
      stored.disposed = true;
      if (
        !stored.pending &&
        !stored.reservation &&
        this.calls.get(stored.call.callId) === stored
      )
        this.calls.delete(stored.call.callId);
    };
  }

  private controller(record: RecordEntry): CloudVoiceController {
    if (
      Object.prototype.toString.call(record.authorizeController) !==
      '[object Function]'
    )
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    const result = record.authorizeController();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    }
    const leaseId = data(result, 'leaseId');
    const tabId = data(result, 'tabId');
    const epoch = data(result, 'epoch');
    const expiresAt = data(result, 'expiresAt');
    if (
      typeof leaseId !== 'string' ||
      !identifier.test(leaseId) ||
      typeof tabId !== 'string' ||
      !identifier.test(tabId) ||
      !Number.isSafeInteger(epoch) ||
      (epoch as number) < 0 ||
      !Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) <= this.time() ||
      (record.controllerBinding &&
        (leaseId !== record.controllerBinding.leaseId ||
          tabId !== record.controllerBinding.tabId ||
          epoch !== record.controllerBinding.epoch))
    )
      throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
    return Object.freeze({
      leaseId,
      tabId,
      epoch: epoch as number,
      expiresAt: expiresAt as number,
    });
  }

  private authorized<T>(
    context: CloudAccessContext,
    record: RecordEntry,
    commit: (controller: CloudVoiceController) => T,
  ): T {
    return this.policy.runAuthorizedCall(
      context,
      record.call.callId,
      'mutate',
      () => {
        if (record.disposed || this.calls.get(record.call.callId) !== record)
          throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
        const controller = this.controller(record);
        this.policy.authorizeCall(context, record.call.callId, 'mutate');
        return commit(controller);
      },
    );
  }

  private authorizedReservation<T>(
    context: CloudAccessContext,
    record: RecordEntry,
    held: CloudVoiceReservation,
    commit: (controller: CloudVoiceController) => T,
  ): T {
    this.authorized(context, record, () => synchronous(held.assertCurrent));
    // A server-injected reservation validator also runs code. Recheck the
    // session/lease after it, immediately before the synchronous commit/start.
    return this.authorized(context, record, commit);
  }

  async prepareGrant(
    context: CloudAccessContext,
    id: string,
  ): Promise<PreparedCloudVoice> {
    this.policy.authorizeCall(context, id, 'mutate');
    const record = this.calls.get(id);
    if (!record) throw new CloudAccessError('NOT_FOUND');
    if (!this.signer || !this.admission || !this.outgoingApplicationSid)
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    if (this.cleanupUnconfirmed)
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    const issued = this.authorized(context, record, () => {
      if (record.sid) throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
      if (record.pending)
        throw new CloudVoiceJoinError('VOICE_PREPARATION_IN_PROGRESS');
      if (record.reservation && !record.prepared)
        throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
      if (record.prepared) {
        if (
          !record.reservation ||
          record.prepared.grant.expiresAt <= this.time()
        )
          throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
        this.assertPreparedCurrent(context, id, record.prepared);
        return record.prepared;
      }
      return undefined;
    });
    if (issued) return issued;
    let held: CloudVoiceReservation | undefined;
    try {
      const grant = this.authorized(context, record, (controller) => {
        record.pending = true;
        const now = this.time();
        return Object.freeze({
          version: 1 as const,
          authSessionId: context.authSessionId,
          principalId: context.principalId,
          browserOwnerId: context.browserOwnerId,
          authEpoch: context.epoch,
          controller: Object.freeze({
            leaseId: controller.leaseId,
            tabId: controller.tabId,
            epoch: controller.epoch,
          }),
          callId: id,
          identity: record.call.identity,
          issuedAt: now,
          expiresAt: Math.min(
            controller.expiresAt,
            this.policy.expiresAt(context, 'mutate'),
            now + this.maxTokenLifetimeMs,
          ),
          incomingAllow: false as const,
          outgoingApplicationSid: this.outgoingApplicationSid!,
          outgoing: Object.freeze({
            callId: id,
            identity: record.call.identity,
          }),
        });
      });
      let reserveTask: Promise<CloudVoiceReservation>;
      this.authorized(context, record, () => {
        try {
          reserveTask = this.admission!.reserve(grant);
        } catch {
          this.unconfirmedReleases.add(record);
          throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
        }
      });
      let reserved: unknown;
      try {
        reserved = await reserveTask!;
      } catch {
        // A failed external transaction does not prove no reservation exists.
        // There is no fabricated recovery approval for an uncertain result.
        this.unconfirmedReleases.add(record);
        throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
      }
      try {
        held = reservation(reserved);
      } catch {
        const release =
          reserved && typeof reserved === 'object'
            ? Object.getOwnPropertyDescriptor(reserved, 'release')?.value
            : undefined;
        if (typeof release === 'function')
          held = Object.freeze({
            assertCurrent: () => {
              throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
            },
            release: release.bind(reserved),
          });
        else this.unconfirmedReleases.add(record);
        throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
      }
      this.authorizedReservation(context, record, held, () => undefined);
      let signTask: Promise<string>;
      this.authorizedReservation(context, record, held, () => {
        signTask = this.signer!(grant);
      });
      const token = await signTask!;
      if (typeof token !== 'string' || token.length < 1 || token.length > 16384)
        throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
      const join = randomBytes(32).toString('base64url');
      return this.authorizedReservation(context, record, held, (controller) => {
        if (
          this.time() >= grant.expiresAt ||
          controller.leaseId !== grant.controller.leaseId ||
          controller.tabId !== grant.controller.tabId ||
          controller.epoch !== grant.controller.epoch
        )
          throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
        const prepared = Object.freeze({
          token,
          join,
          grant,
          params: Object.freeze({
            sessionId: id,
            nonce: record.call.nonce,
            join,
          }),
        });
        record.reservation = held;
        record.prepared = prepared;
        held = undefined;
        return prepared;
      });
    } catch (error) {
      if (held) {
        // Retain a failed rollback for explicit safety cleanup retry. Never
        // reserve a second budget or issue a token while rollback is uncertain.
        record.reservation = held;
        try {
          await this.releaseRecord(record);
        } catch {
          throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
        }
      }
      if (
        error instanceof CloudAccessError ||
        error instanceof CloudVoiceJoinError
      )
        throw error;
      throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
    } finally {
      record.pending = false;
    }
  }

  /** Final response-delivery check. Possessing a copied grant/token object is
   * insufficient; it must be this call's exact prepared response and still live.
   */
  assertPreparedCurrent(
    context: CloudAccessContext,
    id: string,
    response: PreparedCloudVoice,
  ): void {
    this.policy.authorizeCall(context, id, 'mutate');
    const record = this.calls.get(id);
    if (!record) throw new CloudAccessError('NOT_FOUND');
    if (!record.reservation)
      throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
    this.authorizedReservation(
      context,
      record,
      record.reservation,
      (controller) => {
        if (
          record.prepared !== response ||
          !record.reservation ||
          record.sid ||
          this.time() >= response.grant.expiresAt ||
          controller.leaseId !== response.grant.controller.leaseId ||
          controller.tabId !== response.grant.controller.tabId ||
          controller.epoch !== response.grant.controller.epoch
        )
          throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
      },
    );
  }

  /** Joined calls use current lease/budget authority, not the initial token's
   * join deadline. Renewal may keep a joined call live; it never renews a ticket.
   */
  assertJoinedCurrent(id: string): void {
    const record = this.calls.get(id);
    if (!record?.prepared || !record.sid || !record.reservation)
      throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
    this.authorizedReservation(
      record.context,
      record,
      record.reservation,
      () => undefined,
    );
  }

  /** Called only after Twilio signature/account and the manager's nonce,
   * identity/SID conflict validation. Wrong capabilities never bind a SID or
   * trigger another call's cleanup. A valid late SID is retained for cleanup.
   */
  consume(fields: CloudVoiceJoinFields): 'join' | 'replay' | 'cleanup' {
    const id = data(fields, 'sessionId');
    const nonce = data(fields, 'nonce');
    const from = data(fields, 'From');
    const sid = data(fields, 'CallSid');
    const join = data(fields, 'join');
    const record = typeof id === 'string' ? this.calls.get(id) : undefined;
    if (
      !record ||
      record.disposed ||
      !record.prepared ||
      nonce !== record.call.nonce ||
      from !== `client:${record.call.identity}` ||
      typeof sid !== 'string' ||
      !callSid.test(sid) ||
      typeof join !== 'string' ||
      !sameCapability(join, record.prepared.join) ||
      (record.sid !== undefined && record.sid !== sid)
    )
      throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
    let active = true;
    try {
      if (!record.reservation)
        throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
      this.authorizedReservation(
        record.context,
        record,
        record.reservation,
        (controller) => {
          if (
            !record.reservation ||
            (!record.sid && this.time() >= record.prepared!.grant.expiresAt) ||
            controller.leaseId !== record.prepared!.grant.controller.leaseId ||
            controller.tabId !== record.prepared!.grant.controller.tabId ||
            controller.epoch !== record.prepared!.grant.controller.epoch
          )
            throw new CloudVoiceJoinError('INVALID_VOICE_JOIN');
        },
      );
    } catch {
      active = false;
    }
    // One synchronous consumption, with idempotence for the same Twilio SID.
    // No browser retry can spend it on a second leg or another call.
    const repeated = record.sid === sid;
    record.sid = sid;
    if (!active) return 'cleanup';
    return repeated ? 'replay' : 'join';
  }

  /** Cleanup never requires a newly valid browser session. The owning service
   * calls this after confirmed line cleanup, not after a mere hangup request.
   * Failed release remains retryable and does not claim successful persistence.
   */
  async releaseCall(id: string): Promise<void> {
    const record = this.calls.get(id);
    if (!record) return;
    await this.releaseRecord(record);
  }

  private async releaseRecord(record: RecordEntry): Promise<void> {
    if (!record.reservation) return;
    if (record.releaseTask) {
      await record.releaseTask;
      return;
    }
    const held = record.reservation;
    this.unconfirmedReleases.add(record);
    const task = Promise.resolve().then(() => {
      const released = held.release();
      if (!released || typeof released.then !== 'function')
        throw new CloudVoiceJoinError('VOICE_CONNECTION_NOT_READY');
      return released;
    });
    record.releaseTask = task;
    try {
      await task;
      if (record.reservation === held) record.reservation = undefined;
      this.unconfirmedReleases.delete(record);
      if (record.disposed && this.calls.get(record.call.callId) === record)
        this.calls.delete(record.call.callId);
    } finally {
      if (record.releaseTask === task) record.releaseTask = undefined;
    }
  }
}
