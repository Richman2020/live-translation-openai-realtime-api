import { randomBytes } from 'node:crypto';

import {
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessAction,
  type CloudAccessContext,
} from './cloud-access';
import type { SoloConfig } from './config';
import type { checkPublicReadiness } from './public-readiness';
import type { checkTranslationEngine } from './provider-checks';
import { SessionError, SessionManager, type CallView } from './session-manager';
import {
  isTranslationEngine,
  type TranslationEngine,
} from './translation-engine';

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

/** Server-only dependency bundle, not login, lease, budget or durable recovery.
 * Every side-effect dependency is explicit; no real provider/readiness fallback.
 * Startup remains local-only. Tests supply isolated identities and fake backends.
 */
export class CloudPhoneAccess {
  readonly policy: CloudAccessPolicy;

  readonly manager: SessionManager;

  private readonly publicReadinessChecker: typeof checkPublicReadiness;

  private readonly translationReadinessChecker: typeof checkTranslationEngine;

  private readonly prepared = new WeakMap<
    PreparedCloudCall,
    { context: CloudAccessContext; config: SoloConfig }
  >();

  private readonly intents = new WeakMap<CloudCleanupIntent, string>();

  private readonly calls = new Map<string, CloudAccessContext>();

  private readonly cleaning = new Set<string>();

  private preparing = false;

  private readonly maxCalls: number;

  private readonly timer: ReturnType<typeof setInterval>;

  constructor(options: {
    policy: CloudAccessPolicy;
    manager: SessionManager;
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
    this.publicReadinessChecker = options.publicReadinessChecker;
    this.translationReadinessChecker = options.translationReadinessChecker;
    this.maxCalls = maxCalls;
    this.timer = setInterval(() => this.checkLifecycle(), interval);
    this.timer.unref();
  }

  assertConfig(config: SoloConfig): void {
    if (config.PUBLIC_BASE_URL !== this.policy.publicOrigin)
      throw new CloudAccessError('FORBIDDEN');
  }

  async prepareCreate(
    context: CloudAccessContext,
    config: SoloConfig,
    to: string,
    translationEngine: TranslationEngine = 'legacy',
  ): Promise<PreparedCloudCall> {
    this.policy.revalidate(context, 'mutate');
    this.assertConfig(config);
    if (typeof to !== 'string') throw new SessionError('INVALID_DESTINATION');
    if (!isTranslationEngine(translationEngine))
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
    if (this.preparing || this.manager.activeSession)
      throw new SessionError('BUSY', 409);
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
      if (ready?.status !== 'ready')
        throw new SessionError('PUBLIC_CALLBACK_UNREACHABLE', 503);
      if (translationEngine !== 'legacy') {
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
        if (translation?.status !== 'passed')
          throw new SessionError('TRANSLATION_ENGINE_UNAVAILABLE', 503);
      }
      const result = Object.freeze({ to: to.trim(), translationEngine });
      this.prepared.set(result, { context, config: snapshot });
      return result;
    } finally {
      this.preparing = false;
    }
  }

  createPrepared(prepared: PreparedCloudCall) {
    const state = this.prepared.get(prepared);
    if (!state) throw new CloudAccessError('UNAUTHORIZED');
    this.prepared.delete(prepared);
    if (this.calls.size >= this.maxCalls)
      throw new CloudAccessError('FORBIDDEN');
    let callId: string | undefined;
    let rollback: (() => void) | undefined;
    const authorizeCurrent = () => {
      this.policy.revalidate(state.context, 'mutate');
      if (callId !== undefined)
        this.policy.authorizeCall(state.context, callId, 'mutate');
    };
    try {
      return this.policy.runAuthorizedSession(state.context, 'mutate', () =>
        this.manager.createOutbound(
          state.config,
          prepared.to,
          prepared.translationEngine,
          {
            browserIdentity: `cloud-phone-${randomBytes(18).toString('hex')}`,
            authorizeCurrent,
            beforePublish: (id) => {
              if (callId !== undefined) throw new CloudAccessError('FORBIDDEN');
              rollback = this.policy.registerCallWithRollback(
                state.context,
                id,
              );
              this.calls.set(id, state.context);
              callId = id;
            },
          },
        ),
      );
    } catch (error) {
      if (callId !== undefined && !this.manager.hasSession(callId)) {
        rollback?.();
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

  beginHangup(context: CloudAccessContext, callId: string): CloudCleanupIntent {
    this.readAccess(context, callId, 'mutate');
    let accepted = false;
    try {
      this.policy.runAuthorizedCall(context, callId, 'mutate', () => {
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
    const active = this.manager.activeSession;
    const context = active && this.calls.get(active.id);
    if (!active || !context || this.cleaning.has(active.id)) return;
    try {
      this.policy.authorizeCall(context, active.id, 'mutate');
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
        .catch(() => {})
        .finally(() => this.cleaning.delete(callId));
    } catch {
      this.cleaning.delete(callId);
    }
  }

  close(): void {
    clearInterval(this.timer);
  }
}
