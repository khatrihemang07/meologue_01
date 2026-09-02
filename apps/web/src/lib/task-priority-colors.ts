/**
 * Priority's own colour, by UI level (p1-p4) — issue #178's row checkbox
 * ring and the Task detail view's Priority attribute both need the
 * identical mapping, so it lives here once rather than each render site
 * choosing its own. Takes a UI priority (1-4), never a stored one — the
 * same `uiPriorityOf`/`storedPriorityOf` boundary task-types.ts's own
 * doc comment warns every call site to cross through rather than open-
 * coding `5 - x`; this module's callers are what already did that
 * conversion before reaching in here.
 *
 * P1 and P2 are the two values this ticket verified live, in a real
 * Todoist, dark theme, computed style: `rgb(255,112,102)` and
 * `rgb(255,154,19)`. P4 (and the "no priority" case, which reads
 * identically) is the third verified value, `rgb(169,169,169)` — a
 * neutral grey rather than a fourth colour, matching Todoist's own choice
 * to leave its lowest level unhighlighted. **P3 was not independently
 * verified the same way** — this file reuses `--accent-blue`
 * (index.css), already this app's own blue token, on the well-known
 * convention (Todoist's own P3 is a blue) rather than inventing an
 * unverified fourth literal rgb() to sit beside three that were actually
 * read off a live page.
 */
// P4's own neutral grey doubles as the fallback for an out-of-range input
// (this function's own doc comment) — named once so the fallback and P4's
// real value can never quietly drift apart from each other.
const NEUTRAL_GREY = "rgb(169, 169, 169)";

const PRIORITY_COLOURS: Record<number, string> = {
  1: "rgb(255, 112, 102)",
  2: "rgb(255, 154, 19)",
  3: "var(--accent-blue)",
  4: NEUTRAL_GREY,
};

/** The colour for UI priority `p1`-`p4` (1-4) — see this module's own header comment for where each value came from. Falls back to p4's neutral grey for anything outside 1-4, which should never happen against a real Task (task-types.ts's own `priority` is always 1-4) but keeps this function total rather than partial. */
export function priorityColour(uiPriority: number): string {
  return PRIORITY_COLOURS[uiPriority] ?? NEUTRAL_GREY;
}
