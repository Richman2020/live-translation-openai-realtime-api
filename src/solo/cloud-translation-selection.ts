import { createAliyunPlanBBridge } from './aliyun-planb-bridge';
import {
  freezePhoneTranslationSelection,
  type PhoneTranslationSelection,
} from './aliyun-planb-config';
import type { AliyunPlanBConfig } from './aliyun-planb-types';
import { createLiveTranslatePhoneBridge } from './livetranslate-phone-bridge';
import type { LiveTranslatePhoneConfig } from './livetranslate-phone-config';
import {
  createSessionBridge,
  type BridgeOptions,
  type BridgeLike,
} from './session-manager';

export type CloudTranslationFactories = {
  openai?: (settings: BridgeOptions) => BridgeLike;
  planB?: (settings: BridgeOptions, config: AliyunPlanBConfig) => BridgeLike;
  liveTranslate?: (
    settings: BridgeOptions,
    config: LiveTranslatePhoneConfig,
  ) => BridgeLike;
};

/** Freeze once when the service starts; every call captures this choice before
 * media attachment. Browser input and supplier failures never select a provider. */
export function createCloudTranslationBridgeFactory(
  selection?: PhoneTranslationSelection,
  factories: CloudTranslationFactories = {},
): (settings: BridgeOptions) => BridgeLike {
  const snapshot = freezePhoneTranslationSelection(selection);
  if (
    snapshot.provider === 'aliyun-plan-b' &&
    snapshot.config.region !== 'beijing'
  )
    throw new Error('CLOUD_PLAN_B_REGION_DENIED');
  const openai = factories.openai ?? createSessionBridge;
  const planB =
    factories.planB ??
    ((settings, config) =>
      createAliyunPlanBBridge(
        { ...settings, remoteCaptions: true },
        { config },
      ));
  const liveTranslate =
    factories.liveTranslate ??
    ((settings, config) =>
      createLiveTranslatePhoneBridge(
        { ...settings, remoteCaptions: true, outgoingCaptions: false },
        { config },
      ));
  return (settings) => {
    if (snapshot.provider === 'openai') return openai(settings);
    if (snapshot.provider === 'aliyun-livetranslate') {
      if (settings.translationEngine !== 'continuous-captions')
        throw new Error('CLOUD_LIVETRANSLATE_ENGINE_DENIED');
      return liveTranslate(
        { ...settings, outgoingCaptions: false, captionFailureEndsCall: false },
        snapshot.config,
      );
    }
    if (settings.translationEngine !== 'continuous-captions')
      throw new Error('CLOUD_PLAN_B_ENGINE_DENIED');
    // Paired Plan B transcripts are from the same ASR/MT pipeline; no additional
    // native/outgoing OpenAI caption clients may be constructed here.
    return planB({ ...settings, outgoingCaptions: false }, snapshot.config);
  };
}
