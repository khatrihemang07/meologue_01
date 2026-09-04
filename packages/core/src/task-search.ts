/**
 * The matching rules behind Search over Tasks (issue #183), shared by
 * every place that has to decide "does this text match this query" the
 * identical way: SqliteTaskStore's own JS fallback (below `MIN_TRIGRAM_
 * WORD_LENGTH`, where FTS5's trigram tokenizer can't help — see its own
 * comment) and its whole-word/completed mode, InMemoryTaskStore's search()
 * (which never touches SQLite at all), InMemoryCommentStore/
 * SqliteCommentStore's Comment search (small enough at this app's scale
 * to skip a hand-maintained FTS index entirely — see CommentStore's own
 * header comment on why `list()` already loads every Comment), and
 * apps/web's Quick-find dropdown, which narrows already-loaded Projects,
 * Sections and Labels the identical way rather than growing three more
 * FTS5 tables for collections that small.
 *
 * Two modes, both measured against a real Todoist rather than assumed
 * (issue #183's own reference-behaviour research):
 *
 * - **Substring** (the default): every whitespace-separated word of the
 *   query has to appear *somewhere* in the field, in any order, as a
 *   literal run of characters — `uildz` matches `Buildzzzing`. Punctuation
 *   is never stripped (`TestPunct` does not match `Test-Punct!`), and
 *   quoting a query does nothing special — a literal `"` is just another
 *   character a real Todoist happens almost never to contain, so quoting
 *   reads as "matches nothing" without this module special-casing it.
 * - **Whole-word** (the completed-Task opt-in, see TaskStore.search's own
 *   doc comment): every query word has to equal a whole word of the field
 *   exactly — punctuation-bounded, the same tokenisation FTS5's `unicode61`
 *   tokenizer already gave every Task title before this ticket. A
 *   completed Task found this way is deliberately less forgiving than an
 *   active one; Todoist documents this itself ("Searching for partial
 *   keywords won't match completed tasks"), and this module reproduces it
 *   rather than smoothing it away.
 *
 * Both modes are case-insensitive and diacritic-folded (`cafe` matches
 * `café`) via `normalize` below, and both treat an empty or
 * whitespace-only query as matching nothing — there is no query to
 * satisfy, not a query every field trivially satisfies.
 */

/** Case-folds and strips diacritics (NFKD decomposition, then the combining marks). */
export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function queryWords(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Substring mode. `field` may be `null`/`undefined` (a Task with no
 * Description yet) — never a match, the same as an empty string would be.
 */
export function matchesSubstring(field: string | null | undefined, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0 || field === null || field === undefined || field === "") {
    return false;
  }
  const normalizedField = normalize(field);
  return words.every((word) => normalizedField.includes(normalize(word)));
}

// Splits on anything that isn't a letter or digit, mirroring FTS5's
// unicode61 tokenizer (in-memory-entry-store.ts's identical comment on its
// own tokenize() gives the fuller reasoning) — this is deliberately the
// *old* tokenization Task titles carried before this ticket, kept alive
// here only for whole-word/completed mode.
function wholeWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

/** Whole-word mode — see this module's own header comment for when it applies. */
export function matchesWholeWord(field: string | null | undefined, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0 || field === null || field === undefined || field === "") {
    return false;
  }
  const fieldWords = wholeWords(field);
  return words.every((word) => fieldWords.has(normalize(word)));
}

/**
 * The 3-character floor FTS5's `trigram` tokenizer imposes (every indexed
 * token is exactly 3 characters) — a query containing a shorter word can
 * never be expressed as a trigram MATCH and would silently return nothing
 * if handed to one regardless (verified against SQLite 3.51 directly:
 * `... MATCH '"ab"'` against an indexed `"ab"` returns zero rows). Todoist
 * itself has no minimum length; the tables below (SqliteTaskStore) answer
 * that gap by routing any query containing a word shorter than this many
 * *code points* — not UTF-16 units, so a single-codepoint emoji still
 * counts as one "character" here rather than two — through this module's
 * plain-text matchers instead of a trigram MATCH, at the cost of a full
 * scan (this app's Tasks sit at the scale ADR 0014 already accepts a full
 * scan for, not History's).
 */
export const MIN_TRIGRAM_WORD_LENGTH = 3;

/** True when every word of `query` is long enough for a trigram MATCH to see at all. */
export function isTrigramSafe(query: string): boolean {
  const words = queryWords(query);
  return (
    words.length > 0 && words.every((word) => Array.from(word).length >= MIN_TRIGRAM_WORD_LENGTH)
  );
}

/**
 * Builds an FTS5 MATCH expression that ANDs every word of `query` as its
 * own literal, quoted phrase — `"word1" AND "word2"`, order-independent
 * because AND doesn't care which operand matched where, unlike a single
 * multi-word quoted phrase (which FTS5 would instead treat as one
 * substring, spaces included). Mirrors sqlite-entry-store.ts's
 * toPrefixMatchQuery's own escaping (doubling a literal `"`) but carries
 * no trailing `*`: trigram matching is already substring, so there's no
 * prefix operator to add. Only call this once isTrigramSafe(query) is true
 * — see MIN_TRIGRAM_WORD_LENGTH's own comment for why a shorter word has
 * to take the plain-text path above instead.
 */
export function toTrigramMatchQuery(query: string): string {
  return queryWords(query)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" AND ");
}
