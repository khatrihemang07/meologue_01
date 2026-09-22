import type { Task } from "@meologue/core";
import { today, upcoming } from "@meologue/core";

/**
 * Issue #437's own "N tasks" line, the count under Today's/Upcoming's
 * title in the in-column heading (shell.tsx's `subtitle`) and its mini
 * echo in the scroll top bar. Both counts follow the identical rule —
 * "what today-view.tsx/upcoming-view.tsx itself renders as rows,"
 * matching what Todoist counts for Today (issue #437's own measured
 * behaviour) — computed here, once, rather than in todo-page.tsx or
 * either view component, so the three call sites (the subtitle, the mini
 * title, and each view's own render) can never quietly drift apart.
 *
 * `today`/`upcoming` are the identical pure functions today-view.tsx and
 * upcoming-view.tsx already call for their own rows — this re-derives
 * rather than accepting the result as an argument, the same "cheap enough
 * that memoising across call sites costs more to reason about than it
 * saves" call today-view.tsx's own header comment already makes for its
 * own `today()` call.
 */
export function todayTaskCount(tasks: Task[], now: string): number {
  const { overdue, dueToday } = today(tasks, now);
  return overdue.length + dueToday.length;
}

/**
 * Todoist's own Upcoming has no "N tasks" line to measure against (issue
 * #437's own body: "Todoist's Upcoming has no 'N tasks' line in the same
 * way"). Chosen definition, since one has to be picked: every Task
 * upcoming-view.tsx itself renders as a row — its own Overdue section
 * (`today()`'s `overdue`, identical to Today's) plus every dated day
 * section `upcoming()` returns (today onward) — extending
 * `todayTaskCount`'s own "count what the view shows" rule to Upcoming's
 * wider window rather than inventing a second, unrelated rule for it.
 */
export function upcomingTaskCount(tasks: Task[], now: string): number {
  const { overdue } = today(tasks, now);
  const days = upcoming(tasks, now);
  const dayTaskCount = days.reduce((sum, day) => sum + day.tasks.length, 0);
  return overdue.length + dayTaskCount;
}
