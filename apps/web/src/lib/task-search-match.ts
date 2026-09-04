import { normalize } from "@meologue/core";

export interface TextSegment {
  text: string;
  matched: boolean;
}

/**
 * Highlight spans for the Quick-find dropdown's own substring matching
 * (issue #183) — the dropdown-only counterpart to ../hooks/... History's
 * highlight-match.ts, which instead mirrors EntryStore's *prefix* rule
 * (ADR 0014). This one mirrors @meologue/core's task-search.ts
 * matchesSubstring instead: every whitespace-separated word of `query` can
 * appear *anywhere* in `text`, independently, so this highlights every
 * such occurrence rather than one contiguous phrase-shaped run.
 *
 * Works in `normalize()`'s folded space (case/diacritic-insensitive,
 * @meologue/core) and maps the resulting spans back onto the *original*
 * `text` by index — safe because folding a Task title (case + stripping
 * combining marks) doesn't change its length for the composed Unicode text
 * this app actually deals with. If it ever did (`normalize(text).length !==
 * text.length`), this falls back to no highlighting rather than risk
 * slicing `text` at an index that came from a differently-sized string —
 * an unhighlighted-but-correct result beats a mis-sliced one.
 */
export function highlightSubstring(text: string, query: string): TextSegment[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return [{ text, matched: false }];
  }
  const normalizedText = normalize(text);
  if (normalizedText.length !== text.length) {
    return [{ text, matched: false }];
  }
  const spans: Array<{ start: number; end: number }> = [];
  for (const word of words) {
    const normalizedWord = normalize(word);
    if (normalizedWord.length === 0) {
      continue;
    }
    let from = 0;
    for (;;) {
      const index = normalizedText.indexOf(normalizedWord, from);
      if (index === -1) {
        break;
      }
      spans.push({ start: index, end: index + normalizedWord.length });
      from = index + 1;
    }
  }
  if (spans.length === 0) {
    return [{ text, matched: false }];
  }
  return toSegments(text, mergeSpans(spans));
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

function toSegments(text: string, spans: Array<{ start: number; end: number }>): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), matched: false });
    }
    segments.push({ text: text.slice(span.start, span.end), matched: true });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false });
  }
  return segments;
}
