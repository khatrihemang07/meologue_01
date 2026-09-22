import type { Task } from "@meologue/core";
import { today, upcoming } from "@meologue/core";

/**
 * Issue #437's own "N tasks" line, the count under Today's/Upcoming's
 * title in the in-column heading (shell.tsx's `subtitle`) and its mini
 * echo in the scroll top bar. Both counts follow the identical rule —
 * "what today-view.tsx/upcoming-view.tsx itself renders as rows,"
 * matching what Todoist counts for Today (issue #437's own measured
 * behaviour) — computed here, once, rather than in todo-page.tsx or
 * either view component, so there is exactly one place either count's own
 * rule lives.
 *
 * `today`/`upcoming` are the identical pure functions today-view.tsx and
 * upcoming-view.tsx already call for their own rows — this re-derives
 * rather than accepting the result as an argument, the same "cheap enough
 * that memoising across call sites costs more to reason about than it
 * saves" call today-view.tsx's own header comment already makes for its
 * own `today()` call.
 *
 * Not actually guaranteed to agree with the rows on screen at every
 * instant, though, and that's accepted rather than overlooked: `now` is
 * `localDayKey(new Date())`, read independently by todo-page.tsx (for
 * this count) and by today-view.tsx/upcoming-view.tsx (for their own
 * rows) — two separate calls, at two separate render moments, each un-
 * memoised so they survive a midnight rollover rather than reading stale
 * forever. A render that happens to straddle local midnight between those
 * two calls can disagree by exactly one Task at the boundary — the
 * identical hazard shell.tsx's own `HistoryDayJumpState.todayKey` doc
 * comment already accepts for the same reason ("nothing drives it from a
 * clock... can sit stale past midnight"), not a new risk this file
 * introduces.
 */
export function todayTaskCount(tasks: Task[], now: string): number {
  const { overdue, dueToday } = today(tasks, now);
  return overdue.length + dueToday.length;
}

/**
 * Upcoming's own count was never measured against Todoist — unlike
 * Today's (issue #437's own measured "N tasks" behaviour), nothing in the
 * ticket pins what Upcoming's line should read, or even that Todoist
 * shows one there at all. Our own decision, stated here rather than left
 * implicit: extend `todayTaskCount`'s "count what the view shows" rule to
 * Upcoming's wider window — every Task upcoming-view.tsx itself renders
 * as a row, its own Overdue section (`today()`'s `overdue`, identical to
 * Today's) plus every dated day section `upcoming()` returns (today
 * onward) — rather than inventing a second, unrelated rule for it.
 */
export function upcomingTaskCount(tasks: Task[], now: string): number {
  const { overdue } = today(tasks, now);
  const days = upcoming(tasks, now);
  const dayTaskCount = days.reduce((sum, day) => sum + day.tasks.length, 0);
  return overdue.length + dayTaskCount;
}
