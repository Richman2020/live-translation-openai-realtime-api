import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type LocalPhoneRuntime = { mode: 'local' };
export type CloudPhoneRuntime = {
  mode: 'cloud';
  host: '0.0.0.0';
  port: number;
  publicOrigin: string;
  mediaOrigin: string;
  warmInstances: 1;
};
export type PhoneRuntime = LocalPhoneRuntime | CloudPhoneRuntime;

/** Resolve deployment requirements separately from local UI/provider settings. */
export function parsePhoneRuntime(env: RuntimeEnvironment): PhoneRuntime {
  const mode = env.AI_PHONE_RUNTIME_MODE || 'local';
  if (mode === 'local') return { mode };
  if (mode !== 'cloud') throw new Error('INVALID_AI_PHONE_RUNTIME_MODE');

  const rawPort = env.PORT || '';
  if (!/^\d+$/.test(rawPort) || +rawPort < 1 || +rawPort > 65535)
    throw new Error('INVALID_CLOUD_PORT');
  if ((env.CLOUD_WARM_INSTANCES || '1') !== '1')
    throw new Error('CLOUD_REQUIRES_SINGLE_WARM_INSTANCE');

  let url: URL;
  try {
    url = new URL(env.CLOUD_PUBLIC_ORIGIN || '');
  } catch {
    throw new Error('INVALID_CLOUD_PUBLIC_ORIGIN');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(
      url.hostname,
    ) ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.includes('*') ||
    /^127\./.test(url.hostname) ||
    url.hostname.startsWith('[::ffff:7f')
  )
    throw new Error('INVALID_CLOUD_PUBLIC_ORIGIN');

  return {
    mode,
    host: '0.0.0.0',
    port: +rawPort,
    publicOrigin: url.origin,
    mediaOrigin: url.origin.replace(/^https:/, 'wss:'),
    warmInstances: 1,
  };
}

/** Read the same private env file as ConfigStore; process env takes precedence. */
export function loadPhoneRuntime(
  options: { envPath?: string; environment?: RuntimeEnvironment } = {},
): PhoneRuntime {
  const envPath = options.envPath || resolve('.env');
  if (existsSync(envPath) && lstatSync(envPath).isSymbolicLink())
    throw new Error('Configuration must not be a symbolic link');
  const disk = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  return parsePhoneRuntime({
    ...disk,
    ...(options.environment || process.env),
  });
}

/** A parsed cloud plan must never enable the existing single-owner local API. */
export function requireLocalPhoneRuntime(
  runtime: PhoneRuntime,
): asserts runtime is LocalPhoneRuntime {
  if (runtime.mode === 'cloud')
    throw new Error(
      'CLOUD_AUTH_NOT_IMPLEMENTED: cloud startup is disabled until browser authentication, owner isolation and disconnect cleanup are implemented.',
    );
}
