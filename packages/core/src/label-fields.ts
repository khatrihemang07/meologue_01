import { DEFAULT_LABEL_COLOUR, isValidLabelColour } from "./label-colors";
import type { Label } from "./label-types";
import type { Task } from "./task-types";

/**
 * Validation for Label's own fields — the Label-shaped sibling of
 * task-fields.ts, called from every LabelStore implementation's setter
 * rather than re-derived by each, for the identical reason
 * task-fields.ts's own header comment gives: a rule checked in only one
 * implementation is a rule the shared contract suite
 * (test-support/label-store-contract.ts) would never catch the other
 * implementation getting wrong.
 */

/** Throws on an empty or whitespace-only name — a Label with no name isn't a lesser Label, it's not a Label. */
export function assertValidLabelName(name: string): void {
  if (name.trim() === "") {
    throw new Error("label name must not be empty");
  }
}

/** Throws unless `colour` is one of label-colors.ts's twenty current palette values. */
export function assertValidLabelColour(colour: string): void {
  if (!isValidLabelColour(colour)) {
    throw new Error(
      `colour must be one of LABEL_COLOURS' current palette, got ${JSON.stringify(colour)}`,
    );
  }
}

/**
 * Fills in `colour` where an incoming Label omits it, mirroring
 * task-fields.ts's withDefaultSchedulingFields: `colour` is required on
 * `Label` (not `?`-optional — every local caller states it explicitly,
 * the same rule ../task-types.ts's own comment argues for Task's
 * scheduling fields), so this exists only as the safety net for a Label
 * arriving over Sync from a Device on an older build whose JSON has no
 * such key, once a sync stream for Labels exists at all.
 */
export function withDefaultLabelColour(l: Label): Label {
  return { ...l, colour: l.colour ?? DEFAULT_LABEL_COLOUR };
}

/**
 * A Task carries its Labels as `labelIds` — see ../task-types.ts's own
 * doc comment on that field for the representation this project chose
 * (a JSON-serialised array on the Task's own row) and, at length, the two
 * it rejected. This is `labelIds`'s equivalent of task-fields.ts's
 * withDefaultSchedulingFields: `labelIds` is required, never
 * `?`-optional, so this is purely the safety net for a Task literal or a
 * Sync payload that predates this field.
 */
export function withDefaultLabelIds(t: Task): Task {
  return { ...t, labelIds: t.labelIds ?? [] };
}
