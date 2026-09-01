import type { Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";

/**
 * The one grouping dimension Today's grouping control offers (issue #169's
 * own brief: "minimal but real" — Priority is the dimension the ticket's
 * own warning story is about, a Todoist regression where enabling a
 * grouping silently reordered a view by priority alone. Building the
 * control around exactly that dimension is what makes the regression test
 * below test something real rather than a grouping nobody would notice
 * broke). `"none"` is the default — Today opens ungrouped, in
 * task-views.ts's own chain order, the same as it always has.
 */
export type TodayGrouping = "none" | "priority";

export interface TaskGroup {
  /** Empty for the single "none" bucket, which renders with no heading. */
  label: string;
  tasks: Task[];
}

/**
 * Partitions an already-sorted list of Tasks into display groups — a
 * partition, never a re-sort (task-views.ts's own compareForToday is the
 * one place order is decided; grouping only decides which bucket each
 * Task lands in, exactly the distinction that module's own header comment
 * draws for why `compareForToday` is exported on its own). `"none"`
 * returns the whole list as a single, unlabeled group, in the order it
 * arrived. `"priority"` partitions by UI priority (`uiPriorityOf`), P1
 * first through P4 last, each bucket built with `Array.prototype.filter` —
 * which preserves the source order of every element it keeps — so a
 * bucket holding two same-priority Tasks stays in whatever order the
 * caller's own chain already put them in, never re-sorted by this
 * function. That is the literal mechanism behind "grouping does not
 * collapse the order to priority": there is no comparator anywhere in
 * this function for a later edit to "simplify" into one that sorts by
 * priority instead, because there was never a sort here to begin with.
 */
export function groupTodayTasks(tasks: Task[], grouping: TodayGrouping): TaskGroup[] {
  if (grouping === "none") {
    return tasks.length === 0 ? [] : [{ label: "", tasks }];
  }
  const groups: TaskGroup[] = [];
  for (const uiPriority of [1, 2, 3, 4]) {
    const bucket = tasks.filter((task) => uiPriorityOf(task.priority) === uiPriority);
    if (bucket.length > 0) {
      groups.push({ label: `Priority ${uiPriority}`, tasks: bucket });
    }
  }
  return groups;
}
