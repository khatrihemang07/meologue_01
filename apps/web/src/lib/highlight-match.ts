export interface TextSegment {
  text: string;
  matched: boolean;
}

interface Token {
  value: string;
  start: number;
  end: number;
}

// Mirrors the tokenizer InMemoryEntryStore uses to mirror FTS5's unicode61
// tokenizer (test-support/in-memory-entry-store.ts): split on anything that
// isn't a letter or digit, case-fold the rest.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    tokens.push({
      value: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
    match = pattern.exec(text);
  }
  return tokens;
}

/**
 * Byte ranges in `body` matching `query` under the same phrase-prefix rule
 * as EntryStore.search (ADR 0014): every query word must appear in `body`
 * in that order, adjacently, case-insensitively, with the final query word
 * matched as a prefix of its body word. Computed from the query text alone —
 * never from the database — so it looks the same on every platform (ticket
 * 39).
 */
export function matchSpans(body: string, query: string): Array<{ start: number; end: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }
  const bodyTokens = tokenize(body);
  const lastIndex = queryTokens.length - 1;
  const spans: Array<{ start: number; end: number }> = [];

  for (let i = 0; i + queryTokens.length <= bodyTokens.length; i++) {
    const window = bodyTokens.slice(i, i + queryTokens.length);
    const matched = queryTokens.every((queryToken, j) => {
      const bodyToken = window[j];
      if (bodyToken === undefined) {
        return false;
      }
      return j === lastIndex
        ? bodyToken.value.startsWith(queryToken.value)
        : bodyToken.value === queryToken.value;
    });
    const first = window[0];
    const last = window.at(-1);
    if (matched && first !== undefined && last !== undefined) {
      spans.push({ start: first.start, end: last.end });
    }
  }

  return mergeSpans(spans);
}

function mergeSpans(
  spans: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Splits `body` into segments alternating unmatched/matched text, for rendering. */
export function highlightMatches(body: string, query: string): TextSegment[] {
  const spans = matchSpans(body, query);
  if (spans.length === 0) {
    return [{ text: body, matched: false }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ text: body.slice(cursor, span.start), matched: false });
    }
    segments.push({ text: body.slice(span.start, span.end), matched: true });
    cursor = span.end;
  }
  if (cursor < body.length) {
    segments.push({ text: body.slice(cursor), matched: false });
  }
  return segments;
}
