import {
  adaptTranscriptEvent,
  createConversationModel,
  type ConversationEvent,
  type ConversationPlaybackEvent,
  type ConversationTextEvent,
} from '../../public/conversation-model.js';
import {
  ConversationSpeakerTurns,
  type ConversationSpeakerTurnBinding,
} from './conversation-speaker-turns';
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

  private readonly speakerTurns = new ConversationSpeakerTurns();

  private readonly latestText = new Map<
    string,
    Partial<Record<'original' | 'translation', ConversationTextEvent>>
  >();

  private turnUpdates: ConversationTextEvent[] = [];

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

  transcript(transcript: TranscriptEvent): ConversationTextEvent | null {
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
    // Validate text/version/provenance before a source is allowed to change
    // display ownership. A rejected stale original cannot seize the turn.
    delete event.speakerTurnId;
    delete event.speakerTurnSequence;
    delete event.speakerTurnRevision;
    delete event.speakerSourceSequence;
    const previousRow = this.model.getUtterance(event.utteranceId);
    const previousBinding = this.speakerTurns.lookup(
      event.utteranceId,
      event.role,
    );
    if (previousBinding)
      Object.assign(event, this.withBinding(event, previousBinding));
    else if (
      previousRow?.role === event.role &&
      previousRow.speakerTurnId !== undefined
    ) {
      // Retired source metadata stays frozen, never rebound to a current turn.
      // Preserve the established fence while validating a newer text revision.
      Object.assign(event, {
        speakerTurnId: previousRow.speakerTurnId,
        speakerTurnSequence: previousRow.speakerTurnSequence,
        speakerTurnRevision: previousRow.speakerTurnRevision,
        speakerSourceSequence: previousRow.speakerSourceSequence,
      });
    }
    this.turnUpdates = [];
    if (!this.model.apply(event)) return null;

    const result =
      event.kind === 'original'
        ? this.speakerTurns.acceptOriginal({
            sourceId: event.utteranceId,
            role: event.role,
            at: event.at,
            text: event.text,
            revision: event.revision,
            final: event.final,
          })
        : undefined;
    const binding =
      result?.binding ??
      this.speakerTurns.lookup(event.utteranceId, event.role);
    const bound = this.withBinding(event, binding);
    if (binding) this.model.apply(bound);
    const latest = this.latestText.get(event.utteranceId) ?? {};
    latest[event.kind] = bound;
    this.latestText.set(event.utteranceId, latest);
    if (this.latestText.size > 1024)
      this.latestText.delete(this.latestText.keys().next().value!);

    for (const update of result?.updates ?? []) {
      const cached = this.latestText.get(update.sourceId);
      if (cached) {
        for (const kind of ['original', 'translation'] as const) {
          const previous = cached[kind];
          if (previous && previous.role === update.role) {
            const corrected = this.withBinding(previous, update.binding);
            if (this.model.apply(corrected)) {
              cached[kind] = corrected;
              this.turnUpdates.push(corrected);
            }
          }
        }
      }
    }
    return bound;
  }

  /** Metadata-only revisions of the exact accepted text, never audio replay. */
  takeTurnUpdates(): ConversationTextEvent[] {
    const updates = this.turnUpdates;
    this.turnUpdates = [];
    return updates;
  }

  private withBinding(
    event: ConversationTextEvent,
    binding?: ConversationSpeakerTurnBinding,
  ): ConversationTextEvent {
    return binding
      ? {
          ...event,
          speakerTurnId: binding.speakerTurnId,
          speakerTurnSequence: binding.speakerTurnSequence,
          speakerTurnRevision: binding.speakerTurnRevision,
          speakerSourceSequence: binding.sourceSequence,
        }
      : event;
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
