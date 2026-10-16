import type {
  LiveTranslateProtocolDiagnostic,
  LiveTranslateVoicePolicy,
} from '../experiments/livetranslate-types';

export const LIVE_TRANSLATE_PHONE_FAILURE_CODES = [
  'LIVETRANSLATE_PHONE_CONFIGURATION_INVALID',
  'LIVETRANSLATE_PHONE_SESSION_FAILED',
  'LIVETRANSLATE_PHONE_CALLBACK_FAILED',
  'LIVETRANSLATE_PHONE_AUDIO_INVALID',
  'LIVETRANSLATE_PHONE_AUDIO_ORDER_INVALID',
  'LIVETRANSLATE_PHONE_AUDIO_BACKLOG',
  'LIVETRANSLATE_PHONE_PLAYBACK_TIMEOUT',
  'LIVETRANSLATE_PHONE_REMOTE_AUDIO_FORBIDDEN',
] as const;
export type LiveTranslatePhoneFailureCode =
  (typeof LIVE_TRANSLATE_PHONE_FAILURE_CODES)[number];
export const LIVE_TRANSLATE_PHONE_WARNING_CODES = [
  'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT',
  'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING',
  'LIVETRANSLATE_MULTIPLE_ITEMS_FOR_SOURCE',
] as const;

/** Metadata only: no supplier IDs, free-form errors, transcript, audio, URL,
 * credentials or phone numbers. Playback marks only prove queue drainage. */
export type LiveTranslatePhoneDiagnostic = {
  clock: 'application_epoch_ms';
  role: 'local' | 'remote';
  at: number;
  stage:
    | 'configuration'
    | 'voice_evidence'
    | 'protocol_failure'
    | 'warning'
    | 'input_received'
    | 'association'
    | 'source_started'
    | 'source_stopped'
    | 'source_final'
    | 'translation_completed'
    | 'audio_first_sample'
    | 'response_created'
    | 'response_completed'
    | 'playback_queued'
    | 'playback_drained'
    | 'usage'
    | 'failed';
  code?: string;
  fatal?: true;
  eventType?: LiveTranslateProtocolDiagnostic['eventType'];
  validationPath?: LiveTranslateProtocolDiagnostic['validationPath'];
  expected?: LiveTranslateProtocolDiagnostic['expected'];
  actualType?: LiveTranslateProtocolDiagnostic['actualType'];
  conflictKind?: LiveTranslateProtocolDiagnostic['conflictKind'];
  receiveSequence?: number;
  sequence?: number;
  sourceSequence?: number;
  responseSequence?: number;
  bytes?: number;
  queuedBytes?: number;
  outstandingAudioMs?: number;
  providerAudioMs?: number;
  providerEndpointBasis?: 'provider_stream_estimate';
  inputAudioMs?: number;
  basis?: 'model_input_submitted';
  actualPlaybackStartAt?: null;
  closeCode?: number;
  httpStatusCode?: number;
  model?: 'qwen3.8-livetranslate-flash-realtime';
  requestedVoice?: 'Andre' | 'Tina';
  topLevelVoice?: 'Andre' | 'Tina' | 'Aiden' | null;
  nestedVoice?: 'Andre' | 'Tina' | 'Aiden' | null;
  responseVoice?: 'Andre' | 'Tina' | 'Aiden' | null;
  voiceEvent?:
    | 'session.created'
    | 'session.updated'
    | 'response.created'
    | 'response.done';
  topLevelVoiceStatus?:
    | 'missing'
    | 'reported'
    | 'unsupported_value'
    | 'invalid_type';
  nestedVoiceStatus?:
    | 'missing'
    | 'reported'
    | 'unsupported_value'
    | 'invalid_type';
  responseVoiceStatus?:
    | 'missing'
    | 'reported'
    | 'unsupported_value'
    | 'invalid_type';
  voicePolicy?: LiveTranslateVoicePolicy['mode'];
  voiceCloneEnabled?: false | null;
  inputSampleRate?: 16000;
  outputSampleRate?: 24000;
  targetLanguage?: 'en' | 'zh';
  usageBasis?: 'provider_reported' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputAudioTokens?: number;
  inputTextTokens?: number;
  outputAudioTokens?: number;
  outputTextTokens?: number;
};
