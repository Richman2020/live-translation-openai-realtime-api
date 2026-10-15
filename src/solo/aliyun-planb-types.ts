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
  /** Actual transport close code only; no provider close reason is exposed. */
  closeCode?: number;
};
export type PlanBAsrSource = {
  sequence: number;
  revision: number;
  text: string;
  final: boolean;
  /** Stable first-accepted source start, anchored when its task starts. */
  at: number;
  /** Final provider endpoint; start refinement does not change its mapping. */
  endAt?: number;
};
export type PlanBAsrDiagnosticFieldState =
  | 'missing'
  | 'null'
  | 'valid'
  | 'invalid';
export type PlanBAsrDiagnosticTextState =
  | 'missing'
  | 'null'
  | 'invalid'
  | 'empty'
  | 'whitespace'
  | 'nonempty'
  | 'too-long';
/** A white-listed source shape; never includes text or provider task identity. */
export type PlanBAsrDiagnosticSnapshot = {
  arrivalSequence: number;
  providerSentenceId: number | null;
  sourceSequence: number | null;
  idState: PlanBAsrDiagnosticFieldState;
  beginState: PlanBAsrDiagnosticFieldState;
  endState: PlanBAsrDiagnosticFieldState;
  finalState: PlanBAsrDiagnosticFieldState;
  sentenceBeginState: PlanBAsrDiagnosticFieldState;
  heartbeatState: PlanBAsrDiagnosticFieldState;
  beginMs: number | null;
  endMs: number | null;
  final: boolean | null;
  sentenceBegin: boolean | null;
  heartbeat: boolean | null;
  textState: PlanBAsrDiagnosticTextState;
};
export type PlanBAsrDiagnosticDecision =
  | 'accepted'
  | 'partial_begin_refined'
  | 'partial_begin_replay_ignored'
  | 'partial_begin_alias_revised'
  | 'final_begin_alias_accepted'
  | 'heartbeat_ignored'
  | 'invalid_source'
  | 'retired_source_ignored'
  | 'begin_conflict'
  | 'final_duplicate_ignored'
  | 'final_revision_ignored'
  | 'endpoint_regression_ignored'
  | 'duplicate_ignored'
  | 'empty_new_source_ignored'
  | 'invalid_source_time'
  | 'source_backlog';
export type PlanBAsrDiagnostic = {
  /** Arrival order within this client task, including ignored source frames. */
  arrivalSequence: number;
  decision: PlanBAsrDiagnosticDecision;
  incoming: PlanBAsrDiagnosticSnapshot;
  /** Last accepted frame of the source actually used for this comparison. */
  previousAccepted: PlanBAsrDiagnosticSnapshot | null;
  /** Immediately preceding source arrival in this task, regardless of ID. */
  previousArrival: PlanBAsrDiagnosticSnapshot | null;
  beginChanged: boolean | null;
  endRegressed: boolean | null;
  textChanged: boolean | null;
};
/** Metadata only: end estimates are not independently measured acoustic endpoints. */
export type PlanBTimingEvent = {
  utteranceId: string;
  role: TranslationRole;
  sourceRevision: number;
  sessionEpoch: number;
  sequence: number;
  sourceIds: readonly number[];
  stage:
    | 'provider_endpoint_estimate'
    | 'asr_final'
    | 'section_ready'
    | 'translation_start'
    | 'synthesis_start'
    | 'translation_complete'
    | 'audio_first_sample'
    | 'playback_queued'
    | 'playback_drained'
    | 'playback_start_unavailable';
  at: number;
  basis:
    | 'provider_stream_estimate'
    | 'application_observed'
    | 'transport_enqueue_observed'
    | 'transport_mark_observed'
    | 'unavailable';
  actualPlaybackStartAt?: null;
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
  /** Explicit metadata-only observer; exceptions never change source handling. */
  onSourceDiagnostic?: (diagnostic: PlanBAsrDiagnostic) => void;
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
