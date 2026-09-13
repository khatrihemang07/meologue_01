import type { Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import { Check } from "lucide-react";
import { inlineProse } from "@/components/inline-prose";
import { formatTaskDate } from "@/lib/format-task-date";
import { priorityColour } from "@/lib/task-priority-colors";

export interface CompletedTaskRowProps {
  task: Task;
  /** How many levels deep this row nests — matches `TaskRowContent`'s own `depth` prop (task-row-content.tsx), so a completed sub-task indents exactly as far as the active sibling it sits beside. */
  depth: number;
  onUncomplete: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
}

/**
 * ROW-14 (parity-ledger.md), the user's 2026-09-13 decision to match
 * Todoist: a completed Task renders **inline, in its own position**, in
 * the same list as active Tasks — not segregated into a collapsed
 * "Completed" disclosure the way this file's own previous export
 * (`CompletedTasks`) rendered it. `task-tree.tsx` interleaves one of
 * these per completed sibling, sorted by `orderKey` alongside the active
 * `TaskTreeRow`s it renders beside (that file's own header comment on the
 * merge).
 *
 * This is a **new, small component, not `TaskRow`/`TaskRowContent` handed
 * a completed Task** — those two files are outside this ticket's scope
 * (owned by a concurrent keymap ticket) and, as measured, aren't ready for
 * one regardless: `TaskRowContent`'s own checkbox already derives
 * `isCompleted` from `task.completedAt` and renders the correct
 * `aria-checked`/`aria-label` (`git show c0d16a4`), but its `onClick`
 * always calls the `onComplete` prop, never branching to an "uncomplete"
 * one — reported verbatim in this ticket's own report rather than worked
 * around by reaching into that file. `task-tree.tsx` sidesteps that one
 * gap by binding `onComplete` to `onUncompleteTask` directly at the call
 * site (no row-level branch needed there), but `TaskRowContent`'s title
 * never gains `completed-task-text` (issue #237's own shared class) no
 * matter what it's handed — that half genuinely has no door from outside
 * the file, and stays a reported gap.
 *
 * The checkbox here matches `TaskRowContent`'s own element/role/name exactly
 * (ROW-03's own `<button role="checkbox" aria-checked aria-label>`) and
 * reuses its identical priority-ring colour/width rule
 * (`priorityColour`/`uiPriorityOf`) — the same 18×18 ring, just filled with
 * a check mark once ticked. That fill is this component's own addition (a
 * checked-but-visually-identical-to-unchecked control would be confusing to
 * use), not something the parity artifacts pinned pixel-for-pixel: ROW-14's
 * own capture confirms `aria-checked="true"` and a `--completed` class on
 * Todoist's own row, not what its ring paints once ticked.
 *
 * Clicking the title opens the Task's own detail view exactly like an
 * active row's title does (`detailActions.onOpenDetail`, task-tree.tsx) —
 * `task-detail-view.tsx` already renders a completed Task correctly (its
 * own `onUncomplete`/`completed-task-text` uses, both pre-existing), so
 * there is nothing for this row to special-case there.
 *
 * `data-task-id` (not just an id in the key) is what keeps a completed row
 * a legitimate destination for `todo-keymap.ts`'s `focusedTaskId()`
 * (`closest("[data-task-id]")`) and for keyboard actions that resolve a
 * Task by whichever row currently holds focus. `data-completed-task` is
 * the second marker task-tree.tsx's own `measureRows` reads to EXCLUDE
 * this row from drag/keyboard-reorder geometry — a completed row sits
 * inline, but is not itself a thing this ticket makes draggable or
 * nestable; that stays exactly the gesture-free "no affordance for a
 * gesture that can't happen here" rule `TaskRowProps.onHandlePointerDown`'s
 * own doc comment already states for the identical case (Today's rows,
 * which never gained a drag handle either).
 */
export function CompletedTaskRow({
  task,
  depth,
  onUncomplete,
  onOpenDetail,
}: CompletedTaskRowProps) {
  // DATE-02/ROW-15 (parity-ledger.md): `formatTaskDate({ completed: true })`
  // is the same call `task-row-content.tsx` and `task-detail-view.tsx`
  // already make for an active Task's own date — resolved once here, not
  // re-derived, for the identical "one place decides the tone" reasoning
  // that function's own header comment gives.
  const dateDisplay = task.date === null ? null : formatTaskDate(task.date, { completed: true });
  const ring = uiPriorityOf(task.priority) === 4 ? "1px" : "2px";
  const colour = priorityColour(uiPriorityOf(task.priority));

  return (
    <li
      data-task-id={task.id}
      data-completed-task="true"
      className="flex items-center gap-2 border-border border-b px-3 py-2 last:border-b-0"
      style={{ paddingLeft: `${12 + (depth - 1) * 20}px` }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: deliberately NOT a native `<input type="checkbox">` — the identical `task-row-content.tsx`'s own reasoning for its own checkbox applies here verbatim: this is Todoist's own exact element (`<button class="task_checkbox" role="checkbox">`), and the 24×24 hit box has to be the button's own border-box with the 18×18 ring on a separate inner span, which a native checkbox's own fixed widget can't do. */}
      <button
        type="button"
        role="checkbox"
        aria-checked="true"
        aria-label="Mark task as incomplete"
        onClick={() => onUncomplete(task)}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center"
      >
        <span
          aria-hidden="true"
          style={{ boxShadow: `0 0 0 ${ring} ${colour}`, color: colour }}
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full"
        >
          <Check aria-hidden="true" className="size-3" strokeWidth={3} />
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpenDetail(task)}
        // KBD-03/04 (parity ledger): the identical row-to-row cycle marker
        // `task-row-content.tsx`'s own title button carries — this row's
        // title is a real, focusable button (not the plain `<span>` this
        // file's previous `CompletedTasks` export used), so it joins the
        // cycle here directly rather than needing a stand-in control the
        // way that Restore button did.
        data-row-nav-target
        className="completed-task-text min-w-0 flex-1 truncate text-left text-sm hover:underline"
      >
        {inlineProse(task.content)}
      </button>
      {dateDisplay !== null && (
        <span className="shrink-0 text-xs" style={{ color: dateDisplay.colour }}>
          {dateDisplay.text}
        </span>
      )}
    </li>
  );
}
