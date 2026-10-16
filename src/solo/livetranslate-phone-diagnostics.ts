import {
  isLiveTranslateFailureCode,
  LIVE_TRANSLATE_ITEM_CONFLICT_KINDS,
  LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_EXPECTATIONS,
  LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_PATHS,
  LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES,
  LIVE_TRANSLATE_PROTOCOL_VALUE_TYPES,
} from '../experiments/livetranslate-types';
import {
  LIVE_TRANSLATE_PHONE_FAILURE_CODES,
  LIVE_TRANSLATE_PHONE_WARNING_CODES,
} from './livetranslate-phone-types';
import type { LiveTranslatePhoneDiagnostic } from './livetranslate-phone-types';

const stages = new Set([
  'input_received',
  'association',
  'configuration',
  'voice_evidence',
  'protocol_failure',
  'warning',
  'source_started',
  'source_stopped',
  'source_final',
  'translation_completed',
  'audio_first_sample',
  'response_created',
  'response_completed',
  'playback_queued',
  'playback_drained',
  'usage',
  'failed',
]);
const codes = new Set<string>([
  ...LIVE_TRANSLATE_PHONE_FAILURE_CODES,
  ...LIVE_TRANSLATE_PHONE_WARNING_CODES,
]);
const phoneFailureCodes = new Set<string>(LIVE_TRANSLATE_PHONE_FAILURE_CODES);
function field(value: unknown, name: string): unknown {
  try {
    return value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, name)?.value
      : undefined;
  } catch {
    return undefined;
  }
}
const finite = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= maximum;

/** Second boundary at the call owner/log sink. No getter, free text, provider
 * identifier, credentials, URL, phone number, transcript or audio is copied. */
export function sanitizeLiveTranslatePhoneDiagnostic(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const role = field(value, 'role');
  const stage = field(value, 'stage');
  const at = field(value, 'at');
  if (
    !['local', 'remote'].includes(role as string) ||
    typeof stage !== 'string' ||
    !stages.has(stage) ||
    !finite(at, 4102444800000)
  )
    return undefined;
  const safe: Record<string, unknown> = { role, stage, at };
  const choose = (key: string, allowed: readonly unknown[]) => {
    const v = field(value, key);
    if (allowed.includes(v)) safe[key] = v;
  };
  choose('clock', ['application_epoch_ms']);
  if (stage === 'protocol_failure') {
    choose('fatal', [true]);
    choose('eventType', [
      ...LIVE_TRANSLATE_PROTOCOL_EVENT_TYPES,
      'unknown',
      null,
    ]);
    choose('validationPath', LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_PATHS);
    choose('expected', LIVE_TRANSLATE_PROTOCOL_DIAGNOSTIC_EXPECTATIONS);
    choose('actualType', LIVE_TRANSLATE_PROTOCOL_VALUE_TYPES);
    choose('conflictKind', LIVE_TRANSLATE_ITEM_CONFLICT_KINDS);
  }
  choose('providerEndpointBasis', ['provider_stream_estimate']);
  choose('basis', [
    'model_input_submitted',
    'provider_stream_estimate',
    'application_observed',
    'transport_enqueue_observed',
    'transport_mark_observed',
  ]);
  choose('model', ['qwen3.8-livetranslate-flash-realtime']);
  choose('requestedVoice', ['Andre', 'Tina']);
  for (const key of ['topLevelVoice', 'nestedVoice', 'responseVoice'])
    choose(key, ['Andre', 'Tina', 'Aiden', null]);
  for (const key of [
    'topLevelVoiceStatus',
    'nestedVoiceStatus',
    'responseVoiceStatus',
  ])
    choose(key, ['missing', 'reported', 'unsupported_value', 'invalid_type']);
  choose('voiceEvent', [
    'session.created',
    'session.updated',
    'response.created',
    'response.done',
  ]);
  choose('voicePolicy', [
    'strict_requested_voice',
    'approved_andre_tina_metadata_conflict',
  ]);
  choose('voiceCloneEnabled', [false, null]);
  choose('targetLanguage', ['en', 'zh']);
  choose('inputSampleRate', [16000]);
  choose('outputSampleRate', [24000]);
  choose('usageBasis', ['provider_reported', 'unknown']);
  const code = field(value, 'code');
  if (
    isLiveTranslateFailureCode(code) ||
    (typeof code === 'string' &&
      (stage === 'protocol_failure' ? phoneFailureCodes : codes).has(code))
  )
    safe.code = code;
  for (const key of [
    'sequence',
    'sourceSequence',
    'responseSequence',
    'bytes',
    'queuedBytes',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'inputAudioTokens',
    'inputTextTokens',
    'outputAudioTokens',
    'outputTextTokens',
  ]) {
    const n = field(value, key);
    if (finite(n, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(n))
      safe[key] = n;
  }
  const receiveSequence = field(value, 'receiveSequence');
  if (
    finite(receiveSequence, Number.MAX_SAFE_INTEGER) &&
    Number.isSafeInteger(receiveSequence) &&
    receiveSequence > 0
  )
    safe.receiveSequence = receiveSequence;
  for (const key of ['outstandingAudioMs', 'providerAudioMs', 'inputAudioMs']) {
    const n = field(value, key);
    if (finite(n, 4102444800000)) safe[key] = n;
  }
  const close = field(value, 'closeCode');
  if (finite(close, 4999) && close >= 1000 && Number.isSafeInteger(close))
    safe.closeCode = close;
  const http = field(value, 'httpStatusCode');
  if (finite(http, 599) && http >= 100 && Number.isSafeInteger(http))
    safe.httpStatusCode = http;
  // A transport write or matching Twilio mark never establishes ear playback.
  if (
    stage.startsWith('playback_') ||
    field(value, 'actualPlaybackStartAt') !== undefined
  )
    safe.actualPlaybackStartAt = null;
  return Object.freeze(safe);
}

/** First boundary: the bridge must not spread arbitrary client callback data.
 * Reuse the sink projection, then copy only its statically bounded fields. */
export function projectLiveTranslateProtocolFailure(
  value: unknown,
): Omit<LiveTranslatePhoneDiagnostic, 'clock' | 'role'> | undefined {
  if (field(value, 'fatal') !== true) return undefined;
  const code = field(value, 'code');
  if (
    !isLiveTranslateFailureCode(code) &&
    !(typeof code === 'string' && phoneFailureCodes.has(code))
  )
    return undefined;
  const safe = sanitizeLiveTranslatePhoneDiagnostic({
    role: 'local', // Actual track role is supplied by the bridge's closure.
    stage: 'protocol_failure',
    at: field(value, 'at'),
    fatal: true,
    code,
    eventType: field(value, 'eventType'),
    validationPath: field(value, 'validationPath'),
    expected: field(value, 'expected'),
    actualType: field(value, 'actualType'),
    conflictKind: field(value, 'conflictKind'),
    receiveSequence: field(value, 'receiveSequence'),
  });
  if (!safe || typeof safe.code !== 'string') return undefined;
  // Every optional value above passed the exact corresponding enum or scalar
  // allowlist, and no caller-provided object property is read through a getter.
  return safe as Omit<LiveTranslatePhoneDiagnostic, 'clock' | 'role'>;
}

export function projectLiveTranslateProtocolWarning(
  value: unknown,
): Omit<LiveTranslatePhoneDiagnostic, 'clock' | 'role'> | undefined {
  const code = field(value, 'code');
  if (
    field(value, 'fatal') !== false ||
    typeof code !== 'string' ||
    !(LIVE_TRANSLATE_PHONE_WARNING_CODES as readonly string[]).includes(code)
  )
    return undefined;
  const safe = sanitizeLiveTranslatePhoneDiagnostic({
    role: 'local',
    stage: 'warning',
    at: field(value, 'at'),
    code,
  });
  return safe as
    | Omit<LiveTranslatePhoneDiagnostic, 'clock' | 'role'>
    | undefined;
}

export function reportCloudLiveTranslateDiagnostic(
  value: unknown,
  // eslint-disable-next-line no-console -- Only the explicit scalar projection below reaches this sink.
  sink: (line: string) => void = (line) => console.log(line),
): void {
  if (field(value, 'event') !== 'translation-live') return;
  const data = field(value, 'data');
  const safe = sanitizeLiveTranslatePhoneDiagnostic(data);
  if (!safe) return;
  const suppliedCall = field(data, 'sessionId');
  const callId =
    typeof suppliedCall === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      suppliedCall,
    )
      ? suppliedCall
      : undefined;
  try {
    sink(
      JSON.stringify({
        event: 'CLOUD_LIVETRANSLATE_DIAGNOSTIC',
        ...(callId ? { callId } : {}),
        ...safe,
      }),
    );
  } catch {
    /* Logging cannot change telephone ownership, clear audio or reconnect. */
  }
}
