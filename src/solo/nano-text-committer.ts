export type NanoTextCommitterOptions = {
  onCommit: (text: string) => void;
  onError: (code: string) => void;
  /** Diagnostic only: time spent waiting for a text boundary, not call latency. */
  onCommitTiming?: (timing: { bufferWaitMs: number; chars: number }) => void;
  now?: () => number;
  boundaryDelayMs?: number;
  maxSentenceChars?: number;
  maxBufferChars?: number;
  /** Opt-in English clause commits for live caption calls; old mode stays unchanged. */
  clauseBoundaries?: boolean;
};

export type NanoTextCommitter = {
  append(delta: string): void;
  close(): void;
};

const CLOSING_MARKS = /["'\u201d\u2019\u00bb)\]}]/;
const TERMINATORS = /[.!?;\u3002\uff01\uff1f\uff1b]/;
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'fig',
  'dept',
  'inc',
  'ltd',
  'co',
  'approx',
  'est',
]);

function isAbbreviation(text: string, period: number): boolean {
  const prefix = text.slice(0, period + 1);
  const word = prefix.match(/([a-z]+)\.$/i)?.[1];
  if (word && (word.length === 1 || ABBREVIATIONS.has(word.toLowerCase())))
    return true;
  // Hold dotted initials/time abbreviations even at an apparent sentence end.
  // Guessing that "U.S." or "a.m." ended the turn would risk premature speech.
  return /(?:[a-z]\.){2,}$/i.test(prefix);
}

function isClauseBoundary(left: string, right: string): boolean {
  const words = left.match(/[a-z]+(?:['\u2019][a-z]+)?/gi) || [];
  if (words.length < 8 || left.trim().length < 36) return false;
  // An opening condition can contain incidental commas before its main clause.
  // Keep the whole conditional together instead of guessing which comma closes it.
  if (
    /^\s*(?:if|when|unless|although|because|while|before|after|until|once|whether)\b/i.test(
      left,
    )
  )
    return false;
  // A conditional/introduction must not be spoken as a standalone assertion.
  // A later clause may still qualify after the introductory comma.
  const lastClause = left.slice(left.lastIndexOf(',') + 1).trim();
  if (
    /^(?:if|when|unless|although|because|while|before|after|until|once|whether)\b/i.test(
      lastClause,
    )
  )
    return false;
  if (
    /\b(?:not|no|without|except|including|such as|either|neither|and|or|but|to|for|with|from|at|in|on)\s*$/i.test(
      left,
    )
  )
    return false;
  if (
    /^\s*(?:(?:and|but)\s+)?(?:i\s+(?:mean|meant|was\s+(?:mistaken|wrong))|sorry|actually|rather|correction)\b/i.test(
      right,
    )
  )
    return false;
  // A purpose can follow an already complete request, as in "I'd like to book
  // tomorrow at two p.m., to clean ...". Keep time/number commas intact; only
  // explicit lower-case infinitive verbs qualify, never "to New York" or
  // "to the room". Conditional openings must keep their main clause attached.
  if (
    !/^\s*(?:if|when|unless|although|because|while|before|after|until|once|whether)\b/i.test(
      left,
    ) &&
    /^\s*to (?:clean|check|confirm|discuss|arrange|repair|replace|inspect|help|ask|find|buy|book|schedule|collect|pick|drop|meet|talk|speak|review|make|get|have|see|visit|deliver|install)\s+[a-z]/.test(
      right,
    )
  )
    return true;
  // Wait for a complete word after the new subject so "..., and I" alone
  // cannot flush. The stream is append-only; no draft ASR is spoken here.
  return /^\s*(?:(?:and|but|so|then|also|however)\s+)?(?:(?:i|we|you|he|she|they|it|there)(?:['\u2019](?:m|re|s|ve|ll|d))?\s+[a-z]+(?:['\u2019][a-z]+)?\b\s|please\s+[a-z]+\b\s|(?:do not|don['\u2019]t)\s+[a-z]+\b\s)/i.test(
    right,
  );
}

function firstBoundary(
  text: string,
  clauseBoundaries: boolean,
): { end: number; atTail: boolean } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const mark = text[index];
    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    const ambiguousPeriod =
      mark === '.' &&
      (previous === '.' ||
        next === '.' ||
        (/\d/.test(previous) && /\d/.test(next)) ||
        /[a-z]/i.test(next) ||
        isAbbreviation(text, index));
    // The translation stream often writes several spoken sentences as one
    // comma-linked sentence. Do not wait for its final full stop if a sizeable
    // clause is followed by an explicit new subject/imperative. Requiring right
    // context keeps commas in numbers, lists and trailing corrections buffered.
    if (
      clauseBoundaries &&
      mark === ',' &&
      !(/\d/.test(previous) && /\d/.test(next)) &&
      isClauseBoundary(text.slice(0, index), text.slice(index + 1))
    )
      return { end: index + 1, atTail: false };
    if (TERMINATORS.test(mark) && !ambiguousPeriod) {
      let end = index + 1;
      while (end < text.length && TERMINATORS.test(text[end])) end += 1;
      while (end < text.length && CLOSING_MARKS.test(text[end])) end += 1;
      return { end, atTail: !text.slice(end).trim() };
    }
  }
  return undefined;
}

/**
 * Segment the translation protocol's append-only text for a local TTS worker.
 * These are APPLICATION punctuation boundaries, never provider-final turns.
 * Raw deltas are concatenated without invented spaces; only each job's outside
 * whitespace is removed. A short hold for trailing punctuation lets split
 * decimals/abbreviations/closing quotes arrive. It cannot prove semantic finality.
 * With clauseBoundaries, a qualifying comma + next-clause context also commits.
 * An unpunctuated or ambiguous abbreviation tail is never flushed by silence or
 * timeout. Excess text fails explicitly; close cancels and discards the tail.
 */
export function createNanoTextCommitter(
  options: NanoTextCommitterOptions,
): NanoTextCommitter {
  const delay = options.boundaryDelayMs ?? 300;
  const sentenceLimit = options.maxSentenceChars ?? 240;
  const bufferLimit = options.maxBufferChars ?? 480;
  if (
    typeof options.onCommit !== 'function' ||
    typeof options.onError !== 'function' ||
    !Number.isInteger(delay) ||
    delay < 1 ||
    delay > 2000 ||
    !Number.isInteger(sentenceLimit) ||
    sentenceLimit < 1 ||
    sentenceLimit > 240 ||
    !Number.isInteger(bufferLimit) ||
    bufferLimit < sentenceLimit ||
    bufferLimit > 480 ||
    (options.clauseBoundaries !== undefined &&
      typeof options.clauseBoundaries !== 'boolean') ||
    (options.onCommitTiming !== undefined &&
      typeof options.onCommitTiming !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function')
  )
    throw new Error('INVALID_NANO_TEXT_COMMITTER_OPTIONS');

  let buffer = '';
  // Delta ranges retain their arrival times so a remaining second clause does
  // not inherit the already committed first clause's wait.
  let arrivals: { chars: number; at: number }[] = [];
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const close = () => {
    closed = true;
    cancelTimer();
    buffer = '';
    arrivals = [];
  };
  const fail = (code: string) => {
    if (closed) return;
    close();
    try {
      options.onError(code);
    } catch {
      // Already stopped; never leak callback content into provider logs.
    }
  };

  const drain = (allowPunctuatedTail: boolean) => {
    const commitPunctuatedTail = () => {
      timer = undefined;
      drain(true);
    };
    while (!closed) {
      const boundary = firstBoundary(buffer, options.clauseBoundaries === true);
      const pendingText = boundary
        ? buffer.slice(0, boundary.end).trim()
        : buffer.trim();
      if (pendingText.length > sentenceLimit) {
        fail('NANO_TEXT_SENTENCE_TOO_LONG');
        return;
      }
      if (!boundary) return;
      if (boundary.atTail && !allowPunctuatedTail) {
        timer = setTimeout(commitPunctuatedTail, delay);
        timer.unref?.();
        return;
      }
      let leadingChars = buffer.length - buffer.trimStart().length;
      let firstAt: number | undefined;
      for (const arrival of arrivals) {
        if (leadingChars < arrival.chars) {
          firstAt = arrival.at;
          break;
        }
        leadingChars -= arrival.chars;
      }
      buffer = buffer.slice(boundary.end);
      let consumed = boundary.end;
      while (consumed > 0 && arrivals.length) {
        const first = arrivals[0];
        if (consumed < first.chars) {
          first.chars -= consumed;
          consumed = 0;
        } else {
          consumed -= first.chars;
          arrivals.shift();
        }
      }
      if (/[\p{L}\p{N}]/u.test(pendingText)) {
        try {
          options.onCommit(pendingText);
        } catch {
          fail('NANO_TEXT_COMMIT_FAILED');
          return;
        }
        try {
          options.onCommitTiming?.({
            bufferWaitMs: Math.max(
              0,
              (options.now || Date.now)() -
                (firstAt ?? (options.now || Date.now)()),
            ),
            chars: pendingText.length,
          });
        } catch {
          // Diagnostics cannot delay or break a spoken phrase.
        }
      }
    }
  };

  return {
    append(delta) {
      if (closed) return;
      if (typeof delta !== 'string') {
        fail('NANO_TEXT_INVALID_DELTA');
        return;
      }
      if (!delta.length) return;
      cancelTimer();
      if (buffer.length + delta.length > bufferLimit) {
        fail('NANO_TEXT_BUFFER_OVERFLOW');
        return;
      }
      buffer += delta;
      arrivals.push({ chars: delta.length, at: (options.now || Date.now)() });
      drain(false);
    },
    close,
  };
}
