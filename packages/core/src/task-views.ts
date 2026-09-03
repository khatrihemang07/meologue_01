import type { Task } from "./task-types";

/**
 * Today (issue #169): the one platform-free, unit-tested place the union
 * rule and the sort chain both live, so a React component never has to get
 * either right on its own — "the web layer renders what core decides."
 * A pure function over TaskStore.list()'s result, not a TaskStore method
 * of its own: computing Today needs no query SQLite can answer faster than
 * an in-memory filter/sort over a personal task list's worth of active
 * Tasks, and a pure function is trivially unit-testable with plain Task
 * fixtures — no driver, no SqliteTaskStore vs InMemoryTaskStore duplicate
 * implementation to keep in sync, the trap TaskStore.list()'s own ordering
 * guarantee exists to avoid by living in one place (order-key.ts's
 * compareByOrder).
 *
 * **The union.** Today is not "Tasks due today" — it's the union of three
 * independent conditions, CONTEXT.md's Date and Deadline entries read
 * together: a Task whose `date` falls on today's calendar day, a Task
 * whose `date` is in the past (overdue), and a Task whose `deadline` is
 * today or in the past — the last case explicitly *including* a Task with
 * no `date` at all, which is the entire point of a Deadline existing
 * independently of a Date (an undated Task waiting in Inbox still surfaces
 * once its hard cutoff arrives, "so it doesn't slip through the cracks").
 * A Task with neither `date` nor `deadline` satisfies none of the three
 * and is correctly invisible here.
 *
 * One case this union resolves in a way worth naming: a Task whose `date`
 * is in the future but whose `deadline` has already passed (an unusual
 * combination — planning to do something *after* its hard cutoff — but
 * not one this store refuses) is placed in `overdue`, not held back for
 * its future `date`. A passed hard cutoff is what "overdue" means,
 * independent of what was separately planned.
 *
 * **The sort chain.** `date-and-time (or deadline, where there is no
 * date) -> priority -> deadline -> manual (dayOrder) -> created`, applied
 * by compareForToday below to every Task this module places in a section.
 * The manual step reads `dayOrder`, Today's own fractional index (issue
 * #182), not `orderKey` — `orderKey` is a Task's position inside its
 * Project or Section, and letting Today's tie-break read it would mean a
 * drag in Today silently reordering a Task inside its Project too, the
 * exact bug ADR 0050's second index exists to rule out. See task-store.ts's
 * `reorderToday` and mapping.ts's `fromWireTaskOutput` for the rest of
 * that split.
 * Priority is a *tie-break inside a shared date-and-time*, not a global
 * rank — swapping the first two steps is the specific regression
 * Todoist itself shipped and then fixed twice in 2026, which is why
 * task-views.test.ts asserts it with a test named for exactly that
 * mistake rather than leaving it implied by a passing sort.
 *
 * **All-day vs timed, same day.** An all-day Task (`date` is `YYYY-MM-DD`)
 * sorts before every timed Task (`date` is `YYYY-MM-DDTHH:MM`) on the same
 * calendar day — the same convention a day view in a calendar app uses,
 * showing all-day items above the hour grid, because a Task with no
 * committed time reads as "sometime today" rather than as competing for a
 * position among specific hours. This isn't a special case in
 * compareForToday's code: `date` and `deadline` are both ISO-ordered
 * strings, and an all-day string is always a strict prefix of any timed
 * string sharing its day (`"2026-09-02" < "2026-09-02T09:00"` under plain
 * `<`, because a shorter string that's a prefix of a longer one sorts
 * first) — the rule falls out of comparing the two fields' own encodings
 * lexicographically rather than needing a branch to detect "no time".
 *
 * **Overdue is its own section, always chronological.** `overdue` and
 * `dueToday` are returned separately, both sorted by the same
 * compareForToday chain — there's no second, "manual" comparator anywhere
 * in this module, so there's nothing that could reorder `overdue` by
 * `dayOrder` first even under a future "manual sort" display mode: the
 * chain's first step is always the date-and-time key, for every Task in
 * every section. task-views.test.ts proves this isn't merely true by
 * construction: it gives a set of overdue Tasks `dayOrder`s that would
 * reorder them if sorted by manual order alone, and asserts `overdue`
 * still comes back in due-date order regardless.
 */
export interface TodayView {
  /**
   * Overdue Tasks: `date` before today, or `deadline` before today
   * (including a Task with no `date`). Sorted by compareForToday, always —
   * see this module's own doc comment for why "always" is a guarantee, not
   * an accident of the current caller.
   */
  overdue: Task[];
  /**
   * Due today: `date` on today's calendar day, or `deadline` on today's
   * calendar day (including a Task with no `date`), excluding anything
   * already placed in `overdue`. Sorted by compareForToday.
   */
  dueToday: Task[];
}

/**
 * Builds Today from a TaskStore.list() result. `now` is a floating
 * date-or-datetime string in the same encoding as Task.date (see its own
 * doc comment for why no `Z`, no offset) — only its first ten characters
 * (the calendar day) are read, so a caller can pass either a bare
 * `YYYY-MM-DD` or a full local timestamp and get the identical result:
 * Today's boundary is day-granular, not time-of-day-granular, which is
 * also why a Task whose `date` was earlier *today* is `dueToday`, not
 * `overdue` — it hasn't crossed into a different calendar day yet, only
 * past its own time.
 */
export function today(tasks: Task[], now: string): TodayView {
  const todayDate = now.slice(0, 10);
  const overdue: Task[] = [];
  const dueToday: Task[] = [];

  for (const t of tasks) {
    const { date, deadline } = t;
    const dateDay = date === null ? null : date.slice(0, 10);
    const dateIsOverdue = dateDay !== null && dateDay < todayDate;
    const deadlineIsOverdue = deadline !== null && deadline < todayDate;
    if (dateIsOverdue || deadlineIsOverdue) {
      overdue.push(t);
      continue;
    }
    const dateIsToday = dateDay !== null && dateDay === todayDate;
    const deadlineIsToday = deadline !== null && deadline === todayDate;
    if (dateIsToday || deadlineIsToday) {
      dueToday.push(t);
    }
    // Neither condition: a future date/deadline, or neither field set at
    // all — absent from every day-keyed view, which for an undated,
    // deadline-less Task is the entire point (it stays in Inbox until the
    // user gives it one).
  }

  overdue.sort(compareForToday);
  dueToday.sort(compareForToday);
  return { overdue, dueToday };
}

/**
 * The full sort chain, exported on its own (not just used internally by
 * today()) because the web layer's grouping control needs the identical
 * comparator to sort *within* a group — grouping is a partition of an
 * already-ordered list, never a second, independently-invented ordering,
 * which is what "grouping does not collapse the order to priority" means
 * in practice: a caller that groups by re-sorting each bucket with its own
 * ad hoc comparator (say, priority first because that's the field it's
 * grouping by) reintroduces the exact bug this chain exists to prevent.
 * Group by filtering/partitioning a list already sorted with this
 * function, and every group inherits the chain for free.
 */
export function compareForToday(a: Task, b: Task): number {
  const aKey = effectiveDateKey(a);
  const bKey = effectiveDateKey(b);
  if (aKey !== bKey) {
    // null only reaches here for a Task neither today() places in a
    // section would carry (see today()'s own filtering) — treated as
    // sorting last so a caller applying this comparator to a wider list
    // than today() produces still gets a defined, stable order rather
    // than undefined behaviour.
    if (aKey === null) {
      return 1;
    }
    if (bKey === null) {
      return -1;
    }
    return aKey < bKey ? -1 : 1;
  }

  // Priority: a tie-break inside the same date-and-time, never a global
  // rank (this module's own doc comment). Stored priority 4 is the most
  // urgent (UI p1), so the more urgent Task sorts first when this step is
  // reached at all — which only happens once step one has already tied.
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }

  const deadlineOrder = compareNullableAscending(a.deadline, b.deadline);
  if (deadlineOrder !== 0) {
    return deadlineOrder;
  }

  // Manual: dayOrder alone (Today's own fractional index, issue #182 —
  // this module's own doc comment explains why not orderKey), not
  // order-key.ts's compareByOrder — that helper folds in an id tie-break,
  // which would make the "created" step below unreachable and collapse
  // two steps of this chain into one.
  if (a.dayOrder !== b.dayOrder) {
    return a.dayOrder < b.dayOrder ? -1 : 1;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }

  // Every step above tied — vanishingly unlikely (it needs an exact
  // dayOrder collision on top of everything else matching), but Array.sort
  // isn't guaranteed stable on every engine this runs on, so this is the
  // one tie-break that has to exist to keep the result deterministic
  // rather than merely usually-deterministic.
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

// A Task's primary sort key: its `date` if it has one, its `deadline`
// otherwise — "date-and-time (or deadline, where there is no date)". Both
// fields are ISO-ordered strings that compare correctly with plain `<`,
// which is also what gives the all-day-before-timed rule (this module's
// own doc comment) for free.
function effectiveDateKey(t: Task): string | null {
  return t.date ?? t.deadline;
}

// A Task with no deadline sorts after one that has one: an explicit hard
// cutoff is more urgent information than its absence, so it wins this
// tie-break step. This only fires once date-and-time and priority have
// already tied, which for two Tasks sharing a `deadline`-derived primary
// key (both undated, same deadline) means this step ties too — the chain
// falls through to manual order next either way.
function compareNullableAscending(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a < b ? -1 : 1;
}

/**
 * The day block's own filter (issue #174): every Task whose `date` or
 * `deadline` falls on exactly `dayKey`'s calendar day — the same union
 * today() applies to "today," narrowed from "today, or before it" down to
 * "this one day, and only this one day," which is what lets History open
 * each day with the Tasks that belong to it. `dayKey` is a bare
 * `YYYY-MM-DD`, matching entry-day.ts's own day keys (the caller —
 * history.tsx — computes one per day separator the identical way it
 * already does for Entries), and only `t.date`'s own first ten characters
 * are compared, for the identical "day-granular, not time-of-day-granular"
 * reason today() reads `now.slice(0, 10)` rather than a full timestamp.
 *
 * **A rendering, not a record — the property ADR 0053 exists to protect.**
 * This is a plain filter over whatever `tasks` a caller already has in
 * memory (history.tsx reads `EntryStoreOutletContext.tasks`, the exact
 * array Today and Inbox already render from): nothing here reads a store,
 * writes one, or remembers which day a Task last matched. A Task re-dated
 * from 31 Aug to 1 Sept simply stops satisfying `tasksForDay(tasks,
 * "2026-08-31")` and starts satisfying `tasksForDay(tasks, "2026-09-01")`
 * the next time either is called — there is no membership row to update,
 * because none was ever written. ADR 0053 names the rejected alternative
 * this avoids: storing the day block as rows would be a second copy of
 * exactly what a Task's own `date`/`deadline` already says, and
 * immediately stale the moment either changes.
 *
 * **Completed Tasks are the caller's concern, not this function's.**
 * `tasks` is expected to already be an *active* list (TaskStore.list()'s
 * own guarantee, the same expectation today() carries) — a completed Task
 * filed alongside its still-open siblings would otherwise keep surfacing
 * in a day's block forever, the identical reasoning that keeps a
 * completed Task out of Inbox in the first place.
 *
 * Sorted with the same compareForToday chain today() uses for its own
 * sections, so a reader who already learned "date-and-time, then
 * priority" from Today or Inbox sees the identical order here rather than
 * a second one this module would have to justify on its own.
 */
export function tasksForDay(tasks: Task[], dayKey: string): Task[] {
  const matches = tasks.filter((t) => {
    const dateDay = t.date === null ? null : t.date.slice(0, 10);
    return dateDay === dayKey || t.deadline === dayKey;
  });
  matches.sort(compareForToday);
  return matches;
}
