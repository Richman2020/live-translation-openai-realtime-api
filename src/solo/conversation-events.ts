import {
  adaptTranscriptEvent,
  createConversationModel,
  type ConversationEvent,
  type ConversationPlaybackEvent,
} from '../../public/conversation-model.js';
import type {
  TranscriptEvent,
  TranslationAudioDiagnostic,
  UtterancePlaybackEvent,
} from './translation-bridge';

/** One adapter per authenticated call; never correlate by text or arrival order. */
export class ConversationEventAdapter {
  private sequence = 0;

  private readonly revisions = new Map<string, number>();

  private readonly origins = new Map<
    string,
    { at: number; sequence: number }
  >();

  private readonly model: ReturnType<typeof createConversationModel>;

  constructor(
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.model = createConversationModel({ sessionId });
  }

  private revision(key: string): number {
    const revision = (this.revisions.get(key) || 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  private origin(id: string, at: number): { at: number; sequence: number } {
    let origin = this.origins.get(id);
    if (!origin) {
      this.sequence += 1;
      origin = { at, sequence: this.sequence };
      this.origins.set(id, origin);
    }
    return origin;
  }

  transcript(transcript: TranscriptEvent): ConversationEvent | null {
    const event = adaptTranscriptEvent(transcript, {
      sessionId: this.sessionId,
    });
    if (!event) return null;
    const origin = this.origin(event.utteranceId, event.at);
    // The original's source timestamp can replace a translation-only placeholder.
    if (event.kind === 'original') origin.at = Math.min(origin.at, event.at);
    event.at = origin.at;
    event.sequence = origin.sequence;
    event.revision =
      transcript.revision ??
      this.revision(`text:${event.utteranceId}:${event.kind}`);
    return this.model.apply(event) ? event : null;
  }

  audio(audio: TranslationAudioDiagnostic): ConversationEvent | null {
    // Continuous translated chunks have no guaranteed relation to captions.
    // A shared role, prefix number or similar text is insufficient evidence.
    if (
      !audio.utteranceId ||
      !audio.deliveryId ||
      audio.audioKind === 'original'
    )
      return null;
    const status: ConversationPlaybackEvent['status'] = {
      generated: 'queued' as const,
      sent: 'sent' as const,
      playback_confirmed: 'played' as const,
      unconfirmed: 'unconfirmed' as const,
    }[audio.stage];
    const origin = this.origin(audio.utteranceId, this.now());
    const event: ConversationPlaybackEvent = {
      type: 'playback',
      sessionId: this.sessionId,
      utteranceId: audio.utteranceId,
      role: audio.role,
      deliveryId: `${audio.pipelineId || 'legacy'}:${audio.deliveryId}`,
      status,
      evidence: status === 'played' ? 'twilio_mark' : 'transport',
      revision: this.revision(
        `delivery:${audio.pipelineId}:${audio.deliveryId}`,
      ),
      ...origin,
    };
    return this.model.apply(event) ? event : null;
  }

  playback(playback: UtterancePlaybackEvent): ConversationEvent | null {
    const origin = this.origin(playback.utteranceId, playback.at);
    const event: ConversationPlaybackEvent = {
      type: 'playback',
      sessionId: this.sessionId,
      utteranceId: playback.utteranceId,
      role: playback.role,
      status: playback.status,
      evidence: 'none',
      revision: this.revision(`lifecycle:${playback.utteranceId}`),
      ...(playback.sealed ? { sealed: true } : {}),
      ...(playback.expectedDeliveryCount === undefined
        ? {}
        : { expectedDeliveryCount: playback.expectedDeliveryCount }),
      ...origin,
    };
    return this.model.apply(event) ? event : null;
  }
}
