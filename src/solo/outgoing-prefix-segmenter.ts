export type PrefixSourceSegment = {
  id: string;
  itemId: string;
  text: string;
  firstDeltaAt: number;
};
export type PrefixUpdate = {
  segments: PrefixSourceSegment[];
  invalidatedIds: string[];
  correctionAfterCommit: boolean;
};
type Turn = {
  spoken: string;
  staged: PrefixSourceSegment[];
  firstDeltaAt: number;
};
const MAX_TEXT = 4096;
const numericPunctuation = (text: string, index: number) =>
  /^[.,]$/u.test(text[index] ?? '') &&
  /\d/u.test(text[index - 1] ?? '') &&
  /\d/u.test(text[index + 1] ?? '');
const canonical = (text: string) => {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (
      !/[\s，。！？；：、,.!?;:]/u.test(character) ||
      numericPunctuation(text, index)
    )
      output += character;
  }
  return output;
};
const skip = /^[\s，。！？；：、,.!?;:]+/u;
const incomplete =
  /(?:不|没|未|别|不要|不是|并非|不能|不想|不需要|而是|改成|更正为|换成|如果|假如|除非|只要|尽管|虽然|但是|或者|以及|因为|所以|上午|下午|晚上|凌晨|第|一共|总共|大约|至少|最多)$/u;
const unsafeTail =
  /(?:不|没|未|别|不要|不是|并非|不能|不想|不需要|而是|改成|更正为|换成|第|一共|总共|大约|至少|最多)$/u;
const numberTail = /(?:\d|[零一二三四五六七八九十百千万两])$/u;
function sourceOffset(text: string, count: number): number {
  let consumed = 0;
  let offset = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (canonical(text[index]) || numericPunctuation(text, index))
      consumed += 1;
    offset = index + 1;
    if (consumed === count) break;
  }
  return count ? offset : 0;
}

/** Only lexical openings or explicit punctuation; never an N-character cutoff. */
function boundary(text: string, final: boolean): number {
  const greeting =
    /^(?:你好|您好|谢谢|非常感谢|对不起|不好意思|早上好|下午好|晚上好)/u.exec(
      text,
    );
  if (greeting) {
    const rest = text.slice(greeting[0].length);
    // Lookahead distinguishes "你好，我…" from "你好吗" or "你好像…".
    if (
      /^[，。！？；,.!?;]/u.test(rest) ||
      /^(?:我|请|这是|今天|明天|想|需要)/u.test(rest)
    )
      return greeting[0].length;
  }
  const intent =
    /^(?:(?:我|我们)(?:想要|想|希望|需要)(?:预约|咨询|询问|了解|取消|修改)|请(?:帮我|帮我们)(?:预约|取消|修改))/u.exec(
      text,
    );
  if (intent && text.length > intent[0].length) {
    const rest = text.slice(intent[0].length);
    // Do not split ambiguous compound verbs: 预约系统 / 取消键 / 了解情况.
    if (
      /^[，。！？；,.!?;]/u.test(rest) ||
      /^(?:今天|明天|后天|星期|周|一个|一下|时间|服务|清洁|房间|但|不过)/u.test(
        rest,
      )
    )
      return intent[0].length;
  }
  const punctuation = /[，。！？；,.!?;]/gu;
  for (const match of text.matchAll(punctuation)) {
    const end = match.index + match[0].length;
    const clause = text.slice(0, match.index).trim();
    const weak = /^[，,]$/u.test(match[0]);
    const blocked =
      !clause ||
      numericPunctuation(text, match.index) ||
      (!final && (unsafeTail.test(clause) || numberTail.test(clause))) ||
      (weak && incomplete.test(clause)) ||
      (/^(?:如果|假如|除非|只要|虽然|尽管)/u.test(clause) &&
        !/(?:就|那么|但是|仍然|也)/u.test(clause)) ||
      (/^(?:不是|不对|更正|改成|而是)/u.test(clause) && clause.length < 5);
    if (!blocked) return end;
  }
  return 0;
}

/**
 * Prefixes are provisional ASR data, not guaranteed truth. Final corrections
 * replace unsaid segments; a revision to already committed speech is reported.
 */
export class OutgoingPrefixSegmenter {
  private readonly turns = new Map<string, Turn>();

  private sequence = 0;

  update(
    itemId: string,
    text: string,
    final: boolean,
    at: number,
  ): PrefixUpdate {
    if (
      !/^[a-zA-Z0-9_-]{1,200}$/u.test(itemId) ||
      typeof text !== 'string' ||
      text.length > MAX_TEXT ||
      !Number.isFinite(at)
    )
      throw new Error('PREFIX_INVALID_SOURCE');
    let turn = this.turns.get(itemId);
    if (!turn) {
      if (this.turns.size >= 32) throw new Error('PREFIX_SOURCE_BACKLOG');
      turn = { spoken: '', staged: [], firstDeltaAt: at };
      this.turns.set(itemId, turn);
    }
    if (!canonical(text).startsWith(turn.spoken)) {
      return {
        segments: [],
        invalidatedIds: turn.staged.map((entry) => entry.id),
        correctionAfterCommit: true,
      };
    }
    let rest = text.slice(sourceOffset(text, turn.spoken.length));
    const pieces: string[] = [];
    while (rest) {
      rest = rest.replace(skip, '');
      if (!rest) break;
      const end = boundary(rest, final);
      if (!end) {
        if (final && canonical(rest)) pieces.push(rest.trim());
        break;
      }
      pieces.push(rest.slice(0, end).trim());
      rest = rest.slice(end);
    }
    const previous = turn.staged;
    const next: PrefixSourceSegment[] = [];
    const segments: PrefixSourceSegment[] = [];
    let unchanged = true;
    for (let index = 0; index < pieces.length; index += 1) {
      const prior = previous[index];
      if (
        unchanged &&
        prior &&
        canonical(prior.text) === canonical(pieces[index])
      ) {
        next.push(prior);
      } else {
        unchanged = false;
        this.sequence += 1;
        const entry = {
          id: `prefix_${this.sequence}`,
          itemId,
          text: pieces[index],
          firstDeltaAt: turn.firstDeltaAt,
        };
        next.push(entry);
        segments.push(entry);
      }
    }
    const retained = new Set(next.map((entry) => entry.id));
    const invalidatedIds = previous
      .filter((entry) => !retained.has(entry.id))
      .map((entry) => entry.id);
    turn.staged = next;
    return { segments, invalidatedIds, correctionAfterCommit: false };
  }

  markCommitted(id: string): void {
    const turn = [...this.turns.values()].find(
      (entry) => entry.staged[0]?.id === id,
    );
    if (!turn) throw new Error('PREFIX_COMMIT_ORDER');
    turn.spoken += canonical(turn.staged.shift().text);
  }

  forget(itemId: string): void {
    this.turns.delete(itemId);
  }

  clear(): void {
    this.turns.clear();
  }
}
