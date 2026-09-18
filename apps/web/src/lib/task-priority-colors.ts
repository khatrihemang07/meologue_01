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

export function priorityPickerColour(uiPriority: number): string {
  return PICKER_SWATCH_COLOURS[uiPriority] ?? PICKER_SWATCH_NEUTRAL;
}
