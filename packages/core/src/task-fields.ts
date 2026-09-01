import type { Task } from "./task-types";

/**
 * Validation — and defaulting — for Task's date-shaped fields (issue
 * #169): the one place the cross-field rules on
 * `date`/`deadline`/`duration`/`priority` live, called from every
 * TaskStore implementation's setter rather than re-derived by each. A rule
 * checked in only one implementation (say, SqliteTaskStore but not
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
const MAX_DURATION_MINUTES = 24 * 60;

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
 * Throws unless `duration` is `null`, or a number no greater than 1440
 * minutes (24 hours) paired with a `date` that carries a time. `date` is
 * the Task's *current* date, not a value this function can derive on its
 * own — TaskStore.setDuration reads the Task first and passes its date
 * through, which is also why setDate does not need a mirror-image check
 * here: changing `date` never touches `duration`'s stored value, so an
 * existing duration surviving a date edit that drops the time is a state
 * this function would refuse if re-asserted, not one the store lets a
 * caller reach via setDuration itself.
 *
 * `date`'s parameter type admits `undefined` alongside `null` even though
 * `Task.date` itself is required-and-nullable (../task-types.ts): this is
 * also called with a value read off data arriving over Sync, where a field
 * the type promises can still be absent in practice. `undefined` is
 * treated identically to `null` (see hasTime above) — "absent" and
 * "explicitly none" both mean the Task has no time to hang a duration on
 * — never as "unknown, so skip the check", which would let exactly the
 * malformed input this guard exists for through.
 */
export function assertValidDuration(
  duration: number | null,
  date: string | null | undefined,
): void {
  if (duration === null) {
    return;
  }
  if (!hasTime(date)) {
    throw new Error("duration requires a date that carries a time");
  }
  if (duration > MAX_DURATION_MINUTES) {
    throw new Error(`duration cannot exceed ${MAX_DURATION_MINUTES} minutes (24 hours)`);
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
 * Fills in Task's four #169 fields where an incoming object omits them —
 * `date`/`deadline`/`duration` to `null`, `priority` to 1.
 *
 * All four are **required** on `Task` (../task-types.ts explains why: the
 * same rule ../types.ts states for `Entry.deletedAt`, so every caller says
 * explicitly rather than letting an omission default silently). So this is
 * not a licence for local callers to stay vague — the type already refuses
 * that, and `use-tasks.ts`'s `addTask` states "undated" outright. It is a
 * safety net for the one path the type system cannot reach: a Task
 * arriving over Sync from a Device on an older build, whose JSON simply
 * has no such key. Every TaskStore.upsert() calls this before writing, so
 * every *reader* — list(), get(), search(), and task-views.ts's
 * today()/compareForToday() — can treat the four fields as genuinely
 * present rather than each re-deriving the same defaulting.
 */
export function withDefaultSchedulingFields(t: Task): Task {
  return {
    ...t,
    date: t.date ?? null,
    deadline: t.deadline ?? null,
    duration: t.duration ?? null,
    priority: t.priority ?? 1,
  };
}
