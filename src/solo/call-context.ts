import { createHash } from 'node:crypto';

export type CallContextRole = 'local' | 'remote';
export type CallContextSourceKind = 'asr' | 'native_source' | 'native_output';

export type CallContextObservation = {
  role: CallContextRole;
  sourceId: string;
  sourceKind: CallContextSourceKind;
  /** Original source order/time, never completion arrival order. */
  at: number;
  order: number;
  revision: number;
  /** Time this exact raw revision became visible in this call. */
  observedAt: number;
  /** Trusted stop/commit boundary, never the delayed final's arrival time. */
  sourceEndAt?: number;
  text: string;
  final: boolean;
};

export type CallContextEntry = Omit<CallContextObservation, 'final'> & {
  provisional: boolean;
  generated: boolean;
  /** A complete recent sentence excerpt, never a guessed completion. */
  excerpt?: true;
};

export type CallContextSnapshot = {
  version: number;
  entries: ReadonlyArray<Readonly<CallContextEntry>>;
};

export type CallContextQuery = {
  beforeAt: number;
  beforeOrder?: number;
  maxVersion?: number;
  /** Enqueue-time observation cutoff; earlier provisional data stays frozen. */
  observedBeforeAt?: number;
  /** Admit only earlier ASR finals with a recorded prior source end. */
  allowLateFinal?: boolean;
};

export const CALL_CONTEXT_MAX_SOURCES_PER_ROLE = 4;
export const CALL_CONTEXT_VERSIONS_PER_SOURCE = 2;
export const CALL_CONTEXT_MAX_ENTRY_CHARACTERS = 600;
export const CALL_CONTEXT_MAX_ENTRIES = 6;
export const CALL_CONTEXT_MAX_CHARACTERS = 1600;
export const CALL_CONTEXT_MAX_AGE_MS = 120000;

type Stored = {
  entry?: CallContextEntry;
  observation: Omit<CallContextObservation, 'text'>;
  rawFingerprint: string;
  version: number;
};

const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const abbreviation =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Inc|Ltd|Co|Corp|Dept|Ave|Blvd|Rd|Mt|Pt|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|[A-Za-z])\.$/i;

/** Returns existing complete sentences only; never slices a fact-bearing tail. */
export function recentWholeContext(
  text: string,
): { text: string; excerpt?: true } | undefined {
  if (text.length <= CALL_CONTEXT_MAX_ENTRY_CHARACTERS)
    return text.trim() ? { text } : undefined;
  const ends: number[] = [];
  for (const match of text.matchAll(
    /[.!?]["'”’\])]*(?=\s|$)|[。！？]["”’）】]*/gu,
  )) {
    const end = match.index! + match[0].length;
    if (
      !(
        match[0].startsWith('.') &&
        abbreviation.test(text.slice(0, end).replace(/["'”’)\]]+$/u, ''))
      )
    ) {
      ends.push(end);
    }
  }
  if (!ends.length) return undefined;
  const last = ends.at(-1)!;
  // A later unfinished correction can invalidate an earlier complete fact.
  // Omit this entire oversized source rather than inventing its conclusion.
  if (text.slice(last).trim()) return undefined;
  for (const start of [0, ...ends.slice(0, -1)]) {
    const candidate = text.slice(start, last).trim();
    if (candidate && candidate.length <= CALL_CONTEXT_MAX_ENTRY_CHARACTERS)
      return { text: candidate, excerpt: true };
  }
  return undefined;
}

/** One instance per call. No global, persistence, transcript logging or models. */
export function createCallContext() {
  const sources = new Map<string, Stored[]>();
  let version = 0;
  let closed = false;
  const key = (role: CallContextRole, id: string) => `${role}:${id}`;
  return {
    observe(observation: CallContextObservation): boolean {
      if (
        closed ||
        !['local', 'remote'].includes(observation.role) ||
        !['asr', 'native_source', 'native_output'].includes(
          observation.sourceKind,
        ) ||
        typeof observation.sourceId !== 'string' ||
        !/^[A-Za-z0-9_:-]{1,240}$/.test(observation.sourceId) ||
        !integer(observation.at) ||
        !integer(observation.observedAt) ||
        observation.observedAt < observation.at ||
        (observation.sourceEndAt !== undefined &&
          (!integer(observation.sourceEndAt) ||
            observation.sourceEndAt < observation.at ||
            observation.sourceEndAt > observation.observedAt)) ||
        !integer(observation.order) ||
        !integer(observation.revision) ||
        typeof observation.text !== 'string' ||
        observation.text.length > 4096 ||
        typeof observation.final !== 'boolean'
      )
        return false;
      const id = key(observation.role, observation.sourceId);
      const prior = sources.get(id) ?? [];
      const latest = prior.at(-1)?.observation;
      const rawFingerprint = createHash('sha256')
        .update(observation.text)
        .digest('hex');
      if (
        latest &&
        (observation.at !== latest.at ||
          observation.order !== latest.order ||
          observation.sourceKind !== latest.sourceKind ||
          (latest.final &&
            latest.sourceEndAt !== undefined &&
            observation.sourceEndAt !== latest.sourceEndAt) ||
          observation.revision < latest.revision ||
          observation.observedAt < latest.observedAt ||
          (latest.final && !observation.final) ||
          (observation.revision === latest.revision &&
            rawFingerprint !== prior.at(-1)!.rawFingerprint))
      )
        return false;
      if (
        latest &&
        rawFingerprint === prior.at(-1)!.rawFingerprint &&
        observation.revision === latest.revision &&
        observation.final === latest.final &&
        observation.sourceEndAt === latest.sourceEndAt
      )
        return false;
      const content = recentWholeContext(observation.text);
      version = Math.min(version + 1, Number.MAX_SAFE_INTEGER);
      const immutableObservation = {
        role: observation.role,
        sourceId: observation.sourceId,
        sourceKind: observation.sourceKind,
        at: observation.at,
        order: observation.order,
        revision: observation.revision,
        observedAt: observation.observedAt,
        ...(observation.sourceEndAt === undefined
          ? {}
          : { sourceEndAt: observation.sourceEndAt }),
        final: observation.final,
      };
      // A tombstone prevents an unusable new revision from reviving old words.
      prior.push({
        version,
        observation: immutableObservation,
        rawFingerprint,
        ...(content
          ? {
              entry: {
                ...immutableObservation,
                ...content,
                provisional:
                  !observation.final ||
                  observation.sourceKind === 'native_output',
                generated: observation.sourceKind === 'native_output',
              },
            }
          : {}),
      });
      while (prior.length > CALL_CONTEXT_VERSIONS_PER_SOURCE) prior.shift();
      sources.set(id, prior);
      const sameRole = [...sources.entries()].filter(
        ([, history]) => history.at(-1)?.observation.role === observation.role,
      );
      if (sameRole.length > CALL_CONTEXT_MAX_SOURCES_PER_ROLE) {
        sameRole.sort(
          (a, b) =>
            a[1].at(-1)!.observation.at - b[1].at(-1)!.observation.at ||
            a[1].at(-1)!.observation.order - b[1].at(-1)!.observation.order,
        );
        sources.delete(sameRole[0][0]);
      }
      return true;
    },
    snapshot(query: CallContextQuery): CallContextSnapshot {
      const cutoffVersion = query.maxVersion ?? version;
      const observedCutoff = query.observedBeforeAt ?? query.beforeAt;
      if (
        closed ||
        !integer(query.beforeAt) ||
        !integer(observedCutoff) ||
        observedCutoff < query.beforeAt ||
        !integer(cutoffVersion) ||
        (query.beforeOrder !== undefined && !integer(query.beforeOrder)) ||
        (query.allowLateFinal !== undefined &&
          typeof query.allowLateFinal !== 'boolean')
      )
        return { version, entries: [] };
      const eligible: CallContextEntry[] = [];
      for (const history of sources.values()) {
        const record = [...history]
          .reverse()
          .find(({ observation, version: seen }) => {
            const earlierSource =
              observation.at < query.beforeAt ||
              (observation.at === query.beforeAt &&
                query.beforeOrder !== undefined &&
                observation.order < query.beforeOrder);
            const knownEarlierFinal =
              query.allowLateFinal &&
              observation.sourceKind === 'asr' &&
              observation.final &&
              observation.sourceEndAt !== undefined &&
              observation.sourceEndAt < query.beforeAt;
            return (
              seen <= cutoffVersion &&
              earlierSource &&
              observation.observedAt <= observedCutoff &&
              (observation.observedAt <= query.beforeAt || knownEarlierFinal)
            );
          });
        if (
          record?.entry &&
          observedCutoff -
            (record.observation.sourceKind === 'asr'
              ? (record.observation.sourceEndAt ??
                record.observation.observedAt)
              : record.observation.observedAt) <=
            CALL_CONTEXT_MAX_AGE_MS
        )
          eligible.push(record.entry);
      }
      eligible.sort((a, b) => a.at - b.at || a.order - b.order);
      const selected: CallContextEntry[] = [];
      let characters = 0;
      const recent = eligible.reverse();
      // One dense speaker must not crowd out the other available direction.
      for (const role of ['local', 'remote'] as const) {
        const entry = recent.find((candidate) => candidate.role === role);
        if (entry) {
          selected.push({ ...entry });
          characters += entry.text.length;
        }
      }
      for (const entry of recent) {
        if (
          !selected.some(
            (candidate) =>
              candidate.role === entry.role &&
              candidate.sourceId === entry.sourceId,
          )
        ) {
          if (
            !(
              selected.length >= CALL_CONTEXT_MAX_ENTRIES ||
              characters + entry.text.length > CALL_CONTEXT_MAX_CHARACTERS
            )
          ) {
            selected.push({ ...entry });
            characters += entry.text.length;
          }
        }
      }
      selected.sort((a, b) => a.at - b.at || a.order - b.order);
      return Object.freeze({
        version: Math.min(cutoffVersion, version),
        entries: Object.freeze(selected.map((entry) => Object.freeze(entry))),
      });
    },
    clear(): void {
      sources.clear();
      version = Math.min(version + 1, Number.MAX_SAFE_INTEGER);
    },
    close(): void {
      closed = true;
      sources.clear();
      version = Math.min(version + 1, Number.MAX_SAFE_INTEGER);
    },
  };
}
