import type { TranslationRole } from './translation-bridge';

export type ConversationSource = {
  sourceId: string;
  role: TranslationRole;
  /** Original source time, not the arrival time of a later translation. */
  at: number;
};

export type ConversationSpeakerTurnBinding = {
  speakerTurnId: string;
  speakerTurnSequence: number;
  /** Independent from text revision; late originals can correct a binding. */
  speakerTurnRevision: number;
  /** Stable tie breaker for sources with the same original timestamp. */
  sourceSequence: number;
};

export type ConversationSpeakerTurnUpdate = ConversationSource & {
  binding: ConversationSpeakerTurnBinding;
};

export type ConversationOriginalAcceptance = {
  accepted: boolean;
  binding?: ConversationSpeakerTurnBinding;
  /** Re-emit these sources' display metadata; never delay or replay audio. */
  updates: ConversationSpeakerTurnUpdate[];
};

type SourceRecord = ConversationSource & {
  sourceSequence: number;
  originalRevision: number;
  active: boolean;
  binding?: ConversationSpeakerTurnBinding;
};

type RetiredTurn = {
  role: TranslationRole;
  speakerTurnId: string;
  speakerTurnSequence: number;
  speakerTurnRevision: number;
};

const DEFAULT_MAX_SOURCES = 1024;
const MAX_SOURCES = 8192;

function validSource(source: ConversationSource): boolean {
  return (
    (source.role === 'local' || source.role === 'remote') &&
    typeof source.sourceId === 'string' &&
    source.sourceId.length > 0 &&
    source.sourceId.length <= 512 &&
    !/\p{Cc}/u.test(source.sourceId) &&
    Number.isSafeInteger(source.at) &&
    source.at >= 0
  );
}

function sourceKey(sourceId: string, role: TranslationRole): string {
  return `${role}\u0000${sourceId}`;
}

function sourceOrder(left: SourceRecord, right: SourceRecord): number {
  return left.at - right.at || left.sourceSequence - right.sourceSequence;
}

/**
 * One call's bounded display-only speaker turns. Source registration records
 * order without asserting speech; only a nonempty raw original establishes a
 * turn. Translations can look up an exact source binding but cannot create a
 * turn or infer a pairing for append-only native output streams.
 *
 * Late accepted originals rebuild the retained chronology and explicitly return
 * binding corrections. An evicted source stays unbound: it is never attached to
 * today's latest same-role turn. Eviction limits memory, not call duration, and
 * does not close media, change authentication, or trigger provider work.
 */
export class ConversationSpeakerTurns {
  private readonly maxSources: number;

  private readonly sources = new Map<string, SourceRecord>();

  private sourceSequence = 0;

  private bindingRevision = 0;

  private retiredAt = -1;

  private retiredTurn?: RetiredTurn;

  constructor(options: { maxSources?: number } = {}) {
    const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
    if (
      !Number.isSafeInteger(maxSources) ||
      maxSources < 1 ||
      maxSources > MAX_SOURCES
    )
      throw new RangeError('Invalid conversation source capacity');
    this.maxSources = maxSources;
  }

  registerSource(source: ConversationSource): boolean {
    if (!validSource(source)) return false;
    const key = sourceKey(source.sourceId, source.role);
    const existing = this.sources.get(key);
    if (existing) return existing.at === source.at;
    // All records at or before this boundary are deliberately conservative.
    // Without unbounded tombstones an old ID must never become a new anchor.
    if (
      source.at <= this.retiredAt ||
      this.sourceSequence === Number.MAX_SAFE_INTEGER
    )
      return false;
    this.sourceSequence += 1;
    this.sources.set(key, {
      sourceId: source.sourceId,
      role: source.role,
      at: source.at,
      sourceSequence: this.sourceSequence,
      originalRevision: -1,
      active: false,
    });
    this.trimSources();
    return this.sources.has(key);
  }

  acceptOriginal(
    source: ConversationSource & {
      text: string;
      revision?: number;
      final?: boolean;
    },
  ): ConversationOriginalAcceptance {
    const revision = source.revision ?? 0;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof source.text !== 'string' ||
      !this.registerSource(source)
    )
      return { accepted: false, updates: [] };
    const record = this.sources.get(sourceKey(source.sourceId, source.role));
    if (!record || revision <= record.originalRevision)
      return {
        accepted: false,
        ...(record?.binding ? { binding: { ...record.binding } } : {}),
        updates: [],
      };
    record.originalRevision = revision;
    // Silence, whitespace and punctuation-only ASR artifacts do not interrupt
    // another speaker. No cleanup or guessed words alter the raw original.
    if (!/[\p{L}\p{N}]/u.test(source.text)) {
      // A higher final source version can withdraw a provisional ASR fragment.
      // Remove its speaker boundary too, otherwise invisible speech leaves two
      // same-speaker blocks. A temporary empty draft keeps the established
      // source, and only a later valid original can activate it again.
      if (source.final === true && record.active) {
        record.active = false;
        record.binding = undefined;
        return { accepted: true, updates: this.rebuildBindings() };
      }
      return {
        accepted: false,
        ...(record.binding ? { binding: { ...record.binding } } : {}),
        updates: [],
      };
    }
    // Text deltas and revisions of an already active source cannot change its
    // chronological position, so avoid rebuilding turns on every ASR delta.
    const updates = record.active ? [] : this.activateAndRebuild(record);
    return {
      accepted: true,
      binding: { ...record.binding },
      updates,
    };
  }

  lookup(
    sourceId: string,
    role: TranslationRole,
  ): ConversationSpeakerTurnBinding | undefined {
    const binding = this.sources.get(sourceKey(sourceId, role))?.binding;
    return binding ? { ...binding } : undefined;
  }

  currentTurn(): Omit<RetiredTurn, 'speakerTurnRevision'> | undefined {
    const latest = [...this.sources.values()]
      .filter((source) => source.active)
      .sort(sourceOrder)
      .at(-1);
    const binding = latest?.binding || this.retiredTurn;
    const role = latest?.role || this.retiredTurn?.role;
    return binding && role
      ? {
          role,
          speakerTurnId: binding.speakerTurnId,
          speakerTurnSequence: binding.speakerTurnSequence,
        }
      : undefined;
  }

  retainedSourceCount(): number {
    return this.sources.size;
  }

  clear(): void {
    this.sources.clear();
    this.retiredAt = -1;
    this.retiredTurn = undefined;
    // Keep counters monotonic so a stale display event cannot reuse a new ID.
  }

  private trimSources(): void {
    const ordered = [...this.sources.values()].sort(sourceOrder);
    for (const source of ordered) {
      if (this.sources.size <= this.maxSources) break;
      this.sources.delete(sourceKey(source.sourceId, source.role));
      this.retiredAt = Math.max(this.retiredAt, source.at);
      if (source.active && source.binding)
        this.retiredTurn = {
          role: source.role,
          speakerTurnId: source.binding.speakerTurnId,
          speakerTurnSequence: source.binding.speakerTurnSequence,
          speakerTurnRevision: source.binding.speakerTurnRevision,
        };
    }
  }

  private activateAndRebuild(
    record: SourceRecord,
  ): ConversationSpeakerTurnUpdate[] {
    record.active = true;
    return this.rebuildBindings();
  }

  private rebuildBindings(): ConversationSpeakerTurnUpdate[] {
    const active = [...this.sources.values()]
      .filter((source) => source.active)
      .sort(sourceOrder);
    let turn = this.retiredTurn;
    let sequence = turn?.speakerTurnSequence || 0;
    const proposed = active.map((source) => {
      if (!turn || turn.role !== source.role) {
        sequence += 1;
        turn = {
          role: source.role,
          speakerTurnId: `speaker_turn_${source.sourceSequence}`,
          speakerTurnSequence: sequence,
          speakerTurnRevision: 0,
        };
      }
      return {
        source,
        binding: {
          speakerTurnId: turn.speakerTurnId,
          speakerTurnSequence: turn.speakerTurnSequence,
          sourceSequence: source.sourceSequence,
        },
      };
    });
    const changes = proposed.filter(
      ({ source, binding }) =>
        source.binding?.speakerTurnId !== binding.speakerTurnId ||
        source.binding?.speakerTurnSequence !== binding.speakerTurnSequence,
    );
    if (!changes.length) return [];
    this.bindingRevision += 1;
    const updates: ConversationSpeakerTurnUpdate[] = [];
    for (const { source, binding } of changes) {
      const previouslyBound = !!source.binding;
      source.binding = {
        ...binding,
        speakerTurnRevision: this.bindingRevision,
      };
      if (previouslyBound)
        updates.push({
          sourceId: source.sourceId,
          role: source.role,
          at: source.at,
          binding: { ...source.binding },
        });
    }
    return updates;
  }
}
