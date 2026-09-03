import type { Task } from "./task-types";

/**
 * Validation — and defaulting — for Task's own fields: the date-shaped
 * ones (issue #169: `date`/`deadline`/`priority`) and, since
 * issue #171, the structural ones (`projectId`/`sectionId`/`parentId`,
 * plus the nesting-depth rule that spans rows). The one place these
 * cross-field and cross-row rules live, called from every TaskStore
 * implementation's setter rather than re-derived by each. A rule checked
 * in only one implementation (say, SqliteTaskStore but not
 * InMemoryTaskStore) is a rule a test running against the *other*
 * implementation would never catch breaking — exactly what
 * task-store-contract.ts's shared suite exists to prevent, and what having
 * one function both implementations call, instead of two hand-written
 * copies of the same `if`, guarantees rather than merely encourages.
 */

const DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// All-day (`YYYY-MM-DD`) or timed (`YYYY-MM-DDTHH:MM`) only — no seconds,
// no `Z`, no `+HH:MM` offset. This is the guard that turns Task.date's
// floating-not-UTC rule (its own doc comment explains why) from a
// convention callers are trusted to follow into one this module refuses to
// let slip past: a `Date.toISOString()` value handed to setDate by
// mistake has a `Z` on it and is rejected here rather than silently stored
// as a "floating" time that was actually a UTC instant.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

/**
 * True when `date` carries a time-of-day component (`YYYY-MM-DDTHH:MM`),
 * false for an all-day `YYYY-MM-DD` date or `null`. Exported because
 * task-views.ts needs this exact distinction too, both to decide whether a
 * Task's sort key includes a time and to order all-day Tasks against timed
 * ones on the same day — a second, separately-written `includes("T")`
 * check there would be one more place the two could quietly drift apart.
 */
export function hasTime(date: string | null | undefined): boolean {
  return date?.includes("T") ?? false;
}

/**
 * Throws unless `date` is `null`, all-day (`YYYY-MM-DD`) or floating-timed
 * (`YYYY-MM-DDTHH:MM`) — see DATE_PATTERN's own comment for why this
 * exists at all: it's the one place a `Z`-suffixed or offset instant
 * (a real UTC timestamp handed to the wrong field) is caught rather than
 * silently stored as if it were floating.
 */
export function assertValidDate(date: string | null): void {
  if (date !== null && !DATE_PATTERN.test(date)) {
    throw new Error(
      `date must be "YYYY-MM-DD" or floating "YYYY-MM-DDTHH:MM", got ${JSON.stringify(date)}`,
    );
  }
}

/**
 * Throws unless `deadline` is `null` or exactly `YYYY-MM-DD`. A Deadline is
 * date-only by definition (CONTEXT.md's Deadline entry) — a timed string
 * here isn't a different shape this function coerces or stores anyway,
 * it's a caller error refused outright, the same way a negative array
 * index is refused rather than silently clamped.
 */
export function assertValidDeadline(deadline: string | null): void {
  if (deadline !== null && !DEADLINE_PATTERN.test(deadline)) {
    throw new Error(`deadline must be date-only ("YYYY-MM-DD"), got ${JSON.stringify(deadline)}`);
  }
}

/**
 * Throws unless `priority` is one of the four stored levels (1-4). Task's
 * own doc comment on `priority` says why the field isn't nullable — "no
 * priority" is level 1, not an absence — and this is what keeps that true
 * in practice: without it, setPriority would happily persist a 0 or a 99
 * that uiPriorityOf's `5 - x` inversion, and every sort in task-views.ts
 * that groups or tie-breaks on priority, would then silently mishandle.
 */
export function assertValidPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    throw new Error(`priority must be an integer between 1 and 4, got ${priority}`);
  }
}

/**
 * Fills in Task's three #169 fields where an incoming object omits them —
 * `date`/`deadline` to `null`, `priority` to 1.
 *
 * All three are **required** on `Task` (../task-types.ts explains why: the
 * same rule ../types.ts states for `Entry.deletedAt`, so every caller says
 * explicitly rather than letting an omission default silently). So this is
 * not a licence for local callers to stay vague — the type already refuses
 * that, and `use-tasks.ts`'s `addTask` states "undated" outright. It is a
 * safety net for the one path the type system cannot reach: a Task
 * arriving over Sync from a Device on an older build, whose JSON simply
 * has no such key. Every TaskStore.upsert() calls this before writing, so
 * every *reader* — list(), get(), search(), and task-views.ts's
 * today()/compareForToday() — can treat the three fields as genuinely
 * present rather than each re-deriving the same defaulting.
 */
export function withDefaultSchedulingFields(t: Task): Task {
  return {
    ...t,
    date: t.date ?? null,
    deadline: t.deadline ?? null,
    priority: t.priority ?? 1,
  };
}

/**
 * Fills in `dateString` where an incoming Task omits it — issue #170's
 * recurrence engine (../recurrence/). A separate function from
 * withDefaultSchedulingFields above, on purpose, mirroring
 * ../label-fields.ts's withDefaultLabelIds rather than being folded into
 * the #169 defaulter: `dateString` doesn't share a ticket, a module, or a
 * reason to default with `date`/`deadline`/`priority` — it
 * defaults to `null` for "doesn't repeat," not for a scheduling rule, and
 * the two `?`-optional fields on Task (this one and `labelIds`) each got
 * `?`-optional for a different reason of their own (see this field's own
 * doc comment in ../task-types.ts), which is reason enough to keep their
 * defaulters apart too rather than implying they're one concern.
 */
export function withDefaultDateString(t: Task): Task {
  return { ...t, dateString: t.dateString ?? null };
}

/**
 * Fills in `projectId`/`sectionId`/`parentId` where an incoming Task omits
 * them (issue #171) — the third such `?`-optional-in-practice defaulter,
 * mirroring withDefaultDateString and ../label-fields.ts's
 * withDefaultLabelIds for the identical reason: all three fields are
 * **required** on `Task` (../task-types.ts explains why), so this is
 * purely the safety net for a Task literal or a Sync payload written
 * before this field existed, never a licence for a local caller to stay
 * vague. `null` for all three means Inbox, no Section, no parent — the
 * same "nothing chosen yet" state a Task created directly in Todo starts
 * in for `date`/`deadline` (withDefaultSchedulingFields above).
 */
export function withDefaultStructureFields(t: Task): Task {
  return {
    ...t,
    projectId: t.projectId ?? null,
    sectionId: t.sectionId ?? null,
    parentId: t.parentId ?? null,
  };
}

/**
 * Fills in `description` where an incoming Task omits it (issue #180) —
 * the fourth such `?`-optional-in-practice defaulter, mirroring
 * withDefaultDateString/withDefaultStructureFields above and
 * ../label-fields.ts's withDefaultLabelIds for the identical reason:
 * `description` is **required** on `Task` (../task-types.ts's own doc
 * comment), so this is purely the safety net for a Task literal or a
 * Sync payload written before this field existed, never a licence for a
 * local caller to stay vague. `null` means "no Description yet," the
 * same state a Task created directly in Todo starts in.
 */
export function withDefaultDescription(t: Task): Task {
  return { ...t, description: t.description ?? null };
}

/**
 * Fills in `dayOrder` where an incoming Task omits it (issue #182) — the
 * fifth such `?`-optional-in-practice defaulter, mirroring
 * withDefaultDescription above for the identical reason: `dayOrder` is
 * **required** on `Task` (../task-types.ts's own doc comment), so this is
 * purely the safety net for a Task literal or a Sync payload written
 * before this field existed. Falls back to the Task's own `orderKey`,
 * not `null` — `dayOrder` isn't nullable, and "wherever its Project order
 * already put it" is the identical bootstrap mapping.ts's
 * fromWireTaskOutput uses for a Task arriving fresh over Sync.
 */
export function withDefaultDayOrder(t: Task): Task {
  return { ...t, dayOrder: t.dayOrder ?? t.orderKey };
}

/**
 * A sub-task nests at most this many levels deep, CONTEXT.md's Sub-task
 * entry and issue #171's acceptance criteria (top-level Task = depth 1,
 * its sub-task = depth 2, and so on). Exported so both TaskStore
 * implementations' setParent() walk against the identical number rather
 * than each hard-coding `4` and risking the two drifting apart — the
 * same "one rule, called from every implementation" reasoning this file's
 * own header comment gives for every other assert function here.
 */
export const MAX_TASK_NESTING_DEPTH = 4;

/**
 * Throws if placing a Task as a child of a Task at `parentDepth` would
 * exceed MAX_TASK_NESTING_DEPTH. `parentDepth` is the *target parent's
 * own* depth (1 for a top-level Task, 2 for its sub-task, and so on) —
 * this function only judges the count once it is known; walking a Task's
 * `parentId` chain to compute it needs an async store lookup per hop, so
 * that walk lives in each TaskStore implementation's own setParent()
 * (the pure rule lives here; the store holds the read that feeds it).
 */
export function assertValidNestingDepth(parentDepth: number): void {
  if (parentDepth >= MAX_TASK_NESTING_DEPTH) {
    throw new Error(
      `sub-tasks may nest at most ${MAX_TASK_NESTING_DEPTH} levels deep (parent is already at depth ${parentDepth})`,
    );
  }
}
