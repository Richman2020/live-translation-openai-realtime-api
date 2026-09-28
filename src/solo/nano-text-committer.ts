export type NanoTextCommitterOptions = {
  onCommit: (text: string) => void;
  onError: (code: string) => void;
  boundaryDelayMs?: number;
  maxSentenceChars?: number;
  maxBufferChars?: number;
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

function firstBoundary(
  text: string,
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
    bufferLimit > 480
  )
    throw new Error('INVALID_NANO_TEXT_COMMITTER_OPTIONS');

  let buffer = '';
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
      const boundary = firstBoundary(buffer);
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
      buffer = buffer.slice(boundary.end);
      if (/[\p{L}\p{N}]/u.test(pendingText)) {
        try {
          options.onCommit(pendingText);
        } catch {
          fail('NANO_TEXT_COMMIT_FAILED');
          return;
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
      drain(false);
    },
    close,
  };
}
