import { parsePhoneRuntime, type CloudPhoneRuntime } from './cloud-runtime';
import { GoogleOidcClient } from './google-oidc';
import { GOOGLE_LOGIN_PATHS } from './google-login';

type Environment = Readonly<Record<string, string | undefined>>;
export type CloudServiceMode = 'phone' | 'web-verification';
export type CloudWebVerificationConfig = Readonly<{
  mode: 'web-verification';
  runtime: CloudPhoneRuntime;
  google: Readonly<ConstructorParameters<typeof GoogleOidcClient>[0]>;
  testDeadline: number;
}>;

export const CLOUD_WEB_VERIFICATION_REQUIRED_ENV = Object.freeze([
  'CLOUD_SERVICE_MODE',
  'AI_PHONE_RUNTIME_MODE',
  'PORT',
  'CLOUD_PUBLIC_ORIGIN',
  'PUBLIC_BASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_ALLOWED_EMAIL',
  'CLOUD_TEST_DEADLINE',
] as const);

/** Only an absent setting selects the protected phone default. An empty or
 * unknown setting cannot silently select either service or grant calls.
 */
export function selectCloudServiceMode(env: Environment): CloudServiceMode {
  const mode = env.CLOUD_SERVICE_MODE;
  if (mode === undefined || mode === 'phone') return 'phone';
  if (mode === 'web-verification') return mode;
  throw new Error('CLOUD_SERVICE_MODE_INVALID');
}

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

/** No provider, budget, target or volume field is read here. The web service
 * cannot turn those values or operator confirmations into a call capability.
 */
export function parseCloudWebVerificationConfig(
  env: Environment,
  now = Date.now(),
): CloudWebVerificationConfig {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('CLOUD_CLOCK_INVALID');
  if (selectCloudServiceMode(env) !== 'web-verification')
    throw new Error('CLOUD_WEB_MODE_REQUIRED');
  if (env.AI_PHONE_RUNTIME_MODE !== 'cloud')
    throw new Error('CLOUD_RUNTIME_REQUIRED');
  const runtime = parsePhoneRuntime(env);
  if (runtime.mode !== 'cloud') throw new Error('CLOUD_RUNTIME_REQUIRED');
  if (
    required(env, 'CLOUD_PUBLIC_ORIGIN') !== runtime.publicOrigin ||
    required(env, 'PUBLIC_BASE_URL') !== runtime.publicOrigin
  )
    throw new Error('CLOUD_PUBLIC_ORIGIN_MISMATCH');

  const google = Object.freeze({
    clientId: required(env, 'GOOGLE_CLIENT_ID', 256),
    clientSecret: required(env, 'GOOGLE_CLIENT_SECRET', 1024),
    allowedEmail: required(env, 'GOOGLE_ALLOWED_EMAIL', 254),
    redirectUri: `${runtime.publicOrigin}${GOOGLE_LOGIN_PATHS.callback}`,
    ...(env.GOOGLE_HOSTED_DOMAIN !== undefined
      ? { expectedHostedDomain: required(env, 'GOOGLE_HOSTED_DOMAIN', 253) }
      : {}),
    ...(env.GOOGLE_SUBJECT !== undefined
      ? { pinnedGoogleSubject: required(env, 'GOOGLE_SUBJECT', 255) }
      : {}),
  });
  // eslint-disable-next-line no-new -- Validate the identity policy without contacting Google.
  new GoogleOidcClient(google);
  const rawDeadline = required(env, 'CLOUD_TEST_DEADLINE', 32);
  const testDeadline = Date.parse(rawDeadline);
  if (
    !Number.isSafeInteger(testDeadline) ||
    new Date(testDeadline).toISOString() !== rawDeadline
  )
    throw new Error('CLOUD_CONFIG_INVALID:CLOUD_TEST_DEADLINE');
  if (testDeadline <= now || testDeadline - now > 3_600_000)
    throw new Error('CLOUD_TEST_DEADLINE_INVALID');

  return Object.freeze({
    mode: 'web-verification',
    runtime: Object.freeze(runtime),
    google,
    testDeadline,
  });
}
