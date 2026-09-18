/**
 * Priority's own colour, by UI level (p1-p4) — issue #178's row checkbox
 * ring, the priority picker menu and the Task detail view's Priority
 * attribute all need a mapping, so it lives here once rather than each
 * render site choosing its own. Every function here takes a UI priority
 * (1-4), never a stored one — the same `uiPriorityOf`/`storedPriorityOf`
 * boundary task-types.ts's own doc comment warns every call site to cross
 * through rather than open-coding `5 - x`; this module's callers are what
 * already did that conversion before reaching in here.
 *
 * Issue #223 replaced this file's original four literal `rgb()` strings
 * with the tokens `index.css` defines (issue #351 folded those into the
 * app's own plain `:root`/`.dark`, global and unconditional) — see that
 * block's own comment for the full evidence trail. Two DIFFERENT
 * mappings live here, not one, because the evidence itself is two
 * surfaces, not one:
 *
 * - `priorityColour` answers for the row/checkbox ring (`task-row.tsx`)
 *   and the detail view's Priority attribute (`task-detail-view.tsx`) —
 *   both read as "what colour is THIS Task's priority," the same question
 *   the checkbox ring has always answered.
 * - `priorityPickerColour` answers for the priority PICKER itself
 *   (`task-command-menu.tsx`'s Priority submenu and its trigger preview) —
 *   "what colour is the swatch for LEVEL N," independent of any Task.
 *
 * **PRI-05 (parity-ledger.md) is why these are not the same function
 * wearing two names.** P1's row ring (`rgb(255,112,102)`,
 * `--td-priority-row-1`) and P1's picker swatch (`rgb(209,69,59)`,
 * `--td-priority-picker-1`) were independently measured in a live
 * Todoist and are genuinely different values — not a rounding difference,
 * not an oversight to reconcile. Collapsing them into one shared constant
 * would silently "fix" a real, deliberate Todoist design choice the first
 * time someone noticed the two reds didn't match; keeping two named
 * functions is what makes that mistake need a conscious edit to make.
 * P2/P3's row rendering is now measured too (PRI-06, unblocked with
 * disposable P2/P3 fixtures): row rgb(255,154,19)/rgb(82,151,255) against
 * picker rgb(235,137,9)/rgb(36,111,224) — a second and third instance of
 * the identical row-vs-picker split P1 already established, not a
 * coincidence limited to red. `--td-priority-row-2`/`-3` hold those row
 * values directly now, no longer a fallback onto the picker's own swatch;
 * P4 ("no priority") reads identically on both
 * functions because Todoist's own picker and its row both render a
 * priority-less Task as the same neutral grey, `--td-checkbox-ring-
 * default`, distinct from the picker's own darker P4 swatch.
 */
/*
 * The two neutrals are named rather than looked up as `[4]` so both functions
 * below are total in the type system as well as in fact: this project compiles
 * with `noUncheckedIndexedAccess`, under which indexing a `Record<number, …>`
 * yields `string | undefined`, and a `??` whose right-hand side is itself
 * another index of the same record stays `string | undefined` however
 * obviously the key exists to a reader.
 */
const ROW_RING_NEUTRAL = "var(--td-checkbox-ring-default)";
const PICKER_SWATCH_NEUTRAL = "var(--td-priority-picker-4)";

const ROW_RING_COLOURS: Record<number, string> = {
  1: "var(--td-priority-row-1)",
  2: "var(--td-priority-row-2)",
  3: "var(--td-priority-row-3)",
  4: ROW_RING_NEUTRAL,
};

const PICKER_SWATCH_COLOURS: Record<number, string> = {
  1: "var(--td-priority-picker-1)",
  2: "var(--td-priority-picker-2)",
  3: "var(--td-priority-picker-3)",
  4: PICKER_SWATCH_NEUTRAL,
};

/** The row/checkbox ring's own colour for UI priority `p1`-`p4` (1-4) — see this module's own header comment for the row-vs-picker split and where each token came from. Falls back to the neutral "no priority" ring for anything outside 1-4, which should never happen against a real Task (task-types.ts's own `priority` is always 1-4) but keeps this function total rather than partial. */
export function priorityColour(uiPriority: number): string {
  return ROW_RING_COLOURS[uiPriority] ?? ROW_RING_NEUTRAL;
}

/** The priority PICKER's own swatch colour for level `p1`-`p4` (1-4) — this module's header comment explains why this is a second function rather than `priorityColour` reused: PRI-05 measured the picker's own reds, oranges, blues and greys as genuinely different from the row ring's. Falls back the same way `priorityColour` does. */
export function priorityPickerColour(uiPriority: number): string {
  return PICKER_SWATCH_COLOURS[uiPriority] ?? PICKER_SWATCH_NEUTRAL;
}
