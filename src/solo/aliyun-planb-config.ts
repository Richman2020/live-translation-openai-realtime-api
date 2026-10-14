import type {
  AliyunPlanBConfig,
  AliyunPlanBRegion,
} from './aliyun-planb-types';
import { validOpenAIProxyUrl } from './openai-websocket';

export const PLAN_B_ENDPOINTS = Object.freeze({
  beijing: Object.freeze({
    webSocketUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    translationUrl:
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyName: 'ALIYUN_BEIJING_API_KEY',
  }),
  singapore: Object.freeze({
    webSocketUrl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
    translationUrl:
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyName: 'ALIYUN_SINGAPORE_API_KEY',
  }),
});
export type PhoneTranslationSelection = Readonly<
  | { provider: 'openai' }
  | { provider: 'aliyun-plan-b'; config: AliyunPlanBConfig }
>;

/** Default-off. Disabled selection never even reads regional credential fields. */
export function parsePhoneTranslationSelection(
  env: Readonly<Record<string, string | undefined>>,
): PhoneTranslationSelection {
  const provider = env.CLOUD_PHONE_TRANSLATION_PROVIDER ?? 'openai';
  if (provider === 'openai') return Object.freeze({ provider });
  if (provider !== 'aliyun-plan-b')
    throw new Error(
      'CLOUD_PLAN_B_CONFIG_INVALID:CLOUD_PHONE_TRANSLATION_PROVIDER',
    );
  const region = env.ALIYUN_PLAN_B_REGION;
  if (region !== 'beijing' && region !== 'singapore')
    throw new Error('CLOUD_PLAN_B_CONFIG_INVALID:ALIYUN_PLAN_B_REGION');
  const endpoint = PLAN_B_ENDPOINTS[region];
  const fixed = {
    ALIYUN_PLAN_B_ASR_MODEL: 'fun-asr-realtime',
    ALIYUN_PLAN_B_MT_MODEL: 'qwen-mt-flash',
    ALIYUN_PLAN_B_TTS_MODEL: 'cosyvoice-v3-flash',
    ALIYUN_PLAN_B_VOICE: 'loongandy_v3',
    ALIYUN_PLAN_B_SAMPLE_RATE: '24000',
  };
  for (const [name, value] of Object.entries(fixed))
    if (env[name] !== undefined && env[name] !== value)
      throw new Error(`CLOUD_PLAN_B_CONFIG_INVALID:${name}`);
  const apiKey = env[endpoint.keyName];
  if (typeof apiKey !== 'string' || !apiKey.trim())
    throw new Error(`CLOUD_PLAN_B_KEY_MISSING:${endpoint.keyName}`);
  if (
    apiKey !== apiKey.trim() ||
    apiKey.length > 4096 ||
    [...apiKey].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`CLOUD_PLAN_B_CONFIG_INVALID:${endpoint.keyName}`);
  const proxyUrl = env.ALIYUN_PLAN_B_PROXY_URL;
  if (proxyUrl && !validOpenAIProxyUrl(proxyUrl))
    throw new Error('CLOUD_PLAN_B_CONFIG_INVALID:ALIYUN_PLAN_B_PROXY_URL');
  const config: AliyunPlanBConfig = Object.freeze({
    region,
    apiKey,
    ...(proxyUrl ? { proxyUrl } : {}),
    asrModel: 'fun-asr-realtime',
    textModel: 'qwen-mt-flash',
    ttsModel: 'cosyvoice-v3-flash',
    voice: 'loongandy_v3',
    sampleRate: 24000,
    webSocketUrl: endpoint.webSocketUrl,
    translationUrl: endpoint.translationUrl,
  });
  return Object.freeze({ provider, config });
}

/** Validate trusted snapshots before networking; endpoint override is denied. */
export function assertAliyunPlanBConfig(value: AliyunPlanBConfig): void {
  const endpoint = PLAN_B_ENDPOINTS[value?.region as AliyunPlanBRegion];
  if (
    !endpoint ||
    value?.webSocketUrl !== endpoint.webSocketUrl ||
    value.translationUrl !== endpoint.translationUrl ||
    value.asrModel !== 'fun-asr-realtime' ||
    value.textModel !== 'qwen-mt-flash' ||
    value.ttsModel !== 'cosyvoice-v3-flash' ||
    value.voice !== 'loongandy_v3' ||
    value.sampleRate !== 24000 ||
    typeof value.apiKey !== 'string' ||
    !value.apiKey.trim() ||
    value.apiKey.length > 4096 ||
    [...value.apiKey].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    (value.proxyUrl && !validOpenAIProxyUrl(value.proxyUrl))
  )
    throw new Error('PLAN_B_CONFIG_INVALID');
}

export function freezePhoneTranslationSelection(
  selection?: PhoneTranslationSelection,
): PhoneTranslationSelection {
  if (!selection || selection.provider === 'openai')
    return Object.freeze({ provider: 'openai' });
  if (selection.provider !== 'aliyun-plan-b')
    throw new Error('PLAN_B_CONFIG_INVALID');
  assertAliyunPlanBConfig(selection.config);
  return Object.freeze({
    provider: 'aliyun-plan-b',
    config: Object.freeze({ ...selection.config }),
  });
}
