/**
 * A Task's Date, Priority and Project, read live off the Task itself
 * (issue #181's own criterion 1/2) — the exact three fields the
 * Composer's add field already understands and, before this ticket,
 * silently dropped once a checkbox line became a Reference:
 * `@meologue/core`'s quick-add grammar (`packages/core/src/quick-add/`)
 * resolves a date/time token and a priority token, and Todo's own
 * `QuickAddTaskFields` (`lib/quick-add-task.ts`) carries no Deadline
 * field at all — Deadline is a Todo-only concept a reader sets from
 * `TaskScheduleSheet`, never something typed into an Entry. That is why
 * this component omits Deadline and the recurrence-rule line
 * `task-row.tsx`'s own schedule badge also shows: those were never part
 * of what a checkbox in an Entry promised to carry back.
 *
 * Extracted rather than duplicated: `task-row.tsx`'s inline schedule
 * badge already renders Date and Priority this same way (Date, then
 * Priority, "no priority" — level 1 — getting no badge, the identical
 * restraint the sort chain itself applies), and `task-search-page.tsx`'s
 * own `projectNameFor` already resolves a Project's name for a
 * cross-Project row. Both this component's own callers —
 * `entry-row.tsx`'s `TaskReferenceItem` and `history.tsx`'s
 * `DayTasksRow` — are cross-Project surfaces the way Today already is
 * (a checkbox in an Entry, or a day's block, can reference a Task filed
 * anywhere), so both need the Project name Today's own row still omits.
 * `task-row.tsx` itself is untouched: every one of its own callers is
 * already scoped to a single Project (Inbox, a Project's own view) or is
 * Today, whose choice to omit Project predates this ticket and isn't
 * this ticket's to revisit.
 *
 * Renders nothing for a field the Task doesn't carry — no Date, "no
 * priority," no Project (Inbox) — and renders nothing at all once every
 * field is absent, rather than an empty wrapper `gap-x-2` would still
 * pad.
 *
 * **`hideDate` — a completed occurrence's own asymmetry (issue #181, the
 * coordinator's own live-verification report against criterion 9).** Date
 * and Priority/Project are not actually the same kind of fact once a row
 * is a recurring Task's completed *occurrence*, and this component read
 * them as if they were until this fix. Priority and Project are
 * attributes of the Task's current series — there is no "which
 * occurrence" for either of them to be pinned to, so the live value is
 * simply correct (this file's own header comment, above, before this
 * fix). Date is different: `advanceRecurring` moves it forward to the
 * NEXT occurrence the instant this one completes, so by the time a
 * completed occurrence is shown anywhere, `task.date` answers "when is
 * this series next due," never "when was THIS occurrence." A day's block
 * (`history.tsx`'s `DayTasksRow`) makes that concretely wrong to show:
 * ticking "water the plants" (dated 2026-09-04, `every day`) from Sep
 * 4's own block advances `date` to 2026-09-05, and a chip reading "Sep 5"
 * on a row sitting inside Sep 4's own block directly contradicts the
 * block it's in — a reader reasonably concludes the block is showing
 * tomorrow's work. This is the identical asymmetry `entry-row.tsx`'s
 * `TaskReferenceItem` already resolves for the *checked* bit (a
 * recurring Task's live `completedAt` can never be one occurrence's own
 * truth either) — `hideDate` is that same treatment, extended to the one
 * other field with the identical problem. Both of this component's
 * callers pass `hideDate={true}` for exactly a completed recurring
 * occurrence, never for an ordinary completed Task (whose own `date`
 * never moves once it's done, so it stays correct and stays shown).
 *
 * Suppressed rather than replaced with the occurrence's own day: the row
 * already sits inside that day's own block or that day's own Entry, so a
 * reader already knows which day this is — a redundant "Sep 4" chip
 * would say nothing a second chip's worth of space would be worth
 * spending on, the identical "don't restate what's already known"
 * restraint `priority === 1` getting no badge already follows.
 */
import type { Project, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import { formatTaskDate } from "@/lib/format-task-date";
import { projectNameFor } from "@/lib/project-name";

export function TaskScheduleChips({
  task,
  projects,
  hideDate = false,
}: {
  task: Task;
  projects: readonly Project[];
  /** See this module's own doc comment on why a completed recurring occurrence is the one case that must pass `true` here. */
  hideDate?: boolean;
}) {
  const showDate = !hideDate && task.date !== null;
  if (!showDate && task.priority === 1 && task.projectId === null) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
      {showDate && task.date !== null && <span>{formatTaskDate(task.date)}</span>}
      {task.priority !== 1 && <span>P{uiPriorityOf(task.priority)}</span>}
      {task.projectId !== null && (
        <span className="truncate">{projectNameFor(projects, task.projectId)}</span>
      )}
    </span>
  );
}
