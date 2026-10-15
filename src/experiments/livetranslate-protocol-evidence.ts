import type {
  LiveTranslateProtocolDiagnostic,
  LiveTranslateProtocolEvent,
  LiveTranslateVoiceEvidence,
} from './livetranslate-types';

type ProtocolEvidence = {
  errorCode?: string;
  httpStatusCode?: number;
  startedAt?: number;
  endedAt?: number;
  protocolEvents?: LiveTranslateProtocolEvent[];
  protocolDiagnostics?: LiveTranslateProtocolDiagnostic[];
  confirmedSessions?: unknown[];
  voiceEvidence?: LiveTranslateVoiceEvidence[];
  status?: 'completed' | 'failed' | 'cancelled';
  clips?: { sendCompletedAt: number | null }[];
  audio?: { responseDoneAt: number | null }[];
  timing?: { stage: string }[];
  usage?: { basis?: string }[];
  counters: { inputBytesSent: number; audioBytesSaved?: number };
};

/** Classifies only retained evidence. Absent observations never establish remote success. */
export function describeLiveTranslateProtocolEvidence(input: ProtocolEvidence) {
  const events = input.protocolEvents ?? [];
  const diagnostics = input.protocolDiagnostics ?? [];
  const first = (stage: LiveTranslateProtocolEvent['stage'], type?: string) =>
    events.find((event) => event.stage === stage && (!type || event.eventType === type));
  const point = (event: { at: number } | undefined) => ({
    status: event ? 'captured' : 'not_captured',
    at: event?.at ?? null,
    sinceStartMs:
      event && input.startedAt !== undefined ? event.at - input.startedAt : null,
  });
  const fatal = diagnostics.find((item) => item.fatal);
  const cloneWarning = diagnostics.find((item) => !item.fatal &&
    item.code === 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING' &&
    item.validationPath === 'session.enable_voice_clone' && item.actualType === 'missing');
  const voiceWarning = diagnostics.find((item) => !item.fatal &&
    item.code === 'LIVETRANSLATE_APPROVED_ANDRE_TINA_CONFLICT' &&
    item.validationPath === 'session.audio.output.voice');
  const observedConfiguration = first('configuration_accepted');
  const providerError = first('provider_error');
  const transportClose = first('transport_close');
  const http = input.httpStatusCode;
  let classification = 'not_established';
  if (providerError)
    classification = providerError.providerError?.parameter === 'session.voice'
      ? 'supplier_voice_parameter_rejected'
      : 'explicit_supplier_or_gateway_error';
  else if (http && http >= 400)
    classification = http === 407 ? 'proxy_authentication_rejected' : 'http_access_rejected_origin_unconfirmed';
  else if (input.errorCode === 'LIVETRANSLATE_CONNECTION_FAILED') classification = 'transport_failure_origin_unconfirmed';
  else if (input.errorCode === 'LIVETRANSLATE_CONNECTION_CLOSED') classification = 'transport_closed_before_protocol_finish';
  else if (fatal?.validationPath === 'transport.ready_timeout') classification = 'session_initialization_timeout';
  else if (fatal?.validationPath === 'transport.finish_timeout') classification = 'session_tail_timeout';
  else if (fatal?.validationPath === 'transport.send') classification = 'client_send_failed_or_unavailable';
  else if (fatal?.validationPath === 'internal.handler') classification = 'local_handler_failure';
  else if (input.errorCode === 'LIVETRANSLATE_CLONE_CONFIRMATION_MISSING')
    classification = 'voice_clone_disabled_confirmation_missing';
  else if (fatal?.validationPath.startsWith('session.')) classification = 'session_configuration_or_identity_rejected';
  else if (fatal?.validationPath.startsWith('frame') || fatal?.validationPath === 'json') classification = 'incoming_frame_or_json_rejected';
  else if (fatal) classification = 'typed_protocol_validation_rejected';
  else if (input.errorCode === 'LIVETRANSLATE_EVENT_INVALID') classification = 'unclassified_local_event_failure_missing_payload';
  else if (!input.errorCode && observedConfiguration && first('server_frame', 'session.finished'))
    classification = 'protocol_finished_observed';
  const finished = !input.errorCode && !!first('server_frame', 'session.finished');
  const responseAccepted = input.timing?.some((item) => item.stage === 'response_created') === true;
  const audioBytes = input.counters.audioBytesSaved;
  const fullInput = !!input.clips?.length &&
    input.clips.every((clip) => typeof clip.sendCompletedAt === 'number' && Number.isFinite(clip.sendCompletedAt));
  const fullAudio = input.status === 'completed' && finished && fullInput &&
    typeof audioBytes === 'number' && audioBytes > 0 && !!input.audio?.length &&
    input.audio.every((item) => typeof item.responseDoneAt === 'number' && Number.isFinite(item.responseDoneAt));
  const reportedUsage = input.usage?.some((item) => item.basis === 'provider_reported') === true;
  const unknownUsage = input.usage?.some((item) => item.basis !== 'provider_reported') === true;
  return {
    classification,
    configurationStopReason: classification === 'voice_clone_disabled_confirmation_missing'
      ? '缺少复刻关闭确认' : null,
    configurationWarning: cloneWarning ? '缺少复刻关闭确认；按用户批准策略允许就绪' : null,
    voiceMetadataWarning: voiceWarning
      ? '请求Andre、更新顶层Andre、嵌套Tina；按已批准的窄元数据政策继续，实际听感未知' : null,
    voiceEvidence: input.voiceEvidence ?? [],
    outcomes: {
      protocol: input.errorCode ? 'stopped_with_error' : finished ? 'finished_observed' :
        responseAccepted ? 'response_created_accepted' : observedConfiguration ? 'configuration_accepted_only' : 'not_ready',
      fullInputSent: fullInput,
      englishAudio: fullAudio ? 'complete_output_observed' : typeof audioBytes !== 'number'
        ? 'unknown_no_collection_evidence' : audioBytes > 0 ? 'partial_output_preserved' : 'no_audio_observed',
      acousticVoice: 'unknown_not_measured',
      maleVoiceAcceptance: 'not_evaluated',
      voiceDriftAcceptance: 'not_evaluated',
      usage: !reportedUsage ? 'unknown_not_returned' : unknownUsage
        ? 'partially_reported_bill_not_verified' : 'reported_bill_not_verified',
    },
    voiceCloneDisabledConfirmation: cloneWarning || classification === 'voice_clone_disabled_confirmation_missing'
      ? 'unknown_missing_echo' : 'see_observed_configuration_if_any',
    underlyingRemoteCauseEstablished: false,
    rawPayloadRetention: events.length || diagnostics.length ? 'redacted_schema_only' : 'not_captured',
    exactValidation: fatal ?? null,
    timeline: {
      clock: 'application_monotonic_ms',
      runnerStartedAt: input.startedAt ?? null,
      connectionEstablished: point(first('transport_open')),
      firstFrame: point(first('server_frame')),
      sessionUpdateSubmitted: {
        ...point(first('client_event_sent', 'session.update')),
        basis: 'application_send_callback_not_supplier_ack',
      },
      configurationAccepted: point(observedConfiguration),
      failure: point(fatal),
      closeRequested: point(first('transport_close_requested')),
      transportClosed: {
        ...point(transportClose),
        closeCode: transportClose?.closeCode ?? null,
        outcome: !transportClose ? 'not_captured' :
          transportClose.closeCode === 1000 ? 'normal_1000' : 'abnormal_or_unspecified',
      },
      runnerEndedAt: input.endedAt ?? null,
      recordingSend: input.counters.inputBytesSent === 0 ? 'not_started' : 'application_append_observed',
    },
    remoteAuthentication:
      observedConfiguration && (input.confirmedSessions?.length ?? 0) > 0
        ? 'session_configuration_confirmed'
        : 'not_established',
    actualModelAndVoice:
      observedConfiguration && (input.confirmedSessions?.length ?? 0) > 0
        ? 'see_confirmed_sessions'
        : 'unknown',
    actualModelAndVoiceBasis: 'session_configuration_metadata_only_not_acoustic_voice',
    specificValidationCaptured: fatal !== undefined,
    note: 'Transport open is not model authentication. Requested configuration is not effective configuration. A local validation rejection does not prove the supplier rejected a voice.',
  };
}
