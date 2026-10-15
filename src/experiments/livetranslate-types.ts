import type WebSocket from 'ws';

export type LiveTranslateRole = 'local' | 'remote';
export type LiveTranslateSession = {
  sessionId: string;
  role: LiveTranslateRole;
  model: 'qwen3.8-livetranslate-flash-realtime';
  voice: 'Tina';
  inputSampleRate: 16000;
  outputSampleRate: 24000;
  outputModalities: readonly ('text' | 'audio')[];
};
export type LiveTranslateSource = {
  role: LiveTranslateRole;
  sessionId: string;
  sourceId: string;
  revision: number;
  text: string;
  final: boolean;
  speakerId?: number;
  startMs?: number;
  endMs?: number;
  at: number;
};
export type LiveTranslateAssociation = {
  role: LiveTranslateRole;
  sessionId: string;
  translationId: string;
  sourceId: string;
};
export type LiveTranslateTranslation = {
  role: LiveTranslateRole;
  sessionId: string;
  translationId: string;
  responseId: string;
  sourceId?: string;
  pairing: 'explicit' | 'unpaired';
  revision: number;
  text: string;
  final: boolean;
  at: number;
};
export type LiveTranslateAudioMetadata = {
  role: LiveTranslateRole;
  sessionId: string;
  translationId: string;
  responseId: string;
  sourceId?: string;
  pairing: 'explicit' | 'unpaired';
  eventId: string;
  /** Local contiguous playback-submission order after response FIFO; not a supplier chunk sequence. */
  sequence: number;
};
export type LiveTranslateTiming = {
  role: LiveTranslateRole;
  sessionId: string;
  stage:
    | 'response_created'
    | 'translation_completed'
    | 'source_started'
    | 'source_stopped'
    | 'source_final'
    | 'translation_first_delta'
    | 'audio_first_sample'
    | 'response_completed';
  at: number;
  sourceId?: string;
  translationId?: string;
  responseId?: string;
  providerAudioMs?: number;
};
export type LiveTranslateUsage = {
  role: LiveTranslateRole;
  sessionId: string;
  responseId: string;
  basis: 'provider_reported' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputAudioTokens?: number;
  inputTextTokens?: number;
  outputAudioTokens?: number;
  outputTextTokens?: number;
};
export type LiveTranslateClientOptions = {
  enabled?: boolean;
  role: LiveTranslateRole;
  workspaceId: string;
  apiKey: string;
  proxyUrl?: string;
  timeoutMs?: number;
  now?: () => number;
  createWebSocket?: (
    url: string,
    settings: WebSocket.ClientOptions,
  ) => WebSocket;
  onSource?: (event: LiveTranslateSource) => void;
  onTranslation?: (event: LiveTranslateTranslation) => void;
  onAssociation?: (event: LiveTranslateAssociation) => void;
  onAudio?: (pcm24k: Buffer, metadata: LiveTranslateAudioMetadata) => void;
  onTiming?: (event: LiveTranslateTiming) => void;
  onUsage?: (event: LiveTranslateUsage) => void;
  onError?: (code: string, diagnostic: { closeCode?: number }) => void;
};
export type LiveTranslateClient = {
  ready: Promise<LiveTranslateSession>;
  append(pcm16k: Buffer): void;
  finish(): Promise<void>;
  abort(): void;
};

/** Exact fixed local diagnoses; arbitrary provider text/prefixes never qualify. */
export const LIVE_TRANSLATE_FAILURE_CODES = [
  'LIVETRANSLATE_RESPONSE_ORDER_UNKNOWN',
  'LIVETRANSLATE_RESPONSE_AUDIO_MISSING',
  'LIVETRANSLATE_AUDIO_QUEUE_LIMIT',
  'LIVETRANSLATE_ASR_FAILED',
  'LIVETRANSLATE_AUDIO_INVALID',
  'LIVETRANSLATE_CALLBACK_FAILED',
  'LIVETRANSLATE_CANCELLED',
  'LIVETRANSLATE_CONFIGURATION_REJECTED',
  'LIVETRANSLATE_CONFIG_INVALID',
  'LIVETRANSLATE_CONNECTION_CLOSED',
  'LIVETRANSLATE_CONNECTION_FAILED',
  'LIVETRANSLATE_DISABLED',
  'LIVETRANSLATE_EVENT_CAPACITY',
  'LIVETRANSLATE_EVENT_CONFLICT',
  'LIVETRANSLATE_EVENT_INVALID',
  'LIVETRANSLATE_FINISH_INCOMPLETE',
  'LIVETRANSLATE_FINISH_TIMEOUT',
  'LIVETRANSLATE_INPUT_INVALID',
  'LIVETRANSLATE_ITEM_CAPACITY',
  'LIVETRANSLATE_ITEM_CONFLICT',
  'LIVETRANSLATE_MODALITY_MISMATCH',
  'LIVETRANSLATE_MODEL_EVENT_MISMATCH',
  'LIVETRANSLATE_NOT_READY',
  'LIVETRANSLATE_OUTPUT_BEFORE_READY',
  'LIVETRANSLATE_PROVIDER_REJECTED',
  'LIVETRANSLATE_PROXY_INVALID',
  'LIVETRANSLATE_READY_TIMEOUT',
  'LIVETRANSLATE_RESPONSE_INCOMPLETE',
  'LIVETRANSLATE_SEND_FAILED',
  'LIVETRANSLATE_SEND_UNAVAILABLE',
  'LIVETRANSLATE_SESSION_MISMATCH',
  'LIVETRANSLATE_SOURCE_CONFLICT',
  'LIVETRANSLATE_TRANSCRIPT_INVALID',
  'LIVETRANSLATE_UNEXPECTED_AUDIO',
  'LIVETRANSLATE_UNEXPECTED_FINISH',
  'LIVETRANSLATE_WORKSPACE_INVALID',
] as const;
const failureCodes = new Set<string>(LIVE_TRANSLATE_FAILURE_CODES);
export function isLiveTranslateFailureCode(
  value: unknown,
): value is (typeof LIVE_TRANSLATE_FAILURE_CODES)[number] {
  return typeof value === 'string' && failureCodes.has(value);
}
