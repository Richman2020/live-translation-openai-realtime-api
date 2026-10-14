import type WebSocket from 'ws';

import type { CallContextSnapshot } from './call-context';
import type { TranslationRole } from './translation-bridge';

export type AliyunPlanBRegion = 'beijing' | 'singapore';
export type AliyunPlanBConfig = Readonly<{
  region: AliyunPlanBRegion;
  apiKey: string;
  proxyUrl?: string;
  asrModel: 'fun-asr-realtime';
  textModel: 'qwen-mt-flash';
  ttsModel: 'cosyvoice-v3-flash';
  voice: 'loongandy_v3';
  sampleRate: 24000;
  webSocketUrl: string;
  translationUrl: string;
}>;
export type PlanBSocketFactory = (
  address: string,
  options: WebSocket.ClientOptions,
) => WebSocket;
export type PlanBUsage = {
  layer: 'asr' | 'translation' | 'tts';
  role: TranslationRole;
  taskSequence: number;
  region: AliyunPlanBRegion;
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
  /** Provider cumulative task counters, not a verified invoice. */
  basis: 'provider_reported' | 'unknown';
};
export type PlanBEvidence = {
  layer: 'asr' | 'translation' | 'tts' | 'pipeline';
  event:
    | 'configured'
    | 'ready'
    | 'request'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'correction';
  role: TranslationRole;
  region: AliyunPlanBRegion;
  sequence?: number;
  model?: string;
  voice?: 'loongandy_v3';
  sampleRate?: 24000;
  code?: string;
};
export type PlanBAsrSource = {
  sequence: number;
  revision: number;
  text: string;
  final: boolean;
  /** Role-specific input stream times, anchored when its task starts. */
  at: number;
  endAt?: number;
};
export type PlanBAsrOptions = {
  config: AliyunPlanBConfig;
  role: TranslationRole;
  createWebSocket?: PlanBSocketFactory;
  now?: () => number;
  timeoutMs?: number;
  onSource: (source: PlanBAsrSource) => void;
  onError: (code: string) => void;
  onUsage?: (usage: PlanBUsage) => void;
  onEvidence?: (evidence: PlanBEvidence) => void;
  getContext?: () => CallContextSnapshot;
};
export type PlanBAsrClient = {
  ready: Promise<void>;
  append(pcm24k: Buffer): void;
  finish(): Promise<void>;
  abort(): void;
};
export type PlanBTranslationOptions = {
  config: AliyunPlanBConfig;
  role: TranslationRole;
  text: string;
  context: CallContextSnapshot;
  sequence: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onDelta?: (text: string) => void;
  onUsage?: (usage: PlanBUsage) => void;
  onEvidence?: (evidence: PlanBEvidence) => void;
};
export type PlanBTranslationResult = {
  text: string;
  usage?: PlanBUsage;
};
export type PlanBTtsOptions = {
  config: AliyunPlanBConfig;
  createWebSocket?: PlanBSocketFactory;
  timeoutMs?: number;
  onUsage?: (usage: PlanBUsage) => void;
  onEvidence?: (evidence: PlanBEvidence) => void;
};
export type PlanBTtsClient = {
  synthesize(
    text: string,
    sequence: number,
    signal?: AbortSignal,
  ): AsyncIterable<Buffer>;
  abort(): void;
};
