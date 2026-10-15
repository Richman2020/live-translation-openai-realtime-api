import { buildLiveTranslateEndpoint } from '../experiments/livetranslate-client';
import { validOpenAIProxyUrl } from './openai-websocket';

export type LiveTranslatePhoneConfig = Readonly<{
  region: 'beijing';
  workspaceId: string;
  apiKey: string;
  model: 'qwen3.8-livetranslate-flash-realtime';
  voice: 'Andre';
  proxyUrl?: string;
}>;
const validKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  value === value.trim() &&
  ![...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

/** Selected server-side only. No arbitrary endpoint, region or voice fallback. */
export function assertLiveTranslatePhoneConfig(
  config: LiveTranslatePhoneConfig,
): void {
  if (
    config?.region !== 'beijing' ||
    config.model !== 'qwen3.8-livetranslate-flash-realtime' ||
    config.voice !== 'Andre' ||
    !validKey(config.apiKey) ||
    (config.proxyUrl !== undefined &&
      (!config.proxyUrl || !validOpenAIProxyUrl(config.proxyUrl)))
  )
    throw new Error('CLOUD_LIVETRANSLATE_CONFIG_INVALID');
  try {
    buildLiveTranslateEndpoint(config.workspaceId);
  } catch {
    throw new Error('CLOUD_LIVETRANSLATE_WORKSPACE_INVALID');
  }
}

/** Call only after the explicit provider selection; the default reads no key. */
export function parseLiveTranslatePhoneConfig(
  env: Readonly<Record<string, string | undefined>>,
): LiveTranslatePhoneConfig {
  const fixed = {
    ALIYUN_LIVETRANSLATE_REGION: 'beijing',
    ALIYUN_LIVETRANSLATE_MODEL: 'qwen3.8-livetranslate-flash-realtime',
    ALIYUN_LIVETRANSLATE_VOICE: 'Andre',
  };
  for (const [name, value] of Object.entries(fixed))
    if (env[name] !== undefined && env[name] !== value)
      throw new Error(`CLOUD_LIVETRANSLATE_CONFIG_INVALID:${name}`);
  const apiKey = env.ALIYUN_BEIJING_API_KEY;
  if (!validKey(apiKey))
    throw new Error('CLOUD_LIVETRANSLATE_KEY_MISSING:ALIYUN_BEIJING_API_KEY');
  const config: LiveTranslatePhoneConfig = {
    region: 'beijing',
    workspaceId: env.ALIYUN_LIVETRANSLATE_WORKSPACE_ID ?? '',
    apiKey,
    model: 'qwen3.8-livetranslate-flash-realtime',
    voice: 'Andre',
    ...(env.ALIYUN_LIVETRANSLATE_PROXY_URL !== undefined
      ? { proxyUrl: env.ALIYUN_LIVETRANSLATE_PROXY_URL }
      : {}),
  };
  assertLiveTranslatePhoneConfig(config);
  return Object.freeze(config);
}
