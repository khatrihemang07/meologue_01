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
 *
 * **Retires for a referenced line (issue #173, ADR 0048).** This function
 * itself is unchanged — it still has no notion of a Task reference, and
 * splicing `[ ]`/`[x]` in place is still exactly correct for a *bare*
 * checkbox, one with no `[[task:id|label]]` mark behind it. Retirement
 * happens entirely at the call site instead: `entry-prose.tsx`'s
 * `renderListItem` never invokes the caller's toggle handler for a
 * referenced item, because ticking one has to write the Task (ADR 0048's
 * "ticking writes the Task"), and a splice into the Entry's own body is
 * exactly the second, competing write ADR 0048 exists to rule out. This
 * function must not grow that awareness itself — a bare checkbox still
 * needs the plain splice below to keep working exactly as it does today,
 * and issue #174's backfill (turning an *existing* bare checkbox into a
 * reference) is not assumed to have run by the time this file is read.
 */
export function toggleTaskAt(body: string, markerFrom: number, markerTo: number): string {
  const marker = body.slice(markerFrom, markerTo);
  // The middle character is the only one that ever varies — `[`/`]` are
  // fixed by the grammar that produced this marker in the first place.
  const checked = marker[1] === "x" || marker[1] === "X";
  const next = checked ? "[ ]" : "[x]";
  return body.slice(0, markerFrom) + next + body.slice(markerTo);
}

/**
 * `toggleTaskAt`'s explicit-state sibling (issue #173) — sets a marker to a
 * known `checked` value rather than flipping whatever it currently holds.
 * `toggleTaskAt` itself is right for a reader's own click, which always
 * means "the opposite of what's on screen"; a *referenced* checkbox's
 * cache-refresh fan-out (task-reference-sync.ts) instead already knows the
 * Task's own new completion state and needs to WRITE that, not toggle
 * blindly — the two are never interchangeable, since a blind toggle
 * against a marker that already agrees with the Task (every Entry beyond
 * the one the reader actually clicked, in the rare case a Task is
 * referenced more than once) would flip it the wrong way.
 */
export function setTaskMarkerChecked(
  body: string,
  markerFrom: number,
  markerTo: number,
  checked: boolean,
): string {
  return body.slice(0, markerFrom) + (checked ? "[x]" : "[ ]") + body.slice(markerTo);
}
