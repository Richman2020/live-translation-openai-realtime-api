import { isAbsolute, resolve } from 'node:path';

import { parsePhoneRuntime, type CloudPhoneRuntime } from './cloud-runtime';
import { checkConfig, type SoloConfig } from './config';
import { GoogleOidcClient } from './google-oidc';
import { GOOGLE_LOGIN_PATHS } from './google-login';
import type { CloudTrialBudgetPolicy } from './cloud-budget-journal';
import { selectCloudServiceMode } from './cloud-web-verification-config';

type Environment = Readonly<Record<string, string | undefined>>;
export type CloudServiceConfig = Readonly<{
  runtime: CloudPhoneRuntime;
  providers: SoloConfig;
  google: Readonly<ConstructorParameters<typeof GoogleOidcClient>[0]>;
  testDeadline: number;
  journalDirectory: string;
  budget: CloudTrialBudgetPolicy;
  outgoingPairedCaptions: boolean;
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
  'CLOUD_TRANSLATION_CAPABILITY_CONFIRMED',
  'CLOUD_PUBLIC_CALLBACK_CONFIRMED',
  'CLOUD_TEST_DEADLINE',
  'CLOUD_TEST_TARGET_NUMBER',
  'CLOUD_JOURNAL_DIRECTORY',
  'CLOUD_JOURNAL_VOLUME_CONFIRMED',
  'CLOUD_CALL_RESERVATION_USD_MICROS',
  'CLOUD_RATE_CHECKED_AT',
  'CLOUD_RATE_VALID_UNTIL',
  'CLOUD_TRIAL_RATE_BOUND_CONFIRMED',
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
function instant(env: Environment, name: string): number {
  const value = required(env, name, 32);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`CLOUD_CONFIG_INVALID:${name}`);
  return parsed;
}

/** An explicitly configured, one-hour, single-call trial. Confirmation flags
 * are operator attestations, never API probes or evidence of a real call.
 * The default THREE OpenAI sockets use gpt-realtime-translate, gpt-4o-transcribe
 * and gpt-realtime-1.5. Explicit outgoing paired captions add gpt-live-transcribe
 * and a second gpt-realtime-1.5 session. Confirmation covers the selected mode,
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
    OPENAI_API_KEY: required(env, 'OPENAI_API_KEY'),
    OPENAI_REALTIME_MODEL: 'gpt-realtime-1.5',
    OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
    OPENAI_PROXY_URL: '',
    LOCAL_ACCESS_TOKEN: '',
  };
  const invalid = checkConfig(providers).find(
    (check) => check.name !== 'LOCAL_ACCESS_TOKEN' && check.status !== 'ready',
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
  confirmed(env, 'CLOUD_TRANSLATION_CAPABILITY_CONFIRMED');
  confirmed(env, 'CLOUD_PUBLIC_CALLBACK_CONFIRMED');
  confirmed(env, 'CLOUD_TRIAL_RATE_BOUND_CONFIRMED');
  confirmed(env, 'CLOUD_JOURNAL_VOLUME_CONFIRMED');
  const testDeadline = instant(env, 'CLOUD_TEST_DEADLINE');
  if (testDeadline <= now || testDeadline - now > 3600000)
    throw new Error('CLOUD_TEST_DEADLINE_INVALID');
  const checkedAt = instant(env, 'CLOUD_RATE_CHECKED_AT');
  const validUntil = instant(env, 'CLOUD_RATE_VALID_UNTIL');
  if (
    checkedAt > now ||
    validUntil < testDeadline ||
    validUntil - checkedAt > 86400000
  )
    throw new Error('CLOUD_RATE_EVIDENCE_EXPIRED');
  const journalDirectory = required(env, 'CLOUD_JOURNAL_DIRECTORY');
  if (
    !isAbsolute(journalDirectory) ||
    resolve(journalDirectory) !== journalDirectory ||
    journalDirectory === '/' ||
    journalDirectory === '/tmp' ||
    journalDirectory.startsWith('/tmp/')
  )
    throw new Error('CLOUD_PERSISTENT_VOLUME_REQUIRED');
  const allowedTarget = required(env, 'CLOUD_TEST_TARGET_NUMBER', 12);
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(allowedTarget))
    throw new Error('CLOUD_CONFIG_INVALID:CLOUD_TEST_TARGET_NUMBER');
  const charge = required(env, 'CLOUD_CALL_RESERVATION_USD_MICROS', 7);
  const worstCaseCallUsdMicros = Number(charge);
  if (
    !/^[1-9]\d*$/.test(charge) ||
    !Number.isSafeInteger(worstCaseCallUsdMicros) ||
    worstCaseCallUsdMicros > 5_000_000
  )
    throw new Error('CLOUD_CONFIG_INVALID:CLOUD_CALL_RESERVATION_USD_MICROS');
  const budget: CloudTrialBudgetPolicy = Object.freeze({
    allowedTarget,
    accountSid: providers.TWILIO_ACCOUNT_SID,
    applicationSid: providers.TWILIO_TWIML_APP_SID,
    budgetUsdMicros: 5_000_000,
    worstCaseCallUsdMicros,
    maxCalls: 1,
    maxWallClockMs: 300000,
    maxInputBytes: 72_000_000,
    maxOutputBytes: 72_000_000,
    lateCallbackWindowMs: 60000,
    rates: Object.freeze({
      twilioReference: 'https://www.twilio.com/en-us/voice/pricing/us',
      openaiReference: 'https://openai.com/api/pricing/',
      checkedAt,
      validUntil: testDeadline,
    }),
  });
  return Object.freeze({
    runtime: Object.freeze(runtime),
    providers: Object.freeze(providers),
    google,
    testDeadline,
    journalDirectory,
    budget,
    outgoingPairedCaptions,
  });
}
