import type { Task } from "@meologue/core";
import { dayOf, timeOf, withDay, withTime } from "@meologue/core";

/** `useTaskDateState`'s own return shape — see that function's header comment for what each field is for. */
export interface TaskDateState {
  /** `task.date`'s day component (`YYYY-MM-DD`), or `null` when the Task is undated. `TaskSchedulePopover`'s own `dateDay` prop, unchanged. */
  dateDay: string | null;
  /** `task.date`'s time-of-day component (`HH:MM`), or `null` when the Task is all-day. `TaskSchedulePopover`'s own `dateTime` prop, unchanged. */
  dateTime: string | null;
  /**
   * Commits a plain day, or `null` to clear the date (and, with it, any
   * time-of-day — see below). Wired straight to `TaskSchedulePopover`'s
   * own `onPickDay`, which every quick option, calendar click, and typed
   * plain-date match funnels through.
   */
  setScheduleDay: (day: string | null) => void;
  /**
   * Sets or clears the time-of-day on whatever day is already chosen.
   * Wired straight to `TaskSchedulePopover`'s own `onSetTime`, which fires
   * only once `dateDay` isn't `null` (that popover's own "Add a time"
   * toggle and time input are both gated on it) — the `dateDay === null`
   * guard below is this hook's own defensive no-op for a caller that fires
   * it anyway, matching what both call sites did before this hook existed.
   */
  setScheduleTime: (time: string | null) => void;
}

/**
 * Issue #256: the day/time split and combine that `task-row-content.tsx`'s
 * hover Date button and `task-detail-view.tsx`'s Date attribute row each
 * anchored their own `TaskSchedulePopover` instance around (issue #253) —
 * byte-identical in both files down to the comments admitting the
 * mirroring, because #253 landed the wiring straight after it had been
 * measured in a real browser (all four entry points, trigger and popover
 * rects) and extracting a shared hook at that ticket's last step would
 * have rewritten the code under those measurements. This hook is that
 * deliberately deferred extraction (#256), with no change to what either
 * call site does — #256 itself is why anchoring gets re-verified in a
 * real browser again after this move, the same four entry points #253
 * already measured once.
 *
 * Two edges this hook deliberately preserves rather than redesigns
 * (#256's own "read what the current code does, and preserve it"):
 *
 * - `setScheduleTime` when `dateDay` is `null` is a no-op. It was already
 *   unreachable through `TaskSchedulePopover` (its time controls render
 *   only once a day is chosen), and both former call sites guarded it the
 *   same way regardless — kept here as the same defensive no-op, not
 *   promoted into a real state (e.g. by inventing a day) that neither site
 *   ever needed.
 * - `setScheduleTime(null)` — "Add a time" unchecked, or the time input
 *   cleared — keeps `dateDay` and drops only the time, the same as
 *   `setScheduleDay(null)` dropping both. Clearing the *date* clears the
 *   time as a consequence of there being nothing left to attach it to;
 *   clearing only the *time* was never asked to also clear the day.
 *
 * Both former call sites agreed on every edge above — nothing here papers
 * over a divergence between the row and the detail view.
 *
 * Issue #435's own code review: the day/time split-and-combine below —
 * `setScheduleDay` moving the day while keeping the Task's own time,
 * `setScheduleTime` combining a new time with the Task's own day — used to
 * be re-typed here directly (`hasTime`/`.slice`). `OverdueRescheduleAction`
 * needed the identical arithmetic a second time, per overdue Task, for its
 * own bulk day/Time pick; rather than that file hand-copying it again (the
 * exact drift #256 already existed to prevent), both now call
 * `dayOf`/`timeOf`/`withDay`/`withTime` (`@meologue/core`'s task-fields.ts,
 * that module's own doc comments have the arithmetic).
 */
export function useTaskDateState(
  task: Task,
  onSetDate: (id: string, date: string | null) => void,
): TaskDateState {
  const dateDay = dayOf(task.date);
  const dateTime = timeOf(task.date);

  function setScheduleDay(day: string | null) {
    if (day === null) {
      onSetDate(task.id, null);
      return;
    }
    onSetDate(task.id, withDay(task.date, day));
  }

  function setScheduleTime(time: string | null) {
    const next = withTime(task.date, time);
    if (next === null) {
      return;
    }
    onSetDate(task.id, next);
  }

  return { dateDay, dateTime, setScheduleDay, setScheduleTime };
}
