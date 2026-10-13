export type CaptionSection = {
  id: string;
  text: string;
  at: number;
  final: boolean;
};

export type CaptionSections = {
  register(id: string, at: number): void;
  update(id: string, text: string, sourceFinal: boolean): CaptionSection[];
  hasOpen(): boolean;
  seal(): CaptionSection[];
  break(): CaptionSection[];
};

export const CAPTION_SECTION_MAX_SOURCES = 512;
export const CAPTION_SECTION_MAX_COMPLETED = 512;
export const CAPTION_SECTION_MAX_SPLIT = 8;
const MAX_SOURCE_TEXT = 4096;
const NATURAL_SECTION_CHARACTERS = 240;

type Source = {
  id: string;
  at: number;
  order: number;
  epoch: number;
  text: string;
  final: boolean;
  completed: boolean;
  section?: Section;
};
type Section = {
  id: string;
  at: number;
  sources: Source[];
  sealRequested: boolean;
  emitted?: CaptionSection;
};

function joinSources(sources: Source[]): string {
  return sources.reduce((text, source) => {
    const next = source.text.trim();
    if (!next) return text;
    if (!text) return next;
    // Preserve fragments as received. In particular, never repair a truncated
    // word by adding letters or by guessing that two source items form a word.
    return `${text}${/^[,.;:!?%)]/.test(next) ? '' : ' '}${next}`;
  }, '');
}

export function captionNeedsContinuation(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+(?:['’−-][\p{L}\p{N}]+)*/gu);
  return (
    !words ||
    words.length <= 3 ||
    /\b(?:a|an|the|for|to|and|or|of|at|on|in|with|from|by|but|if|as|than|because|although|is|are|was|were|be|been|will|would|can|could|should|must|not)[.!?,:;"'”’\])\s]*$/i.test(
      text,
    )
  );
}

function completeSentence(text: string): boolean {
  if (!/[.!?]["'”’\])]*$/.test(text) || captionNeedsContinuation(text))
    return false;
  // A source endpoint after a title, initial, or ellipsis is not a reliable
  // sentence ending. Explicit pause/break sealing remains available to callers.
  return !/(?:\.{2,}|(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Inc|Ltd|Co|Corp|Dept|Ave|Blvd|Rd|Mt|Pt|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)|\b[A-Za-z])\.)["'”’\])]*$/i.test(
    text,
  );
}

function splitSealedText(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]["'”’\])]*(?=\s|$)/g)) {
    if (parts.length >= CAPTION_SECTION_MAX_SPLIT - 1) break;
    const end = match.index! + match[0].length;
    const part = text.slice(start, end).trim();
    if (completeSentence(part)) {
      parts.push(part);
      start = end;
    }
  }
  const remainder = text.slice(start).trim();
  if (remainder || !parts.length) parts.push(remainder);
  return parts;
}

/**
 * Accumulates one speaker's ASR source items into visible caption sections.
 * Register source start/commit timestamps before feeding their cumulative text;
 * update's final flag completes a source item, not necessarily a caption section.
 * The owner supplies the pause timer (e.g. a 1200 ms grace) and calls seal().
 * Call break() at a speaker/direction boundary. No words, timers, or supplier
 * requests are generated here, and a displayed section never changes its ID.
 * At a final section boundary, reliable sentence substrings may become separate
 * rows. The first replaces the previous whole-section draft; additional IDs use
 * a colon namespace unavailable to provider source IDs. Their timestamps remain
 * the shared source timestamp, not invented sentence-level acoustic timestamps.
 */
export function createCaptionSections(): CaptionSections {
  const sources = new Map<string, Source>();
  const completed: string[] = [];
  const sections = new Set<Section>();
  let pending = 0;
  let sequence = 0;
  let epoch = 0;

  const closeSource = (source: Source) => {
    source.completed = true;
    source.text = '';
    source.section = undefined;
    pending -= 1;
    completed.push(source.id);
    if (completed.length > CAPTION_SECTION_MAX_COMPLETED)
      sources.delete(completed.shift()!);
  };

  const emit = (section: Section): CaptionSection[] => {
    const text = joinSources(section.sources);
    const sourceFinal = section.sources.every((source) => source.final);
    const final =
      sourceFinal &&
      (section.sealRequested ||
        !text ||
        completeSentence(text) ||
        (text.length >= NATURAL_SECTION_CHARACTERS &&
          !captionNeedsContinuation(text)));
    const parts = final ? splitSealedText(text) : [text];
    const snapshot = {
      id: section.id,
      text: parts[0],
      at: section.at,
      final,
    };
    const changed =
      !section.emitted ||
      section.emitted.text !== snapshot.text ||
      section.emitted.final !== final;
    section.emitted = snapshot;
    if (final) {
      sections.delete(section);
      for (const source of section.sources) closeSource(source);
    }
    return [
      ...(changed ? [snapshot] : []),
      ...parts.slice(1).map((part, index) => ({
        id: `caption:${section.id}:${index + 2}`,
        text: part,
        at: section.at,
        final: true,
      })),
    ];
  };

  const seal = () => {
    const changed: CaptionSection[] = [];
    for (const section of [...sections].sort((a, b) => a.at - b.at)) {
      section.sealRequested = true;
      changed.push(...emit(section));
    }
    return changed;
  };

  return {
    register(id, at) {
      if (
        typeof id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(id) ||
        !Number.isFinite(at)
      )
        throw new Error('INVALID_CAPTION_SOURCE');
      if (sources.has(id)) return;
      if (pending >= CAPTION_SECTION_MAX_SOURCES)
        throw new Error('CAPTION_SECTION_LIMIT');
      sequence += 1;
      sources.set(id, {
        id,
        at,
        order: sequence,
        epoch,
        text: '',
        final: false,
        completed: false,
      });
      pending += 1;
    },
    update(id, text, sourceFinal) {
      const source = sources.get(id);
      if (
        !source ||
        typeof text !== 'string' ||
        text.length > MAX_SOURCE_TEXT ||
        typeof sourceFinal !== 'boolean'
      )
        throw new Error('INVALID_CAPTION_SOURCE');
      if (source.completed || (source.final && !sourceFinal)) return [];
      if (source.text === text && source.final === sourceFinal) return [];
      source.text = text;
      source.final = sourceFinal;

      if (!source.section) {
        if (!text.trim()) {
          if (sourceFinal) closeSource(source);
          return [];
        }
        const ordered = [...sources.values()].sort(
          (a, b) => a.at - b.at || a.order - b.order,
        );
        const previous = ordered[ordered.indexOf(source) - 1];
        const candidate = previous?.section;
        if (
          candidate &&
          !candidate.sealRequested &&
          previous.final &&
          previous.epoch === source.epoch &&
          candidate.sources.at(-1) === previous
        ) {
          source.section = candidate;
          candidate.sources.push(source);
        } else {
          source.section = {
            id: source.id,
            at: source.at,
            sources: [source],
            sealRequested: source.epoch !== epoch,
          };
          sections.add(source.section);
        }
      }
      return emit(source.section);
    },
    hasOpen: () => sections.size > 0,
    seal,
    break() {
      const changed = seal();
      epoch += 1;
      return changed;
    },
  };
}
