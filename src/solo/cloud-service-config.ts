import { parsePhoneRuntime, type CloudPhoneRuntime } from './cloud-runtime';
import { checkConfig, type SoloConfig } from './config';
import { GoogleOidcClient } from './google-oidc';
import { GOOGLE_LOGIN_PATHS } from './google-login';
import { selectCloudServiceMode } from './cloud-web-verification-config';
import {
  parsePhoneTranslationSelection,
  type PhoneTranslationSelection,
} from './aliyun-planb-config';

type Environment = Readonly<Record<string, string | undefined>>;
export type CloudServiceConfig = Readonly<{
  runtime: CloudPhoneRuntime;
  providers: SoloConfig;
  google: Readonly<ConstructorParameters<typeof GoogleOidcClient>[0]>;
  allowedTarget: string;
  outgoingPairedCaptions: boolean;
  /** Trusted startup snapshot. Omitted by older callers means OpenAI. */
  translationProvider?: PhoneTranslationSelection;
}>;

/** Names only. This parser never prints, copies, creates or persists credentials. */
export const CLOUD_SERVICE_REQUIRED_ENV = Object.freeze([
  'AI_PHONE_RUNTIME_MODE',
  'PORT',
  'CLOUD_PUBLIC_ORIGIN',
  'PUBLIC_BASE_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_CALLER_NUMBER',
  'OPENAI_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_ALLOWED_EMAIL',
  'CLOUD_PUBLIC_CALLBACK_CONFIRMED',
  'CLOUD_TEST_TARGET_NUMBER',
] as const);

function required(env: Environment, name: string, maximum = 4096): string {
  const value = env[name];
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\r\n\0]/.test(value)
  )
    throw new Error(`CLOUD_CONFIG_INVALID:${name}`);
  return value;
}
function confirmed(env: Environment, name: string): void {
  if (required(env, name) !== 'true')
    throw new Error(`CLOUD_CONFIG_UNCONFIRMED:${name}`);
}
/** Personal service with one active call. Callback confirmation is an operator
 * attestation; model availability is tested by the actual connection handshake,
 * not by a pre-filled claim that a first test has already succeeded.
 * The default THREE OpenAI sockets use gpt-realtime-translate, gpt-4o-transcribe
 * and gpt-realtime-1.5. Explicit outgoing paired captions add gpt-live-transcribe
 * and a second gpt-realtime-1.5 session. Configuration covers the selected mode,
 * including its separate subtitle charges. whisper-1 remains the locked
 * SoloConfig default; these caption clients use their own models.
 */
export function parseCloudServiceConfig(
  env: Environment,
  now = Date.now(),
): CloudServiceConfig {
  if (selectCloudServiceMode(env) !== 'phone')
    throw new Error('CLOUD_PHONE_MODE_REQUIRED');
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('CLOUD_CLOCK_INVALID');
  if (env.AI_PHONE_RUNTIME_MODE !== 'cloud')
    throw new Error('CLOUD_RUNTIME_REQUIRED');
  const captions = env.CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(captions))
    throw new Error(
      'CLOUD_CONFIG_INVALID:CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED',
    );
  const outgoingPairedCaptions = captions === 'true';
  const translationProvider = parsePhoneTranslationSelection(env);
  const runtime = parsePhoneRuntime(env);
  if (runtime.mode !== 'cloud') throw new Error('CLOUD_RUNTIME_REQUIRED');
  if (required(env, 'PUBLIC_BASE_URL') !== runtime.publicOrigin)
    throw new Error('CLOUD_PUBLIC_ORIGIN_MISMATCH');
  if (
    (env.OPENAI_REALTIME_MODEL &&
      env.OPENAI_REALTIME_MODEL !== 'gpt-realtime-1.5') ||
    (env.OPENAI_TRANSCRIPTION_MODEL &&
      env.OPENAI_TRANSCRIPTION_MODEL !== 'whisper-1') ||
    env.OPENAI_PROXY_URL
  )
    throw new Error('CLOUD_PROVIDER_MODEL_OR_ROUTE_CHANGED');
  const providers: SoloConfig = {
    API_HOST: '127.0.0.1',
    API_PORT: '5050',
    PUBLIC_BASE_URL: runtime.publicOrigin,
    TWILIO_ACCOUNT_SID: required(env, 'TWILIO_ACCOUNT_SID'),
    TWILIO_AUTH_TOKEN: required(env, 'TWILIO_AUTH_TOKEN'),
    TWILIO_API_KEY_SID: required(env, 'TWILIO_API_KEY_SID'),
    TWILIO_API_KEY_SECRET: required(env, 'TWILIO_API_KEY_SECRET'),
    TWILIO_TWIML_APP_SID: required(env, 'TWILIO_TWIML_APP_SID'),
    TWILIO_CALLER_NUMBER: required(env, 'TWILIO_CALLER_NUMBER'),
    // No OpenAI credential is read or required for an explicit Aliyun call.
    OPENAI_API_KEY:
      translationProvider.provider === 'aliyun-plan-b'
        ? ''
        : required(env, 'OPENAI_API_KEY'),
    OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
    OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
    OPENAI_PROXY_URL: '',
    LOCAL_ACCESS_TOKEN: '',
  };
  const invalid = checkConfig(providers).find(
    (check) =>
      check.name !== 'LOCAL_ACCESS_TOKEN' &&
      !(
        translationProvider.provider === 'aliyun-plan-b' &&
        check.name === 'OPENAI_API_KEY'
      ) &&
      check.status !== 'ready',
  );
  if (invalid) throw new Error(`CLOUD_CONFIG_INVALID:${invalid.name}`);

  const google = Object.freeze({
    clientId: required(env, 'GOOGLE_CLIENT_ID', 256),
    clientSecret: required(env, 'GOOGLE_CLIENT_SECRET', 1024),
    allowedEmail: required(env, 'GOOGLE_ALLOWED_EMAIL', 254),
    redirectUri: `${runtime.publicOrigin}${GOOGLE_LOGIN_PATHS.callback}`,
    ...(env.GOOGLE_HOSTED_DOMAIN
      ? { expectedHostedDomain: required(env, 'GOOGLE_HOSTED_DOMAIN', 253) }
      : {}),
    ...(env.GOOGLE_SUBJECT
      ? { pinnedGoogleSubject: required(env, 'GOOGLE_SUBJECT', 255) }
      : {}),
  });
  // Construction validates one configured identity and performs no HTTP call.
  // eslint-disable-next-line no-new -- Validate without creating a login registry.
  new GoogleOidcClient(google);
  confirmed(env, 'CLOUD_PUBLIC_CALLBACK_CONFIRMED');
  const allowedTarget = required(env, 'CLOUD_TEST_TARGET_NUMBER', 12);
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(allowedTarget))
    throw new Error('CLOUD_CONFIG_INVALID:CLOUD_TEST_TARGET_NUMBER');
  return Object.freeze({
    runtime: Object.freeze(runtime),
    providers: Object.freeze(providers),
    google,
    allowedTarget,
    outgoingPairedCaptions,
    translationProvider,
  });
}
