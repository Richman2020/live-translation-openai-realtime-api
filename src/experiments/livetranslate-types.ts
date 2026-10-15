import type WebSocket from 'ws';

export type LiveTranslateRole = 'local' | 'remote';
export type LiveTranslateSession = {
  sessionId: string;
  role: LiveTranslateRole;
  model: 'qwen3.8-livetranslate-flash-realtime';
  voice: 'Aiden';
  /** null means the provider omitted this field; never infer false from the request. */
  voiceCloneEnabled: false | null;
  voiceCloneConfirmation?: 'explicit_false' | 'missing_echo_warning';
  targetLanguage: 'en' | 'zh';
  configurationAcknowledgement: {
    eventId: string | null;
    receiveSequence?: number;
    receivedAt: number;
    basis: 'provider_session_updated';
  };
  inputSampleRate: 16000;
  outputSampleRate: 24000;
  outputModalities: readonly ('text' | 'audio')[];
};
/** Safe allow-listed configuration evidence; arbitrary supplier strings are excluded. */
export type LiveTranslateSessionConfiguration = {
  role: LiveTranslateRole;
  sessionId: string | null;
  eventId: string | null;
  receiveSequence?: number;
  receivedAt: number;
  basis: 'provider_session_updated';
  model: LiveTranslateSession['model'] | 'other' | null;
  voice: 'Aiden' | 'Tina' | 'other' | null;
  voiceCloneEnabled: boolean | null;
  targetLanguage: 'en' | 'zh' | 'other' | null;
  accepted: boolean;
};
export const LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES = [
  'error', 'session.created', 'session.updated', 'session.finished',
  'session.update', 'session.finish', 'input_audio_buffer.append',
  'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed', 'input_audio_buffer.cleared',
  'conversation.item.created',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'conversation.item.input_audio_transcription.text',
  'response.created', 'response.done', 'response.text.delta',
  'response.text.text', 'response.text.done',
  'response.audio_transcript.delta', 'response.audio_transcript.text',
  'response.audio_transcript.done', 'response.audio.delta', 'response.audio.done',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
] as const;
export type LiveTranslateProtocolEventType =
  (typeof LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES)[number] | 'unknown' | null;
export const LIVE_TRANSLATE_PROTOCOL_SCHEMA_PATHS = [
  'type', 'event_id', 'session_id', 'code', 'message', 'request_id',
  'error', 'error.type', 'error.code', 'error.message', 'error.param',
  'session', 'session.id', 'session.object', 'session.model',
  'session.input_modalities', 'session.output_modalities', 'session.voice',
  'session.enable_voice_clone', 'session.audio', 'session.audio.input',
  'session.audio.input.format', 'session.audio.input.format.type',
  'session.audio.input.format.sample_rate', 'session.audio.input.turn_detection',
  'session.audio.input.turn_detection.type',
  'session.audio.input.turn_detection.threshold',
  'session.audio.input.turn_detection.silence_duration_ms',
  'session.audio.output', 'session.audio.output.format',
  'session.audio.output.format.type', 'session.audio.output.format.sample_rate',
  'session.audio.output.voice', 'session.translation', 'session.translation.language',
  'response', 'response.id', 'response.object', 'response.status',
  'response.conversation_id', 'response.modalities', 'response.voice',
  'response.output_audio_format', 'response.output', 'response.usage',
  'response.output.0', 'response.output.0.id', 'response.output.0.type',
  'response.output.0.role', 'response.output.0.status', 'response.output.0.content',
  'response.output.0.content.0', 'response.output.0.content.0.type',
  'response.output.0.content.0.text', 'response.output.0.content.0.transcript',
  'response.usage.input_tokens', 'response.usage.output_tokens',
  'response.usage.total_tokens', 'response.usage.input_tokens_details',
  'response.usage.input_tokens_details.audio_tokens',
  'response.usage.input_tokens_details.text_tokens',
  'response.usage.output_tokens_details',
  'response.usage.output_tokens_details.audio_tokens',
  'response.usage.output_tokens_details.text_tokens',
  'response_id', 'item_id', 'previous_item_id', 'output_index', 'content_index',
  'delta', 'text', 'transcript', 'audio', 'audio_start_ms', 'audio_end_ms',
  'speaker_id', 'language', 'emotion', 'item', 'item.id', 'item.role',
  'item.object', 'item.type', 'item.status', 'item.content', 'part', 'part.type',
] as const;
export type LiveTranslateProtocolSchemaPath =
  (typeof LIVE_TRANSLATE_PROTOCOL_SCHEMA_PATHS)[number];
export type LiveTranslateProtocolValueType =
  'missing' | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' | 'binary';
export type LiveTranslateProtocolEvent = {
  role: LiveTranslateRole;
  at: number;
  stage: 'transport_open' | 'server_frame' | 'client_event_sent' |
    'configuration_accepted' | 'provider_error' | 'transport_close' |
    'transport_error' | 'transport_close_requested';
  eventType: LiveTranslateProtocolEventType;
  eventIdPresent: boolean;
  schema: Partial<Record<LiveTranslateProtocolSchemaPath, LiveTranslateProtocolValueType>>;
  unknownKeyCount: number;
  frameBytes?: number;
  frameBinary?: boolean;
  httpStatusCode?: number;
  closeCode?: number;
  providerError?: {
    shape: 'nested_error' | 'gateway_code';
    /** Only values explicitly illustrated by the current official events page. */
    code: 'invalid_value' | 'other' | null;
    type: 'invalid_request_error' | 'other' | null;
    /** Known protocol parameter paths; not an inferred provider error enumeration. */
    parameter: 'session.modalities' | 'session.voice' | 'session.output_modalities' |
      'session.enable_voice_clone' | 'session.translation.language' |
      'session.audio.input.format' | 'session.audio.output.format' | 'other' | null;
  };
};
export type LiveTranslateProtocolDiagnostic = {
  role: LiveTranslateRole;
  at: number;
  stage: 'connecting' | 'configuring' | 'ready' | 'finishing' | 'closed';
  eventType: LiveTranslateProtocolEventType;
  validationPath: LiveTranslateProtocolSchemaPath | 'frame' | 'frame.binary' | 'frame.bytes' | 'frame.utf8' |
    'transport.send' | 'transport.ready_timeout' | 'transport.finish_timeout' |
    'json' | 'state' | 'internal.handler' |
    'source.binding' | 'source.translation' | 'response.audio.done' | 'response.text.done';
  expected: 'json_object' | 'event_type_string' | 'optional_identifier_string' |
    'nonempty_identifier_string' | 'matching_session_id' | 'exact_model' |
    'exact_output_modalities' | 'pcm' | '16000' | '24000' | 'Aiden' | 'false' |
    'speaker_detection' | '0.5' | 'target_language' | 'nonnegative_integer' |
    'zero_index' | 'text_within_limit' | 'base64_pcm16' | 'completed' |
    'in_progress' | 'pending_output_complete' | 'no_provider_error' |
    'valid_protocol_transition' | 'bounded_capacity' | 'valid_callback' |
    'text_json_frame' | 'valid_json' | 'known_3_8_event' | 'single_output_item' |
    'single_content_part' | 'consistent_source_binding' | 'consistent_item_binding' |
    'response_created_before_output' | 'output_modality' | 'error_free_transport' |
    'send_available' | 'handler_completed' | 'array' | 'object' | 'valid_utf8' |
    'exact_input_modalities' | 'audio_input_enabled' | 'nondecreasing_offset' | 'pcm16_bytes';
  actualType: LiveTranslateProtocolValueType;
  fatal: boolean;
  code: string;
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
  /** A local receive sequence is used only when the supplier omitted event_id. */
  eventIdBasis?: 'provider_event_id' | 'local_receive_sequence';
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
  /** User-approved single-local audition policy; defaults to strict echo confirmation. */
  allowMissingVoiceCloneEcho?: boolean;
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
  onSessionConfiguration?: (event: LiveTranslateSessionConfiguration) => void;
  onProtocolEvent?: (event: LiveTranslateProtocolEvent) => void;
  onProtocolDiagnostic?: (event: LiveTranslateProtocolDiagnostic) => void;
  onError?: (
    code: string,
    diagnostic: { closeCode?: number; httpStatusCode?: number },
  ) => void;
};
export type LiveTranslateClient = {
  ready: Promise<LiveTranslateSession>;
  /** Resolves only after the underlying transport actually emits close. */
  transportClosed?: Promise<{ observed: true; code?: number; at: number }>;
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
  'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING',
  'LIVETRANSLATE_CONFIGURATION_REJECTED',
  'LIVETRANSLATE_CONFIG_INVALID',
  'LIVETRANSLATE_CONNECTION_CLOSED',
  'LIVETRANSLATE_CONNECTION_FAILED',
  'LIVETRANSLATE_DISABLED',
  'LIVETRANSLATE_EVENT_CAPACITY',
  'LIVETRANSLATE_EVENT_CONFLICT',
  'LIVETRANSLATE_EVENT_INVALID',
  'LIVETRANSLATE_HANDLER_FAILED',
  'LIVETRANSLATE_UNSUPPORTED_SCHEMA',
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
