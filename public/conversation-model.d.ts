export type TextPart = { text: string; final: boolean; revision: number };
export type CaptionProvenance = {
  captionSource?: 'native_output' | 'native_input' | 'independent_text';
  audioCorrespondence?: 'generated_only' | 'none';
};
export type ConversationTextEvent = {
  type: 'text'; sessionId: string; utteranceId: string; role: 'local' | 'remote';
  kind: 'original' | 'translation'; text: string; final: boolean; revision: number;
  at: number; sequence: number; pairing: 'explicit' | 'unpaired';
  boundary: 'utterance' | 'semantic' | 'diagnostic';
} & CaptionProvenance;
export type ConversationPlaybackEvent = {
  type: 'playback'; sessionId: string; utteranceId: string; role: 'local' | 'remote';
  deliveryId?: string; status: 'queued' | 'sent' | 'played' | 'cancelled' | 'unconfirmed';
  revision: number; evidence: 'none' | 'transport' | 'twilio_mark'; at: number;
  sequence: number; sealed?: boolean; expectedDeliveryCount?: number;
};
export type ConversationEvent = ConversationTextEvent | ConversationPlaybackEvent;
export type ConversationUtterance = {
  id: string; sessionId: string; role: 'local' | 'remote'; at: number; sequence: number;
  pairing: 'explicit' | 'unpaired'; boundary: 'utterance' | 'semantic' | 'diagnostic';
  original: TextPart | null; translation: TextPart | null;
  playback: { status: 'unknown' | ConversationPlaybackEvent['status'];
    evidence: ConversationPlaybackEvent['evidence']; sealed: boolean; deliveryCount: number; playedCount: number };
} & CaptionProvenance;
export function adaptTranscriptEvent(value: any, options?: { sessionId?: string; revision?: number; sequence?: number }): ConversationTextEvent | null;
export function splitSemanticText(text: string): string[];
export function createConversationModel(options: string | { sessionId: string }): {
  apply(event: ConversationEvent): boolean; applyTranscript(value: any): boolean;
  getUtterances(): ConversationUtterance[]; snapshot(): ConversationUtterance[];
  getUtterance(id: string): ConversationUtterance | null;
  getLastChange(): { id: string; orderChanged: boolean; event: ConversationEvent } | null;
};
