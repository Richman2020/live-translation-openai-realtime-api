/** Fixed, non-identifying metadata only. Never include supplier payloads, IDs,
 * URLs, close reasons, exception messages, credentials, audio or transcripts. */
export const NATIVE_FAILURE_REASONS = [
  'INVALID_PROVIDER_EVENT',
  'INVALID_PROVIDER_EVENT_ID',
  'PROVIDER_EVENT_LIMIT',
  'PROVIDER_SESSION_REJECTED',
  'PROVIDER_SESSION_MISMATCH',
  'PROVIDER_CLOSED_UNEXPECTEDLY',
  'PROVIDER_OUTPUT_BEFORE_READY',
  'PROVIDER_AUDIO_FORMAT_MISMATCH',
  'INVALID_PROVIDER_AUDIO',
  'INVALID_PROVIDER_TRANSCRIPT',
  'AUDIO_CALLBACK_FAILED',
  'TRANSLATED_TEXT_CALLBACK_FAILED',
  'PROVIDER_READY_TIMEOUT',
  'PROVIDER_FINISH_TIMEOUT',
  'PROVIDER_CONNECTION_FAILED',
  'PROVIDER_HANDSHAKE_REJECTED',
  'PROVIDER_AUDIO_ADMISSION_DENIED',
  'PROVIDER_TRANSPORT_USAGE_OVERFLOW',
  'PROVIDER_SEND_UNAVAILABLE',
  'PROVIDER_SEND_FAILED',
  'CLIENT_NOT_READY',
] as const;

export const CAPTION_FAILURE_REASONS = [
  'CAPTION_SEND_UNAVAILABLE',
  'CAPTION_SEND_FAILED',
  'CAPTION_CALLBACK_FAILED',
  'CAPTION_TRANSLATION_TIMEOUT',
  'CAPTION_TURN_BACKLOG',
  'CAPTION_COMMIT_TIMEOUT',
  'CAPTION_ASR_SESSION_MISMATCH',
  'CAPTION_INVALID_TRANSCRIPT',
  'CAPTION_UNEXPECTED_COMMIT',
  'CAPTION_ASR_TIMEOUT',
  'CAPTION_ASR_FAILED',
  'CAPTION_OUTPUT_BEFORE_READY',
  'CAPTION_TEXT_SESSION_MISMATCH',
  'CAPTION_UNEXPECTED_AUDIO',
  'CAPTION_INVALID_RESPONSE',
  'CAPTION_INVALID_TRANSLATION',
  'CAPTION_TRANSLATION_INCOMPLETE',
  'CAPTION_INVALID_EVENT',
  'CAPTION_ASR_REJECTED',
  'CAPTION_TRANSLATION_REJECTED',
  'CAPTION_CONNECTION_FAILED',
  'CAPTION_CLOSED_UNEXPECTEDLY',
  'CAPTION_HANDSHAKE_REJECTED',
  'CAPTION_READY_TIMEOUT',
  'CAPTION_FINISH_TIMEOUT',
  'CAPTION_ASR_CLOSED',
  'CAPTION_TRANSLATION_CLOSED',
  'CAPTION_ASR_CONNECTION_FAILED',
  'CAPTION_TRANSLATION_CONNECTION_FAILED',
] as const;

/** Application-defined Alibaba failures only; never accept a prefix or raw
 * supplier error string as a reason. Keep this static list independent of all
 * provider implementations so failure handling can use it without a cycle. */
export const PLAN_B_FAILURE_REASONS = [
  'PLANB_ASR_APPEND_FAILED',
  'PLANB_ASR_CREATION_FAILED',
  'PLANB_ASR_INVALID_SOURCE',
  'PLANB_ASR_NOT_READY',
  'PLANB_ASR_SOURCE_CONFLICT',
  'PLANB_BRIDGE_CANCELLED',
  'PLANB_BRIDGE_CLOSED',
  'PLANB_BRIDGE_INVALID_SELECTION',
  'PLANB_BRIDGE_ROLE_INVALID',
  'PLANB_CURRENT_MT_INPUT_INVALID',
  'PLANB_CURRENT_MT_MEMORY_INVALID',
  'PLANB_CURRENT_MT_MEMORY_REQUIRED',
  'PLANB_CURRENT_MT_REQUEST_INVALID',
  'PLANB_CURRENT_TRANSLATION_BODY_CONTROL',
  'PLANB_CURRENT_TRANSLATION_BODY_FENCE',
  'PLANB_CURRENT_TRANSLATION_BODY_JSON',
  'PLANB_CURRENT_TRANSLATION_BODY_JSON_FRAGMENT',
  'PLANB_CURRENT_TRANSLATION_BODY_LIMIT',
  'PLANB_CURRENT_TRANSLATION_BODY_META_PREFIX',
  'PLANB_CURRENT_TRANSLATION_BODY_RESERVED',
  'PLANB_CURRENT_TRANSLATION_BODY_STRUCTURE',
  'PLANB_CURRENT_TRANSLATION_BODY_TYPE',
  'PLANB_CURRENT_TRANSLATION_EMPTY',
  'PLANB_CURRENT_TRANSLATION_GUARD_UNISSUED',
  'PLANB_CURRENT_TRANSLATION_HISTORY_REPLAY_SUSPECT',
  'PLANB_CURRENT_TRANSLATION_JOB_INVALID',
  'PLANB_CURRENT_TRANSLATION_MEMORY_INVALID',
  'PLANB_CURRENT_TRANSLATION_MEMORY_UNISSUED',
  'PLANB_CURRENT_TRANSLATION_RECEIPT_CONSUMED',
  'PLANB_CURRENT_TRANSLATION_RECEIPT_INVALID',
  'PLANB_CURRENT_TRANSLATION_RECEIPT_JOB_MISMATCH',
  'PLANB_CURRENT_TRANSLATION_RECEIPT_UNCONSUMED',
  'PLANB_CURRENT_TRANSLATION_RECEIPT_UNISSUED',
  'PLANB_CURRENT_TRANSLATION_REQUEST_INVALID',
  'PLANB_CURRENT_TRANSLATION_ROLE_INVALID',
  'PLANB_CURRENT_TRANSLATION_SOURCE_REPLAY',
  'PLANB_KEY_REQUIRED',
  'PLANB_MT_ACCESS_DENIED',
  'PLANB_MT_CANCELLED',
  'PLANB_MT_EVENT_INVALID',
  'PLANB_MT_HTTP_FAILED',
  'PLANB_MT_INCOMPLETE',
  'PLANB_MT_INPUT_INVALID',
  'PLANB_MT_OUTPUT_LIMIT',
  'PLANB_MT_PROVIDER_FAILED',
  'PLANB_MT_RATE_LIMITED',
  'PLANB_MT_STREAM_FAILED',
  'PLANB_MT_STREAM_LIMIT',
  'PLANB_MT_STREAM_MISSING',
  'PLANB_MT_TIMEOUT',
  'PLANB_MT_USAGE_INVALID',
  'PLANB_PIPELINE_CANCELLED',
  'PLANB_PIPELINE_CAPACITY',
  'PLANB_PIPELINE_FINISH_FAILED',
  'PLANB_PIPELINE_INVALID_OPTIONS',
  'PLANB_PIPELINE_INVALID_PCM',
  'PLANB_PIPELINE_PROVIDER_FAILED',
  'PLANB_PIPELINE_QUEUE_CAPACITY',
  'PLANB_PIPELINE_QUEUE_FAILED',
  'PLANB_PIPELINE_REGION_UNSUPPORTED',
  'PLANB_PLAYBACK_IDENTITY_MISSING',
  'PLANB_PLAYBACK_UNCONFIRMED',
  'PLANB_SOURCE_ORDER_UNRESOLVED',
  'PLANB_SOURCE_WITHDRAWN',
  'PLANB_TRANSLATION_INVALID_RESULT',
  'PLANB_TTS_ALREADY_ACTIVE',
  'PLANB_TTS_AUDIO_UNBOUND',
  'PLANB_TTS_CANCELLED',
  'PLANB_TTS_CONNECTION_CLOSED',
  'PLANB_TTS_CONNECTION_FAILED',
  'PLANB_TTS_EMPTY_AUDIO',
  'PLANB_TTS_EVENT_INVALID',
  'PLANB_TTS_EVENT_LIMIT',
  'PLANB_TTS_INPUT_INVALID',
  'PLANB_TTS_INVALID_PCM',
  'PLANB_TTS_PROVIDER_FAILED',
  'PLANB_TTS_QUEUE_LIMIT',
  'PLANB_TTS_SEND_FAILED',
  'PLANB_TTS_SENTENCE_ORDER',
  'PLANB_TTS_TIMEOUT',
  'PLANB_TTS_USAGE_INVALID',
  'PLAN_B_ASR_CALLBACK_FAILED',
  'PLAN_B_ASR_CANCELLED',
  'PLAN_B_ASR_CLOCK_INVALID',
  'PLAN_B_ASR_CLOSED',
  'PLAN_B_ASR_CONFIG_INVALID',
  'PLAN_B_ASR_CONTEXT_FAILED',
  'PLAN_B_ASR_DISCONNECTED',
  'PLAN_B_ASR_EVENT_INVALID',
  'PLAN_B_ASR_EVENT_TOO_LARGE',
  'PLAN_B_ASR_FINISH_TIMEOUT',
  'PLAN_B_ASR_NOT_READY',
  'PLAN_B_ASR_PCM_INVALID',
  'PLAN_B_ASR_PROVIDER_FAILED',
  'PLAN_B_ASR_SEND_FAILED',
  'PLAN_B_ASR_SOURCE_BACKLOG',
  'PLAN_B_ASR_SOURCE_ID_CONFLICT',
  'PLAN_B_ASR_SOURCE_INVALID',
  'PLAN_B_ASR_SOURCE_TIME_INVALID',
  'PLAN_B_ASR_START_TIMEOUT',
  'PLAN_B_ASR_TASK_NOT_STARTED',
  'PLAN_B_ASR_TASK_STATE_INVALID',
  'PLAN_B_ASR_TIMEOUT_INVALID',
  'PLAN_B_ASR_TRANSPORT_FAILED',
  'PLAN_B_ASR_TRANSPORT_UNAVAILABLE',
  'PLAN_B_ASR_UNEXPECTED_BINARY',
  'PLAN_B_ASR_UNEXPECTED_FINISH',
] as const;
const planBFailureReasons = new Set<string>(PLAN_B_FAILURE_REASONS);
export function isPlanBFailureReason(
  value: unknown,
): value is (typeof PLAN_B_FAILURE_REASONS)[number] {
  return typeof value === 'string' && planBFailureReasons.has(value);
}

export type CallTerminationComponent =
  | 'asr'
  | 'translation'
  | 'tts'
  | 'pipeline'
  | 'playback';

function planBFailureComponent(
  reason: (typeof PLAN_B_FAILURE_REASONS)[number],
): CallTerminationComponent {
  // Prefix classification is safe only after exact static membership succeeds.
  if (reason.startsWith('PLAN_B_ASR_') || reason.startsWith('PLANB_ASR_'))
    return 'asr';
  if (
    reason.startsWith('PLANB_MT_') ||
    reason.startsWith('PLANB_CURRENT_') ||
    reason === 'PLANB_TRANSLATION_INVALID_RESULT'
  )
    return 'translation';
  if (reason.startsWith('PLANB_TTS_')) return 'tts';
  if (reason.startsWith('PLANB_PLAYBACK_')) return 'playback';
  return 'pipeline';
}

const callReasons = [
  'UNCLASSIFIED_TERMINATION',
  'CALL_END_REQUESTED',
  'SERVICE_SHUTDOWN',
  'CALL_AUTHORIZATION_REVOKED',
  'BROWSER_AUTH_EXPIRED',
  'CONTROLLER_REVOKED',
  'CALL_END_REQUEST_FAILED',
  'CALL_CREATION_FAILED',
  'CALL_SETUP_TIMEOUT',
  'CALL_DURATION_LIMIT',
  'CALL_PROVIDER_LIMIT_FAILED',
  'TWILIO_CALL_FAILED',
  'CALL_COMPLETED',
  'CALL_CANCELED',
  'CALL_FAILED',
  'CALL_BUSY',
  'CALL_NO_ANSWER',
  'PHONE_STREAM_TIMEOUT',
  'PHONE_STREAM_CLOSED',
  'PHONE_STREAM_ERROR',
  'PHONE_STREAM_STOPPED',
  'INVALID_MEDIA_MESSAGE',
  'MEDIA_STREAM_FAILED',
  'BUDGET_NOT_READY',
  'BUDGET_LIMIT_REACHED',
  'CONTINUOUS_PROVIDER_FAILED',
  'REMOTE_CAPTIONS_UNAVAILABLE',
  'CONTINUOUS_PLAYBACK_TIMEOUT',
  'CONTINUOUS_PLAYBACK_OVERFLOW',
  'CONTINUOUS_PHONE_BACKPRESSURE',
  'CONTINUOUS_PHONE_SEND_FAILED',
  'CONTINUOUS_INPUT_SEND_FAILED',
] as const;

export type CallTerminationReason =
  | (typeof NATIVE_FAILURE_REASONS)[number]
  | (typeof CAPTION_FAILURE_REASONS)[number]
  | (typeof callReasons)[number]
  | (typeof PLAN_B_FAILURE_REASONS)[number];
export type CallTerminationLayer =
  | 'application'
  | 'authorization'
  | 'media'
  | 'playback'
  | 'provider'
  | 'supplier';
export type CallTerminationCause = Readonly<{
  reason: CallTerminationReason;
  layer: CallTerminationLayer;
  role: 'local' | 'remote' | 'unknown';
  /** Fixed classification of an exact application-defined Alibaba failure. */
  component?: CallTerminationComponent;
  /** Locally generated per-call UUID, never a Twilio/provider/account SID. */
  callId?: string;
  wsCloseCode?: number;
  sessionExpiresAtEpochSeconds?: number;
}>;
export type CallTerminationDiagnostic = CallTerminationCause &
  Readonly<{
    event: 'CLOUD_CALL_TERMINATION';
    observedAtMs: number | null;
    elapsedMs: number | null;
  }>;

const reasons = new Set<string>([
  ...NATIVE_FAILURE_REASONS,
  ...CAPTION_FAILURE_REASONS,
  ...callReasons,
  ...PLAN_B_FAILURE_REASONS,
]);
const providerReasons = new Set<string>([
  ...NATIVE_FAILURE_REASONS,
  ...CAPTION_FAILURE_REASONS,
  'CONTINUOUS_PROVIDER_FAILED',
  'REMOTE_CAPTIONS_UNAVAILABLE',
  ...PLAN_B_FAILURE_REASONS,
]);
const layers = new Set<string>([
  'application',
  'authorization',
  'media',
  'playback',
  'provider',
  'supplier',
]);
const MAX_EPOCH_SECONDS = 4102444800;
const numberIn = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= minimum &&
  Number(value) <= maximum;
const field = (value: unknown, name: string): unknown => {
  try {
    return value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, name)?.value
      : undefined;
  } catch {
    return undefined;
  }
};

/** Build a fresh allowlisted object even when an injected transport lies about
 * its TypeScript type. Accessors and unknown fields never enter diagnostics. */
export function sanitizeTerminationCause(value: unknown): CallTerminationCause {
  const supplied = field(value, 'reason');
  const reason: CallTerminationReason =
    typeof supplied === 'string' && reasons.has(supplied)
      ? (supplied as CallTerminationReason)
      : 'UNCLASSIFIED_TERMINATION';
  const suppliedLayer = field(value, 'layer');
  const layer: CallTerminationLayer =
    typeof suppliedLayer === 'string' && layers.has(suppliedLayer)
      ? (suppliedLayer as CallTerminationLayer)
      : 'application';
  const suppliedRole = field(value, 'role');
  const role =
    suppliedRole === 'local' || suppliedRole === 'remote'
      ? suppliedRole
      : 'unknown';
  const wsCloseCode = field(value, 'wsCloseCode');
  const expiry = field(value, 'sessionExpiresAtEpochSeconds');
  const callId = field(value, 'callId');
  return Object.freeze({
    reason,
    layer,
    role,
    ...(isPlanBFailureReason(reason)
      ? { component: planBFailureComponent(reason) }
      : {}),
    ...(typeof callId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      callId,
    )
      ? { callId }
      : {}),
    ...(numberIn(wsCloseCode, 1000, 4999) ? { wsCloseCode } : {}),
    ...(numberIn(expiry, 1, MAX_EPOCH_SECONDS)
      ? { sessionExpiresAtEpochSeconds: expiry }
      : {}),
  });
}

/** Existing error strings remain unchanged on the call. Only this projection
 * is logged, and arbitrary strings fall back to a fixed classification. */
export function classifyCallTermination(error?: string): CallTerminationCause {
  const match =
    typeof error === 'string'
      ? /^(continuous_provider_failed|continuous_playback_timeout|continuous_playback_overflow|continuous_phone_backpressure|continuous_phone_send_failed|continuous_input_send_failed):(local|remote)$/.exec(
          error,
        )
      : null;
  const reason = match ? match[1].toUpperCase() : error || 'CALL_END_REQUESTED';
  let layer: CallTerminationLayer = 'application';
  if (providerReasons.has(reason)) layer = 'provider';
  else if (reason.includes('PLAYBACK')) layer = 'playback';
  else if (
    reason.startsWith('PHONE_STREAM_') ||
    reason.startsWith('CONTINUOUS_PHONE_') ||
    reason === 'MEDIA_STREAM_FAILED' ||
    reason === 'INVALID_MEDIA_MESSAGE'
  )
    layer = 'media';
  else if (
    [
      'CALL_AUTHORIZATION_REVOKED',
      'BROWSER_AUTH_EXPIRED',
      'CONTROLLER_REVOKED',
    ].includes(reason)
  )
    layer = 'authorization';
  else if (
    [
      'TWILIO_CALL_FAILED',
      'CALL_COMPLETED',
      'CALL_CANCELED',
      'CALL_FAILED',
      'CALL_BUSY',
      'CALL_NO_ANSWER',
    ].includes(reason)
  )
    layer = 'supplier';
  return sanitizeTerminationCause({ reason, layer, role: match?.[2] });
}

export function createCallTerminationDiagnostic(
  cause: unknown,
  observedAtMs: unknown,
  startedAtMs: unknown,
  callId?: unknown,
): CallTerminationDiagnostic {
  const observed = numberIn(observedAtMs, 0, MAX_EPOCH_SECONDS * 1000)
    ? observedAtMs
    : null;
  const started = numberIn(startedAtMs, 0, MAX_EPOCH_SECONDS * 1000)
    ? startedAtMs
    : null;
  const safeCallId = sanitizeTerminationCause({ callId }).callId;
  return Object.freeze({
    event: 'CLOUD_CALL_TERMINATION',
    ...sanitizeTerminationCause(cause),
    ...(safeCallId ? { callId: safeCallId } : {}),
    observedAtMs: observed,
    elapsedMs:
      observed !== null && started !== null && observed >= started
        ? observed - started
        : null,
  });
}
