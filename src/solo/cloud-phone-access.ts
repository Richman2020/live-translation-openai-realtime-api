import { randomBytes } from 'node:crypto';

import {
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessAction,
  type CloudAccessContext,
} from './cloud-access';
import type { SoloConfig } from './config';
import {
  CloudControllerLeases,
  type BoundControllerLease,
  type ControllerProof,
} from './controller-lease';
import { CloudVoiceJoin, type PreparedCloudVoice } from './cloud-voice-join';
import type { checkPublicReadiness } from './public-readiness';
import type { checkTranslationEngine } from './provider-checks';
import { SessionError, SessionManager, type CallView } from './session-manager';
import type { TranslationEngine } from './translation-engine';

export type PreparedCloudCall = Readonly<{
  to: string;
  translationEngine: TranslationEngine;
}>;
export type CloudCleanupIntent = Readonly<{ callId: string }>;
export type CloudPhoneEvent = Readonly<{ event: string; data: unknown }>;

const eventNames = new Set([
  'call',
  'transcript',
  'conversation',
  'translation-connection',
  'caption-status',
  'translation-audio',
  'caption-input',
  'translation-provider',
  'translation-input',
  'translation-metric',
  'error',
]);

/** Server-only dependency bundle, not login or durable recovery.
 * Every side-effect dependency is explicit; no real provider/readiness fallback.
 * Startup remains local-only. Tests supply isolated identities and fake backends.
 */
export class CloudPhoneAccess {
  readonly policy: CloudAccessPolicy;

  readonly manager: SessionManager;

  readonly controllerLeases: CloudControllerLeases;

  private readonly voiceJoin?: CloudVoiceJoin;

  private readonly publicReadinessChecker: typeof checkPublicReadiness;

  private readonly translationReadinessChecker: typeof checkTranslationEngine;

  private readonly prepared = new WeakMap<
    PreparedCloudCall,
    {
      context: CloudAccessContext;
      config: SoloConfig;
      controller: BoundControllerLease;
    }
  >();

  private readonly intents = new WeakMap<CloudCleanupIntent, string>();

  private readonly issuedVoice = new WeakMap<
    PreparedCloudVoice,
    {
      context: CloudAccessContext;
      callId: string;
      controller: BoundControllerLease;
    }
  >();

  private readonly calls = new Map<
    string,
    {
      context: CloudAccessContext;
      controller: BoundControllerLease;
      joined: boolean;
    }
  >();

  private readonly cleaning = new Set<string>();

  private readonly releasing = new Map<string, Promise<void>>();

  private preparing = false;

  private readonly maxCalls: number;

  private readonly timer: ReturnType<typeof setInterval>;

  constructor(options: {
    policy: CloudAccessPolicy;
    manager: SessionManager;
    controllerLeases: CloudControllerLeases;
    voiceJoin?: CloudVoiceJoin;
    publicReadinessChecker: typeof checkPublicReadiness;
    translationReadinessChecker: typeof checkTranslationEngine;
    maxCalls?: number;
    revalidationIntervalMs?: number;
  }) {
    const maxCalls = options?.maxCalls ?? 100;
    const interval = options?.revalidationIntervalMs ?? 1000;
    if (
      !(options?.policy instanceof CloudAccessPolicy) ||
      !(options.manager instanceof SessionManager) ||
      !options.manager.hasExplicitControlDependencies ||
      !(options.controllerLeases instanceof CloudControllerLeases) ||
      options.controllerLeases.policy !== options.policy ||
      (options.voiceJoin !== undefined &&
        (!(options.voiceJoin instanceof CloudVoiceJoin) ||
          options.voiceJoin.policy !== options.policy)) ||
      typeof options.publicReadinessChecker !== 'function' ||
      typeof options.translationReadinessChecker !== 'function' ||
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 100 ||
      !Number.isSafeInteger(interval) ||
      interval < 10 ||
      interval > 1000
    )
      throw new CloudAccessError('FORBIDDEN');
    this.policy = options.policy;
    this.manager = options.manager;
    this.controllerLeases = options.controllerLeases;
    this.voiceJoin = options.voiceJoin;
    this.publicReadinessChecker = options.publicReadinessChecker;
    this.translationReadinessChecker = options.translationReadinessChecker;
    this.maxCalls = maxCalls;
    this.timer = setInterval(() => this.checkLifecycle(), interval);
    this.timer.unref();
  }

  assertConfig(config: SoloConfig): void {
    if (
      config.PUBLIC_BASE_URL !== this.policy.publicOrigin ||
      (this.voiceJoin &&
        this.voiceJoin.outgoingApplicationSid !== config.TWILIO_TWIML_APP_SID)
    )
      throw new CloudAccessError('FORBIDDEN');
  }

  acquireController(context: CloudAccessContext, tabId: string) {
    this.releaseCompletedCalls();
    return this.controllerLeases.acquire(context, tabId, {
      busy:
        this.preparing ||
        this.manager.controlAdmissionBlocked ||
        !!this.voiceJoin?.cleanupUnconfirmed,
    });
  }

  renewController(context: CloudAccessContext, proof: ControllerProof) {
    return this.controllerLeases.renew(context, proof);
  }

  revokeController(context: CloudAccessContext, proof: ControllerProof): void {
    this.controllerLeases.authorize(context, proof);
    this.controllerLeases.revoke(context, proof);
    const active = this.manager.activeSession;
    if (active && this.calls.has(active.id))
      this.cleanupOwnedCall(active.id, 'CONTROLLER_REVOKED');
  }

  private authorizeController(
    context: CloudAccessContext,
    proof: ControllerProof,
    callId?: string,
  ): BoundControllerLease {
    const controller = this.controllerLeases.authorize(context, proof);
    if (callId !== undefined) {
      const original = this.calls.get(callId)?.controller;
      if (
        !original ||
        controller.leaseId !== original.leaseId ||
        controller.tabId !== original.tabId ||
        controller.epoch !== original.epoch
      )
        throw new CloudAccessError('FORBIDDEN');
      this.controllerLeases.authorizeCurrent(original);
    }
    return controller;
  }

  recheckController(
    context: CloudAccessContext,
    proof: ControllerProof,
    callId?: string,
  ): void {
    if (callId !== undefined) this.readAccess(context, callId, 'mutate');
    this.authorizeController(context, proof, callId);
  }

  async prepareVoice(
    context: CloudAccessContext,
    callId: string,
    proof: ControllerProof,
  ) {
    this.readAccess(context, callId, 'mutate');
    const controller = this.authorizeController(context, proof, callId);
    if (!this.voiceJoin)
      throw new SessionError('VOICE_CONNECTION_NOT_READY', 503);
    const result = await this.voiceJoin.prepareGrant(context, callId);
    this.readAccess(context, callId, 'mutate');
    this.controllerLeases.authorizeCurrent(controller);
    if (
      this.manager.isCleanupConfirmed(callId) ||
      this.manager.activeSession?.id !== callId
    )
      throw new CloudAccessError('FORBIDDEN');
    this.issuedVoice.set(result, { context, callId, controller });
    return result;
  }

  /** The token response itself is a private issued capability, checked by the
   * actual route's final onSend hook after asynchronous response preparation. */
  assertVoiceResponseCurrent(
    context: CloudAccessContext,
    callId: string,
    response: PreparedCloudVoice,
  ): void {
    const issued = this.issuedVoice.get(response);
    if (!issued || issued.context !== context || issued.callId !== callId)
      throw new CloudAccessError('UNAUTHORIZED');
    this.readAccess(context, callId, 'mutate');
    this.controllerLeases.authorizeCurrent(issued.controller);
    this.voiceJoin.assertPreparedCurrent(context, callId, response);
    const active = this.manager.activeSession;
    if (
      active?.id !== callId ||
      ['ending', 'completed', 'failed'].includes(active.status)
    )
      throw new CloudAccessError('FORBIDDEN');
  }

  async prepareCreate(
    context: CloudAccessContext,
    config: SoloConfig,
    to: string,
    translationEngine: TranslationEngine = 'pocket-prefix',
    proof?: ControllerProof,
  ): Promise<PreparedCloudCall> {
    this.policy.revalidate(context, 'mutate');
    this.releaseCompletedCalls();
    const controller = this.authorizeController(context, proof);
    this.assertConfig(config);
    if (typeof to !== 'string') throw new SessionError('INVALID_DESTINATION');
    if (
      translationEngine !== 'pocket-prefix' &&
      translationEngine !== 'pocket-captions'
    )
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
    if (this.preparing || this.manager.activeSession)
      throw new SessionError('BUSY', 409);
    if (this.voiceJoin?.cleanupUnconfirmed)
      throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 409);
    if (this.calls.size >= this.maxCalls)
      throw new CloudAccessError('FORBIDDEN');
    this.preparing = true;
    try {
      const snapshot = Object.freeze({ ...config });
      let ready: Awaited<ReturnType<typeof checkPublicReadiness>>;
      try {
        ready = await this.publicReadinessChecker(snapshot);
      } catch {
        throw new SessionError('CLOUD_READINESS_UNAVAILABLE', 503);
      }
      this.policy.revalidate(context, 'mutate');
      this.controllerLeases.authorizeCurrent(controller);
      if (ready?.status !== 'ready')
        throw new SessionError('PUBLIC_CALLBACK_UNREACHABLE', 503);
      {
        let translation: Awaited<ReturnType<typeof checkTranslationEngine>>;
        try {
          translation = await this.translationReadinessChecker(
            snapshot,
            translationEngine,
          );
        } catch {
          throw new SessionError('CLOUD_READINESS_UNAVAILABLE', 503);
        }
        this.policy.revalidate(context, 'mutate');
        this.controllerLeases.authorizeCurrent(controller);
        if (translation?.status !== 'passed')
          throw new SessionError('TRANSLATION_ENGINE_UNAVAILABLE', 503);
      }
      const result = Object.freeze({ to: to.trim(), translationEngine });
      this.prepared.set(result, { context, config: snapshot, controller });
      return result;
    } finally {
      this.preparing = false;
    }
  }

  createPrepared(prepared: PreparedCloudCall) {
    const state = this.prepared.get(prepared);
    if (!state) throw new CloudAccessError('UNAUTHORIZED');
    this.prepared.delete(prepared);
    this.releaseCompletedCalls();
    if (this.voiceJoin?.cleanupUnconfirmed)
      throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 409);
    if (this.calls.size >= this.maxCalls)
      throw new CloudAccessError('FORBIDDEN');
    let callId: string | undefined;
    let rollback: (() => void) | undefined;
    let rollbackVoice: (() => void) | undefined;
    const authorizeCurrent = () => {
      this.policy.revalidate(state.context, 'mutate');
      this.controllerLeases.authorizeCurrent(state.controller);
      if (callId !== undefined)
        this.policy.authorizeCall(state.context, callId, 'mutate');
      if (callId !== undefined && this.calls.get(callId)?.joined)
        this.voiceJoin.assertJoinedCurrent(callId);
    };
    try {
      return this.policy.runAuthorizedSession(state.context, 'mutate', () =>
        this.manager.createOutbound(
          state.config,
          prepared.to,
          prepared.translationEngine,
          {
            browserIdentity: `cloud-phone-${randomBytes(18).toString('hex')}`,
            deferBrowserJoin: true,
            authorizeBrowserJoin: (fields) => {
              if (!this.voiceJoin)
                throw new SessionError('VOICE_CONNECTION_NOT_READY', 503);
              const result = this.voiceJoin.consume({
                sessionId: fields.sessionId,
                nonce: fields.nonce,
                From: fields.From,
                CallSid: fields.CallSid,
                join: fields.join,
              });
              if (result === 'join' || result === 'replay')
                this.calls.get(callId).joined = true;
              return result;
            },
            authorizeCurrent,
            beforePublish: (id, connection) => {
              if (callId !== undefined) throw new CloudAccessError('FORBIDDEN');
              rollback = this.policy.registerCallWithRollback(
                state.context,
                id,
              );
              this.calls.set(id, {
                context: state.context,
                controller: state.controller,
                joined: false,
              });
              callId = id;
              if (this.voiceJoin)
                rollbackVoice = this.voiceJoin.registerCall(
                  state.context,
                  {
                    callId: id,
                    identity: connection.identity,
                    nonce: connection.nonce,
                  },
                  () => {
                    if (
                      this.manager.hasSession(id) &&
                      (this.manager.activeSession?.id !== id ||
                        ['ending', 'completed', 'failed'].includes(
                          this.manager.activeSession.status,
                        ))
                    )
                      throw new CloudAccessError('FORBIDDEN');
                    return this.controllerLeases.authorizeCurrent(
                      state.controller,
                    );
                  },
                );
            },
          },
        ),
      );
    } catch (error) {
      if (callId !== undefined && !this.manager.hasSession(callId)) {
        rollback?.();
        rollbackVoice?.();
        this.calls.delete(callId);
      } else if (callId !== undefined)
        this.cleanupOwnedCall(callId, 'CALL_CREATION_FAILED');
      throw error;
    }
  }

  readAccess(
    context: CloudAccessContext,
    callId: string,
    action: CloudAccessAction = 'read',
  ): void {
    this.policy.revalidate(context, action);
    if (!this.calls.has(callId)) throw new CloudAccessError('NOT_FOUND');
    this.policy.authorizeCall(context, callId, action);
  }

  ownedActive(context: CloudAccessContext): CallView | null {
    return this.policy.runAuthorizedSession(context, 'read', () => {
      const active = this.manager.activeSession;
      if (!active) return null;
      try {
        this.readAccess(context, active.id);
        return active;
      } catch (error) {
        if (error instanceof CloudAccessError && error.code === 'NOT_FOUND')
          return null;
        throw error;
      }
    });
  }

  /** Informational browser bootstrap. A claimed tab only selects a read-only
   * status projection; no controller proof, provider settings or Voice token is
   * recovered here, and neither this read nor an SSE reconnect renews a lease. */
  browserSession(context: CloudAccessContext, tabId?: string) {
    return this.policy.runAuthorizedSession(context, 'read', () => ({
      mode: 'controlled' as const,
      csrfToken: this.policy.currentCsrfToken(context),
      controller: this.controllerLeases.status(context, tabId),
      activeSession: this.ownedActive(context),
      busy:
        this.preparing ||
        this.manager.controlAdmissionBlocked ||
        !!this.voiceJoin?.cleanupUnconfirmed,
      translationEngines: ['pocket-prefix', 'pocket-captions'] as const,
      defaultTranslationEngine: 'pocket-prefix' as const,
    }));
  }

  beginHangup(
    context: CloudAccessContext,
    callId: string,
    proof?: ControllerProof,
  ): CloudCleanupIntent {
    this.readAccess(context, callId, 'mutate');
    const controller = this.authorizeController(context, proof, callId);
    let accepted = false;
    try {
      this.policy.runAuthorizedCall(context, callId, 'mutate', () => {
        this.controllerLeases.authorizeCurrent(controller);
        accepted = true;
        this.manager.beginEndIntent(callId);
      });
    } catch (error) {
      // A synchronous observer can throw after the accepted intent stopped media.
      // Preserve ownership and drain cleanup; failed authorization never enters.
      if (accepted) this.cleanupOwnedCall(callId, 'CALL_END_REQUEST_FAILED');
      throw error;
    }
    const intent = Object.freeze({ callId });
    this.intents.set(intent, callId);
    return intent;
  }

  async finishHangup(intent: CloudCleanupIntent): Promise<void> {
    const callId = this.intents.get(intent);
    if (!callId) throw new CloudAccessError('UNAUTHORIZED');
    // Cleanup of an accepted server intent must continue after owner revocation.
    await this.manager.end(callId);
    await this.releaseConfirmedCall(callId);
  }

  recheckCleanup(context: CloudAccessContext, callId: string): boolean {
    this.readAccess(context, callId, 'mutate');
    return this.policy.runAuthorizedCall(context, callId, 'mutate', () =>
      this.manager.isCleanupConfirmed(callId),
    );
  }

  runAuthorizedEvent(
    context: CloudAccessContext,
    event: CloudPhoneEvent,
    commit: () => void,
  ): boolean {
    this.policy.revalidate(context, 'read');
    if (
      !eventNames.has(event?.event) ||
      !event.data ||
      typeof event.data !== 'object'
    )
      return false;
    const callId = Object.getOwnPropertyDescriptor(
      event.data,
      event.event === 'call' ? 'id' : 'sessionId',
    )?.value;
    if (typeof callId !== 'string' || !this.calls.has(callId)) return false;
    try {
      this.policy.runAuthorizedCall(context, callId, 'read', commit);
      return true;
    } catch (error) {
      if (error instanceof CloudAccessError && error.code === 'NOT_FOUND')
        return false;
      throw error;
    }
  }

  authorizeEvents(
    context: CloudAccessContext,
    event: CloudPhoneEvent,
  ): boolean {
    return this.runAuthorizedEvent(context, event, () => undefined);
  }

  private checkLifecycle(): void {
    this.releaseCompletedCalls();
    const active = this.manager.activeSession;
    const state = active && this.calls.get(active.id);
    if (!active || !state || this.cleaning.has(active.id)) return;
    try {
      this.policy.authorizeCall(state.context, active.id, 'mutate');
      this.controllerLeases.authorizeCurrent(state.controller);
      if (state.joined) this.voiceJoin.assertJoinedCurrent(active.id);
      return;
    } catch {
      // This is private safety cleanup, not a fresh browser mutation permission.
    }
    this.cleanupOwnedCall(active.id, 'BROWSER_AUTH_EXPIRED');
  }

  private cleanupOwnedCall(callId: string, reason: string): void {
    if (this.cleaning.has(callId)) return;
    this.cleaning.add(callId);
    try {
      this.manager.beginEndIntent(callId, reason);
    } catch {
      // A subscriber failure must not stop the independent safety cleanup.
    }
    try {
      this.manager
        .end(callId)
        .then(() => this.releaseConfirmedCall(callId))
        .catch(() => {})
        .finally(() => this.cleaning.delete(callId));
    } catch {
      this.cleaning.delete(callId);
    }
  }

  private releaseCompletedCalls(): void {
    for (const callId of this.calls.keys())
      if (this.manager.isCleanupConfirmed(callId))
        this.releaseConfirmedCall(callId).catch(() => {});
  }

  private releaseConfirmedCall(callId: string): Promise<void> {
    if (!this.voiceJoin || !this.manager.isCleanupConfirmed(callId))
      return Promise.resolve();
    const existing = this.releasing.get(callId);
    if (existing) return existing;
    const task = this.voiceJoin.releaseCall(callId).finally(() => {
      if (this.releasing.get(callId) === task) this.releasing.delete(callId);
    });
    this.releasing.set(callId, task);
    return task;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all(
      [...this.calls.keys()].map((id) => this.releaseConfirmedCall(id)),
    );
  }
}
