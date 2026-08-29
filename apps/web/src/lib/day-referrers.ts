/**
 * Answers "which later Entries Refer to this local day?" (issue #147, ADR
 * 0042's own Context: "a day can also be asked what Refers to it") — the
 * half of the Reference feature that makes a *day* reachable from its own
 * future, rather than only making a new Entry able to point backwards.
 *
 * The reverse of `dayHasEntries` (day-has-entries.ts, issue #142) next
 * door, on the same axis: that one answers "does this day have anything a
 * Reference could resolve to"; this one answers "what points back at it".
 *
 * Two steps, and both matter — this is what keeps the answer honest rather
 * than approximate:
 *
 * **Step 1 — narrow with the index.** `store.search(dayKey)` runs the
 * plain `YYYY-MM-DD` text through the FTS5 index ADR 0014 already
 * maintains. FTS5's `unicode61` tokenizer treats `-`, `[` and `]` as token
 * separators, so `[[2026-08-28]]` indexes as the three tokens `2026`,
 * `08`, `28` — exactly the tokens `dayKey` itself splits into — so this
 * search finds every Entry carrying the mark, with no schema change and
 * nothing new stored.
 *
 * **Step 2 — confirm by parsing.** Step 1 over-matches: an Entry that
 * merely *mentions* the date in prose — "renewed the lease on
 * 2026-08-28", no brackets anywhere — tokenizes identically and comes back
 * from the same search, but nobody asked it to be a Reference. Every
 * candidate is re-parsed with `parseInlineMarkdown`, the exact parser the
 * renderer itself uses, and kept only if it actually contains a
 * `dateReference` node naming this exact day. Skipping this step would
 * make the count a guess about which Entries happen to share three words
 * with `dayKey`, not an answer about References.
 *
 * **Self-References are excluded.** An Entry captured ON `dayKey` that
 * Refers to that same day is not a *later* Entry pointing back at it — the
 * whole feature exists to make a day reachable from Entries written after
 * it (ADR 0042's Context), and a day is never unreachable from an Entry it
 * already holds. Filtered with the same `entryDayKey`/`offsetMinutes` pair
 * `dayHasEntries` already uses, so the two agree on exactly where a day
 * begins and ends.
 */
import type { Entry, EntryStore } from "@meologue/core";
import { entryDayKey } from "@/lib/entry-day";
import { type InlineNode, parseInlineMarkdown } from "@/lib/inline-markdown";

/**
 * Whether `nodes` contains a `[[dayKey]]` date Reference anywhere, including
 * nested inside `**bold**`/`_italic_` text. `parseInlineMarkdown` nests a
 * Reference inside its enclosing emphasis/strong node rather than
 * flattening every mark to the top level, so a shallow `.some` over `nodes`
 * alone would miss `**[[2026-08-28]]**`.
 */
function referencesDay(nodes: readonly InlineNode[], dayKey: string): boolean {
  return nodes.some((node) => {
    if (node.kind === "dateReference") {
      return node.date === dayKey;
    }
    if (node.kind === "emphasis" || node.kind === "strong") {
      return referencesDay(node.children, dayKey);
    }
    return false;
  });
}

/**
 * The later Entries that Refer to `dayKey`, newest first (the order
 * `EntryStore.search` already returns candidates in, and this only ever
 * removes candidates from that order — never reorders it).
 */
export async function dayReferrers(
  store: Pick<EntryStore, "search">,
  dayKey: string,
  offsetMinutes: number,
): Promise<Entry[]> {
  const candidates = await store.search(dayKey);
  return candidates.filter((candidate) => {
    // Self-Reference: captured on the very day it Refers to.
    if (entryDayKey(candidate.createdAt, offsetMinutes) === dayKey) {
      return false;
    }
    return referencesDay(parseInlineMarkdown(candidate.body), dayKey);
  });
}
