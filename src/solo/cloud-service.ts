import twilio from 'twilio';
import type { FastifyInstance } from 'fastify';

import type { CloudServiceConfig } from './cloud-service-config';
import { ConfigStore, SETTING_NAMES } from './config';
import { CloudControllerLeases } from './controller-lease';
import {
  CLOUD_VOICE_SIGNALING_LIFETIME_MS,
  CloudVoiceJoin,
  type CloudVoiceGrant,
  type CloudVoiceAdmission,
  type CloudVoiceSigner,
} from './cloud-voice-join';
import { CloudPhoneAccess } from './cloud-phone-access';
import { GoogleBrowserLogin } from './google-login';
import { GoogleOidcClient } from './google-oidc';
import {
  SessionManager,
  createSessionBridge,
  twilioProvider,
  type BridgeOptions,
  type BridgeLike,
  type CallProvider,
} from './session-manager';
import { buildCloudControlledServer } from './server';
import { createCloudIngress } from './cloud-ingress';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;

/** Persistent listeners keep a second signal available after uncertain cleanup.
 * A successful drain removes them and lets the closed process exit naturally.
 */
export function registerCloudServiceSignals(
  service: { close: () => Promise<void> },
  options: {
    signals?: {
      on: (event: 'SIGINT' | 'SIGTERM', handler: () => void) => unknown;
      removeListener: (
        event: 'SIGINT' | 'SIGTERM',
        handler: () => void,
      ) => unknown;
    };
    onCleanupFailure?: () => void;
  } = {},
): () => void {
  const signals = options.signals || process;
  let handler: () => void;
  const dispose = () => {
    signals.removeListener('SIGINT', handler);
    signals.removeListener('SIGTERM', handler);
  };
  handler = () => {
    service
      .close()
      .then(dispose)
      .catch(() => options.onCleanupFailure?.());
  };
  signals.on('SIGINT', handler);
  signals.on('SIGTERM', handler);
  return dispose;
}

/** Locked SDK, local signing only. The signed callback still consumes the
 * separate one-call join capability; this JWT cannot enforce one call itself.
 */
export function createCloudVoiceSigner(
  config: CloudServiceConfig,
  now: () => number = Date.now,
): CloudVoiceSigner {
  return async (grant: CloudVoiceGrant) => {
    const time = now();
    const expiry = grant?.tokenExpiresAt;
    if (
      !Number.isSafeInteger(time) ||
      time < 0 ||
      grant?.version !== 1 ||
      grant.incomingAllow !== false ||
      ![
        grant.identity,
        grant.callId,
        grant.authSessionId,
        grant.principalId,
        grant.browserOwnerId,
        grant.controller?.leaseId,
        grant.controller?.tabId,
      ].every((value) => typeof value === 'string' && identifier.test(value)) ||
      grant.identity === 'ai-phone' ||
      !Number.isSafeInteger(grant.authEpoch) ||
      grant.authEpoch < 0 ||
      !Number.isSafeInteger(grant.controller?.epoch) ||
      grant.controller.epoch < 0 ||
      !Number.isSafeInteger(grant.issuedAt) ||
      grant.issuedAt > time ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt - grant.issuedAt > 60000 ||
      grant.expiresAt - time < 1000 ||
      !Number.isSafeInteger(grant.authExpiresAt) ||
      !Number.isSafeInteger(expiry) ||
      expiry < grant.expiresAt ||
      expiry > grant.authExpiresAt ||
      expiry - grant.issuedAt > CLOUD_VOICE_SIGNALING_LIFETIME_MS ||
      expiry <= time ||
      grant.outgoingApplicationSid !== config.providers.TWILIO_TWIML_APP_SID ||
      grant.outgoing?.callId !== grant.callId ||
      grant.outgoing?.identity !== grant.identity
    )
      throw new Error('CLOUD_VOICE_SIGNING_DENIED');
    const ttl = Math.floor((expiry - time) / 1000);
    // The SDK treats ttl=0 as its one-hour default: reject sub-second grants.
    if (ttl < 1) throw new Error('CLOUD_VOICE_SIGNING_DENIED');
    const access = new twilio.jwt.AccessToken(
      config.providers.TWILIO_ACCOUNT_SID,
      config.providers.TWILIO_API_KEY_SID,
      config.providers.TWILIO_API_KEY_SECRET,
      { identity: grant.identity, ttl },
    );
    access.addGrant(
      new twilio.jwt.AccessToken.VoiceGrant({
        incomingAllow: false,
        outgoingApplicationSid: config.providers.TWILIO_TWIML_APP_SID,
      }),
    );
    const token = access.toJwt();
    // The SDK uses its own Date.now(). Validate its actual encoded expiration
    // rather than assuming an injected application clock controls the signer.
    const encoded = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    if (
      !Number.isSafeInteger(encoded.exp) ||
      encoded.exp * 1000 > expiry ||
      encoded.exp * 1000 <= now()
    )
      throw new Error('CLOUD_VOICE_SIGNING_DENIED');
    return token;
  };
}

/** Expiry closes admission synchronously before the asynchronous cleanup. A
 * failed cleanup keeps the server and recovery journal available for retry.
 */
export function createCloudTestDeadline(options: {
  deadline: number;
  now?: () => number;
  cleanup: () => Promise<void>;
  onCleanupFailure?: () => void;
}) {
  const now = options.now || Date.now;
  const initialTime = now();
  if (
    !Number.isSafeInteger(initialTime) ||
    initialTime < 0 ||
    !Number.isSafeInteger(options.deadline) ||
    options.deadline <= initialTime ||
    options.deadline - initialTime > 3600000 ||
    typeof options.cleanup !== 'function'
  )
    throw new Error('CLOUD_TEST_DEADLINE_INVALID');
  let expired = false;
  let cancelled = false;
  let cleanupTask: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval>;
  const expireIfDue = (): Promise<void> | undefined => {
    if (!expired && now() >= options.deadline) expired = true;
    if (!expired || cancelled) return cleanupTask;
    clearInterval(timer);
    if (!cleanupTask) {
      cleanupTask = (async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            // eslint-disable-next-line no-await-in-loop -- Bounded safety cleanup, never new calls.
            await options.cleanup();
            return;
          } catch (error) {
            if (attempt === 2 || cancelled) throw error;
            // eslint-disable-next-line no-await-in-loop -- At most two one-second retry delays.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 1000);
            });
          }
        }
      })();
      cleanupTask.catch(() => {
        try {
          options.onCleanupFailure?.();
        } catch {
          // A diagnostic subscriber must not replace the cleanup failure.
        }
      });
    }
    return cleanupTask;
  };
  timer = setInterval(expireIfDue, 250);
  timer.unref();
  return Object.freeze({
    assertCurrent(): void {
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) {
        expired = true;
        expireIfDue();
        throw new Error('CLOUD_TEST_EXPIRED');
      }
      if (expired || time >= options.deadline) {
        expired = true;
        expireIfDue();
        throw new Error('CLOUD_TEST_EXPIRED');
      }
    },
    expireIfDue,
    cancel(): void {
      expired = true;
      cancelled = true;
      clearInterval(timer);
    },
  });
}

/** Personal call occupancy only: no money, duration, storage or provider request.
 * VoiceJoin independently revalidates login, controller, nonce and app binding.
 * Releasing occupancy still requires confirmed cleanup of this call's legs.
 */
export function createPersonalVoiceAdmission(
  manager: SessionManager,
): CloudVoiceAdmission {
  return Object.freeze({
    reserve: async (grant: CloudVoiceGrant) => {
      let released = false;
      const assertCurrent = () => {
        const call = manager.activeSession;
        if (
          released ||
          call?.id !== grant.callId ||
          ['ending', 'completed', 'failed'].includes(call.status)
        )
          throw new Error('CALL_AUTHORIZATION_REVOKED');
      };
      assertCurrent();
      return Object.freeze({
        assertCurrent,
        release: async () => {
          if (!manager.isCleanupConfirmed(grant.callId))
            throw new Error('CALL_CLEANUP_UNCONFIRMED');
          released = true;
        },
      });
    },
  });
}

/** All components share one process and authenticated personal call admission.
 * Optional transport factories are explicit offline test ports, never env or
 * HTTP switches and never production defaults. Startup contacts no provider.
 */
export async function createCloudService(
  config: CloudServiceConfig,
  options: {
    now?: () => number;
    publicDir?: string;
    providerFactory?: (
      settings: CloudServiceConfig['providers'],
    ) => CallProvider;
    bridgeFactory?: (settings: BridgeOptions) => BridgeLike;
    googleFetch?: typeof fetch;
    onCleanupFailure?: () => void;
  } = {},
) {
  const now = options.now || Date.now;
  let login: GoogleBrowserLogin | undefined;
  let manager: SessionManager | undefined;
  let control: CloudPhoneAccess | undefined;
  let app: FastifyInstance | undefined;
  let ingress: ReturnType<typeof createCloudIngress> | undefined;
  let closeTask: Promise<void> | undefined;
  const close = (): Promise<void> => {
    login?.close();
    if (closeTask) return closeTask;
    closeTask = (async () => {
      // A rejection preserves callback transport; keep uncertain provider
      // cleanup retryable and never report an unconfirmed leg as ended.
      await manager?.close();
      await control?.close();
      await ingress?.close();
      await app?.close();
    })();
    closeTask.catch(() => {
      closeTask = undefined;
    });
    return closeTask;
  };
  try {
    login = new GoogleBrowserLogin({
      client: new GoogleOidcClient({
        ...config.google,
        ...(options.googleFetch ? { fetch: options.googleFetch } : {}),
        now,
      }),
      publicOrigin: config.runtime.publicOrigin,
      now,
    });
    manager = new SessionManager({
      providerFactory: options.providerFactory || twilioProvider,
      bridgeFactory: (settings) =>
        (options.bridgeFactory || createSessionBridge)({
          ...settings,
          outgoingCaptions: config.outgoingPairedCaptions,
          captionFailureEndsCall: true,
        }),
      now,
      maxCallMs: null,
      allowedTarget: config.allowedTarget,
    });
    const leases = new CloudControllerLeases({ policy: login.policy, now });
    const voice = new CloudVoiceJoin({
      policy: login.policy,
      outgoingApplicationSid: config.providers.TWILIO_TWIML_APP_SID,
      now,
      signer: createCloudVoiceSigner(config, now),
      admission: createPersonalVoiceAdmission(manager),
    });
    const assertSnapshot = (settings: CloudServiceConfig['providers']) => {
      if (
        SETTING_NAMES.some((name) => settings[name] !== config.providers[name])
      )
        throw new Error('CLOUD_CONFIG_CHANGED');
    };
    control = new CloudPhoneAccess({
      policy: login.policy,
      manager,
      controllerLeases: leases,
      voiceJoin: voice,
      allowedTranslationEngines: ['continuous-captions'],
      defaultTranslationEngine: 'continuous-captions',
      outgoingPairedCaptions: config.outgoingPairedCaptions,
      publicReadinessChecker: async (settings) => {
        if (settings.PUBLIC_BASE_URL !== config.runtime.publicOrigin)
          throw new Error('CLOUD_CONFIG_CHANGED');
        return { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
      },
      translationReadinessChecker: async (settings, engine) => {
        assertSnapshot(settings);
        if (engine !== 'continuous-captions')
          throw new Error('CLOUD_TRANSLATION_ENGINE_DENIED');
        return {
          name: 'personalTestConfiguration',
          status: 'passed',
          code: 'CONFIGURED_FOR_PERSONAL_TEST_NOT_LIVE_VERIFIED',
        };
      },
    });
    const store = new ConfigStore({
      values: config.providers,
      generateToken: false,
    });
    app = await buildCloudControlledServer({
      runtime: config.runtime,
      configStore: store,
      sessionManager: manager,
      browserControl: control,
      googleLogin: login,
      ...(options.publicDir ? { publicDir: options.publicDir } : {}),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('CLOUD_PRIVATE_LISTENER_FAILED');
    ingress = createCloudIngress({
      runtime: config.runtime,
      upstreamPort: address.port,
    });
    await new Promise<void>((resolveStarted, reject) => {
      ingress.server.once('error', reject);
      ingress.server.listen(config.runtime.port, config.runtime.host, () => {
        ingress.server.removeListener('error', reject);
        resolveStarted();
      });
    });
    return Object.freeze({
      app,
      ingress,
      manager,
      control,
      login,
      close: () => close(),
    });
  } catch (error) {
    await close();
    throw error;
  }
}
