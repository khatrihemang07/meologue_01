/**
 * Issue #153's splice: flips one task item's marker — `[ ]` to `[x]`, or
 * `[x]`/`[X]` back to `[ ]` — at the exact offsets `parseEntryMarkdown`
 * (inline-markdown.ts) reports for it, and touches nothing else in `body`.
 *
 * `markerFrom`/`markerTo` come from `EntryTaskMarker`, whose own comment
 * already promises they bound exactly the three characters of a
 * `TaskMarker` node (`taskMarkerOf`, inline-markdown.ts) — so this never
 * has to re-discover where the marker is, only rewrite it.
 *
 * This is deliberately a plain string splice, not a re-parse-and-
 * re-serialize round trip through `parseEntryMarkdown`/the Composer's
 * document model. ADR 0043 ("A checkbox is clickable, and ticking it
 * splices the stored string") is explicit about why: reading History must
 * never be able to reformat an Entry the reader never asked to edit, and
 * the only way to guarantee that is for the one function that can touch a
 * body's marker characters to be unable to touch anything else — no
 * React, no DOM, no parser in the loop, so it is trivially true that every
 * byte outside `[markerFrom, markerTo)` survives unchanged.
 */
export function toggleTaskAt(body: string, markerFrom: number, markerTo: number): string {
  const marker = body.slice(markerFrom, markerTo);
  // The middle character is the only one that ever varies — `[`/`]` are
  // fixed by the grammar that produced this marker in the first place.
  const checked = marker[1] === "x" || marker[1] === "X";
  const next = checked ? "[ ]" : "[x]";
  return body.slice(0, markerFrom) + next + body.slice(markerTo);
}
