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
  | (typeof callReasons)[number];
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
]);
const providerReasons = new Set<string>([
  ...NATIVE_FAILURE_REASONS,
  ...CAPTION_FAILURE_REASONS,
  'CONTINUOUS_PROVIDER_FAILED',
  'REMOTE_CAPTIONS_UNAVAILABLE',
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
  return Object.freeze({
    reason,
    layer,
    role,
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
): CallTerminationDiagnostic {
  const observed = numberIn(observedAtMs, 0, MAX_EPOCH_SECONDS * 1000)
    ? observedAtMs
    : null;
  const started = numberIn(startedAtMs, 0, MAX_EPOCH_SECONDS * 1000)
    ? startedAtMs
    : null;
  return Object.freeze({
    event: 'CLOUD_CALL_TERMINATION',
    ...sanitizeTerminationCause(cause),
    observedAtMs: observed,
    elapsedMs:
      observed !== null && started !== null && observed >= started
        ? observed - started
        : null,
  });
}
