import type { Label, Project, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import {
  CalendarClock,
  CheckCheck,
  GripVertical,
  MessageSquare,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useState } from "react";
import { TaskCommandMenu } from "@/components/todo/task-command-menu";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { priorityColour } from "@/lib/task-priority-colors";
import { cn } from "@/lib/utils";

/**
 * Every door onto the Task detail view and its own command set (issue
 * #178) that a row needs but doesn't own a setter for directly — bundled
 * into one object, threaded unbound through TaskList/TaskTree/TodayView/
 * ProjectView exactly as `reorderTask`/`setTaskParent` already are
 * (task-tree.tsx's own header comment), rather than five more individual
 * props widening every intermediate component's own signature. `task` is
 * already in scope wherever a `TaskRow` renders, so this row binds each
 * function to its own Task itself instead of asking a caller several
 * layers up to do it per-row the way TaskTreeRow binds `onComplete`/etc.
 * — there is no equivalent binding step needed here.
 */
export interface TaskDetailActions {
  projects: Project[];
  labels: Label[];
  /** Opens the Task's own route/modal/sheet (issue #178) — the destination Edit, clicking the row's own words, and the Comment hover action (no comment thread exists yet — this file's own doc comment on why) all share. */
  onOpenDetail: (task: Task) => void;
  onSetPriority: (id: string, priority: number) => void;
  onSetProject: (id: string, projectId: string | null) => void;
  onSetLabels: (id: string, labelIds: string[]) => void;
  onCopyLink: (task: Task) => void;
}

export interface TaskRowProps {
  task: Task;
  /** See `TaskDetailActions`'s own doc comment. */
  detailActions: TaskDetailActions;
  /**
   * Completes this Task — for a recurring one (`task.dateString !== null`),
   * the caller's own job is to call `advanceRecurringTask` here instead of
   * `completeTask` (TaskStore.advanceRecurring's own doc comment: the
   * checkbox never "un-ticks itself," and the Task never enters the
   * completed list), not this component's — this row has no TaskStore
   * access of its own and never branches on `dateString` to decide which
   * mutation a plain tap means. It only ever decides between calling THIS
   * and calling `onCompleteForever` below, based on the gesture.
   */
  onComplete: () => void;
  /**
   * Ends a recurring Task's series (TaskStore.completeForever's own doc
   * comment — "Complete and archive recurring task", the domain decision
   * this whole programme has to get right: not "complete this
   * occurrence"). Reached two ways, both wired here rather than left to a
   * caller to remember: Shift+Click on the checkbox (Todoist's own
   * documented gesture for this exact action) on a pointer device, and a
   * dedicated button — visible only on a recurring Task, and only this
   * button gets the touch-reachable treatment `entry-actions.tsx`'s own
   * hover/focus split already gives Schedule/Delete below, since a
   * touch reader has no Shift key to hold at all.
   */
  onCompleteForever: () => void;
  onRequestDelete: () => void;
  /**
   * Opens the schedule picker (issue #169's `TaskScheduleSheet`) for this
   * Task — every one of Date/Deadline/Duration/Priority is reachable from
   * here, in both Inbox and Today, since both render this same row. See
   * this ticket's own brief: "pickers, not text parsing," and this is the
   * one door onto them a reader always has, regardless of which view
   * they're looking at a Task from.
   */
  onOpenSchedule: () => void;
  /** Whether this row is the drop target of an in-progress drag — draws the "the dragged row lands here" line. Meaningless, and always `false`, on a row with no drag handlers (see below). */
  isDropTarget?: boolean;
  /**
   * Whether this row is the *nesting* target of an in-progress drag —
   * issue #171's drag-to-reparent. Deliberately a second boolean rather
   * than folding this into `isDropTarget` as a third state that string
   * could carry: `isDropTarget`'s own top-border line means "the dragged
   * row lands between this one and its neighbour," and `isNestTarget`
   * means something else entirely — "the dragged row becomes this one's
   * child" — so this row draws a **different** indicator for it (a filled
   * highlight around the whole row, not a line above it) rather than
   * reusing the border and leaving a reader to guess mid-drag which of
   * two outcomes a release would produce. task-tree.tsx's own `overTarget`
   * state never sets both together for the same row (its own `kind` tag
   * is exactly one of `"before"`/`"nest"`/`"end"`), so this and
   * `isDropTarget` are never simultaneously `true` here either, but each
   * is still checked independently rather than one implying the other's
   * falsity, so a future caller wiring only one of the two doesn't
   * silently inherit an assumption about the other.
   */
  isNestTarget?: boolean;
  /**
   * How many levels deep this row nests — 1 for a top-level Task, up to
   * `MAX_TASK_NESTING_DEPTH` (4, @meologue/core) for a sub-task nested to
   * the cap (issue #171). Indentation is the only thing this changes: a
   * fixed amount of left padding per level, so a reader can tell a
   * sub-task from its parent by eye without this row needing to know
   * anything about the tree above it. Defaults to 1 — every pre-#171
   * caller (Today, and Inbox before Sections/sub-tasks existed) renders
   * exclusively top-level Tasks and never passes this.
   */
  depth?: number;
  /**
   * All seven (the four pointer handlers below, plus the three keyboard
   * ones) omitted together, never some subset, is what removes the grip
   * handle entirely rather than rendering an inert one — the identical
   * "no affordance for a gesture that can't happen here" rule issue
   * #168's own header comment on this option already states, extended by
   * issue #171 to the keyboard path #168 didn't yet have. Today
   * (`today-view.tsx`) passes none of the seven — its order is computed
   * (task-views.ts), not chosen by dragging or by the keyboard either.
   * Inbox and a Project's own view (`todo-page.tsx`, `task-tree.tsx`)
   * pass all seven.
   */
  onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerMove?: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerUp?: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void;
  /**
   * Reorders this Task one slot earlier/later among its own siblings
   * (issue #171's keyboard acceptance criterion) — lib/task-reorder.ts's
   * own `siblingMoveDropIndex`/`reorderedTaskOrderKey` do the actual
   * arithmetic; this row only ever calls back with "up" or "down." `null`
   * when there is no sibling on that side to swap with — this row shows
   * that state by simply not moving, the same "not every gesture always
   * does something" contract `onHandlePointerUp`'s own "unchanged" case
   * already established for a drag that returns to its own slot.
   */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /**
   * Reparents this Task under its own preceding sibling (indent) or back
   * up to its grandparent's level (outdent) — issue #171's keyboard
   * reparent acceptance criterion. `Alt`+`ArrowRight`/`Alt`+`ArrowLeft`,
   * not `Tab`/`Shift`+`Tab`: this codebase's outliner-style controls
   * (this grip button is the first one) still sit inside an ordinary page
   * a keyboard reader tabs through, and claiming `Tab` here — the
   * convention Notion/Workflowy use for exactly this gesture — would trap
   * that reader's focus on this one button instead of moving on to
   * Schedule/Delete the way `Tab` does everywhere else in this app. The
   * `Alt`-modified arrow keys cost nothing a browser or a screen reader
   * already uses on a plain `<button>`.
   */
  onIndent?: () => void;
  onOutdent?: () => void;
  /**
   * Every Section in this Task's own Project, offered as a quick "move to
   * Section" control — `undefined`/empty hides the control entirely
   * (Inbox has no Sections to offer; a Project with none yet has nothing
   * to move into). This is the one door onto TaskStore.setSection that
   * doesn't depend on drag-to-reparent's own pointer geometry, so a
   * reader can file a Task into a Section even where dragging across a
   * Section boundary isn't implemented (this ticket's own report names
   * that gap).
   */
  sectionOptions?: { id: string; name: string }[];
  onMoveToSection?: (sectionId: string | null) => void;
}

/**
 * One active Task, in Inbox or in Today (issue #169 — both views render
 * this same row rather than each growing its own) — a checkbox
 * (completing, ADR 0047's own "completing is not a delete" distinction
 * from an Entry's), the Task's `content`, a compact schedule summary when
 * it has one, a drag handle, a Schedule button opening `TaskScheduleSheet`
 * (issue #169's pickers), and a Delete button behind the shared
 * `ConfirmDialog` (`todo-page.tsx` owns the one dialog instance, the same
 * "one instance for however many rows" rule `sessions-page.tsx`'s own
 * `SessionRow` follows).
 *
 * The checkbox mirrors `entry-prose.tsx`'s task-item styling
 * (`accent-current`, an `aria-label` carrying the Task's own words rather
 * than a generic "Checked"/"Unchecked") — the same control, reached from a
 * second Destination now that a Task has one of its own (ADR 0047's Todo
 * row and an Entry's checkbox are the same kind of thing since ADR 0048,
 * so they read the same on screen too.
 *
 * The grip handle carries the pointer listeners, not this `<li>` — issue
 * #168 shipped this row with the browser's native HTML5 drag-and-drop
 * (`draggable` on the `<li>`), which does nothing on Android: WebView never
 * synthesises `dragstart` from touch input, so the grip handle sat on every
 * row as an affordance for a gesture that could not happen there. Pointer
 * Events replace it, following the same recogniser shape
 * `use-swipe-actions.ts` already uses for an Entry row's swipe — one
 * mechanism across mouse, touch and pen, rather than native DnD for a
 * mouse and a second, bespoke path for a finger. Scoping the listeners to
 * the handle rather than the whole row is deliberate, not incidental: a
 * pointerdown anywhere else on the row has to keep scrolling the list on
 * touch, which is the entire reason a grip handle exists as a separate
 * element instead of making the row itself draggable. The *keyboard* gap
 * this left (issue #168's own footnote naming it as #171's criterion, not
 * that ticket's) is what turned the handle from an `aria-hidden` `<span>`
 * into the focusable `<button>` below: arrow keys reorder, `Alt`+arrow
 * keys reparent — see `onMoveUp`/`onIndent`'s own doc comments
 * (TaskRowProps) for why those specific keys.
 */
export function TaskRow({
  task,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  isDropTarget = false,
  isNestTarget = false,
  depth = 1,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandlePointerCancel,
  onMoveUp,
  onMoveDown,
  onIndent,
  onOutdent,
  sectionOptions,
  onMoveToSection,
}: TaskRowProps) {
  // The full command set's own open state (issue #178) — right-click
  // anywhere on the row, the `.` key while any of the row's own controls
  // has focus, or clicking the "More actions" button below all just flip
  // this one flag, and TaskCommandMenu (its own header comment) renders
  // the identical menu regardless of which of the three opened it.
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const isRecurring = task.dateString !== null;
  // A recurring Task always shows a schedule summary line, even one with
  // no `date` of its own yet (../recurrence/'s engine failing to resolve
  // an initial occurrence — quick-add-task.ts's own defensive fallback —
  // is the one case that could leave `date: null` here) — the reader
  // still typed a recurrence rule, and hiding the one line that would
  // show it back to them (`dateString !== null` below) reads as "nothing
  // was understood" when something was.
  const hasSchedule =
    task.date !== null || task.deadline !== null || task.priority !== 1 || isRecurring;
  const draggable =
    onHandlePointerDown !== undefined &&
    onHandlePointerMove !== undefined &&
    onHandlePointerUp !== undefined &&
    onHandlePointerCancel !== undefined &&
    onMoveUp !== undefined &&
    onMoveDown !== undefined &&
    onIndent !== undefined &&
    onOutdent !== undefined;
  return (
    <li
      data-task-id={task.id}
      className={cn(
        "group flex items-center gap-2 rounded-lg border-t-2 border-t-transparent py-2.5 pr-3 transition-colors hover:bg-muted",
        // A top border rather than a background swap for the drop
        // indicator: it reads as "the row lands between here and the row
        // above" without implying the hovered row itself is what's moving.
        isDropTarget && "border-t-primary",
        // The nest indicator (issue #171's drag-to-reparent) is a filled
        // ring around the *whole* row instead — never a top border, which
        // `isDropTarget` above already claims for a different outcome
        // ("lands between rows"). Filling the row itself, rather than a
        // second line drawn somewhere else on it, is what reads as "the
        // dragged row goes inside this one" instead of "next to it,"
        // without inventing a third line position (below the row? around
        // just the content?) a reader would have to learn separately from
        // the first. `ring-inset` keeps the ring inside the row's own
        // border-box rather than growing the row's footprint and shifting
        // every row below it during a drag, which a `border`-width ring
        // would do.
        isNestTarget && "bg-primary/10 ring-2 ring-primary ring-inset",
      )}
      // A fixed amount of left padding per level, on the `<li>` itself
      // rather than a wrapper `<div>` — depth's own doc comment above.
      // `12px` base padding (matching the row's own `pr-3`) plus `20px`
      // per level beyond the first, so a depth-1 (top-level) Task keeps
      // exactly the padding every pre-#171 row already had.
      style={{ paddingLeft: `${12 + (depth - 1) * 20}px` }}
      // The full command set, reached from anywhere on the row — issue
      // #178's own reference behaviour ("the full command set lives
      // behind right-click and the `.` key, not on the row"). `.` is read
      // here, on the row itself, rather than on any one control inside
      // it: a keydown on the checkbox, the content, or an action button
      // all bubble up to this handler, so the reader doesn't have to
      // land focus on one specific element first. Ignored while a
      // modifier is held, or while the event's own target is the Section
      // `<select>` below — a reader typing to jump that combobox to an
      // option starting with "." (vanishingly unlikely, but this guard
      // costs nothing) must not also pop this menu open underneath it.
      onContextMenu={(event) => {
        event.preventDefault();
        setCommandMenuOpen(true);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLLIElement>) => {
        if (
          event.key === "." &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          (event.target as HTMLElement).tagName !== "SELECT"
        ) {
          event.preventDefault();
          setCommandMenuOpen(true);
        }
      }}
    >
      {draggable && (
        <button
          type="button"
          aria-label={`Reorder or reparent "${task.content}" — arrow keys to move, Alt+arrow keys to indent or outdent`}
          data-testid="task-drag-handle"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerCancel}
          onKeyDown={(event) => {
            // A real, focusable `<button>` rather than the `aria-hidden`,
            // unfocusable `<span>` this handle used to be (issue #168's
            // own version) — issue #171's keyboard reorder/reparent
            // acceptance criterion needs a keyboard target to land focus
            // on, and this is the one control already scoped to exactly
            // this Task's own drag gesture, so it does double duty rather
            // than this row growing a second, keyboard-only control for
            // the identical action. `onOutdent`'s own doc comment
            // (TaskRowProps) explains why `Alt`+arrow rather than `Tab`.
            if (event.key === "ArrowUp" && !event.altKey) {
              event.preventDefault();
              onMoveUp?.();
            } else if (event.key === "ArrowDown" && !event.altKey) {
              event.preventDefault();
              onMoveDown?.();
            } else if (event.key === "ArrowRight" && event.altKey) {
              event.preventDefault();
              onIndent?.();
            } else if (event.key === "ArrowLeft" && event.altKey) {
              event.preventDefault();
              onOutdent?.();
            }
          }}
          // `touch-action: none` is what makes a touch drag possible at all
          // — without it Chromium's own scroll gesture recogniser claims
          // the gesture before a second pointermove ever reaches this
          // handler, exactly as `pane-divider.tsx`'s own comment on its
          // handle explains. Scoped to the handle rather than the row (or
          // the list) is what keeps the rest of Inbox scrollable with a
          // finger — the opposite of `use-swipe-actions.ts`'s bubble,
          // which stays `pan-y` everywhere so the thread itself keeps
          // scrolling under a swipe.
          className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      )}
      {/*
        `onClick`, not `onChange` — pre-#170 this was `onChange={onComplete}`.
        `MouseEvent`'s own `shiftKey` is what Shift+Click on a recurring
        Task's checkbox (`onCompleteForever`'s own doc comment) needs to
        read, and only a `click` handler carries it directly rather than
        through a `change` event's own, less direct relationship to
        whichever click caused it. `checked={false}` never actually changes
        (a completed Task, recurring or not, leaves this list rather than
        rendering ticked — TaskStore.advanceRecurring's own doc comment:
        "the checkbox does not un-tick itself"), so `readOnly` rather than a
        real `onChange` is the honest description of what this control is:
        a button shaped like a checkbox, not a real toggle.
      */}
      {/*
        A checkbox that carries its own Priority (issue #178's own
        acceptance criterion) — a ring, not a fill: `accent-current` below
        already claims the checkbox's own tick/fill colour for the reader's
        theme accent, so Priority gets the one visual slot that doesn't
        collide with it. `padding`+`border-radius` on this wrapping `<span>`
        rather than a `box-shadow`/`outline` on the `<input>` directly: a
        native checkbox's own rendering (`accent-current`) ignores most box-
        model properties applied straight to it across browsers, where a
        wrapper's border is unconditionally respected everywhere. Priority
        1 ("no priority," task-types.ts's own doc comment: a real level,
        not an absence) still gets a ring — `priorityColour`'s own neutral
        grey for it — rather than no ring at all, so every row's checkbox
        reads consistently rather than only a prioritised one carrying a
        border a reader has to learn means something.
      */}
      <span
        className="shrink-0 rounded-full p-0.5"
        // A plain inline `boxShadow` ring rather than Tailwind's own
        // `ring-*` utilities: those resolve through a `--tw-ring-color`
        // custom property this app's design tokens don't otherwise touch,
        // and reaching for it here would make this one ring's colour
        // depend on Tailwind's internal implementation rather than on
        // `priorityColour` alone.
        style={{ boxShadow: `0 0 0 1px ${priorityColour(uiPriorityOf(task.priority))}` }}
      >
        <input
          type="checkbox"
          checked={false}
          readOnly
          onClick={(event: MouseEvent<HTMLInputElement>) => {
            // Shift+Click on a recurring Task's checkbox is Todoist's own
            // documented "Complete and archive recurring task" — ends the
            // series, not "complete this occurrence" (this file's own
            // `onCompleteForever` doc comment). Meaningless on a
            // non-recurring Task, so the modifier is simply ignored there
            // and an ordinary complete happens instead — no extra gesture
            // a reader could stumble into by accident.
            if (isRecurring && event.shiftKey) {
              onCompleteForever();
            } else {
              onComplete();
            }
          }}
          aria-label={task.content}
          className="block shrink-0 accent-current"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {/*
          The row's own words, clickable (issue #178: "Clicking a Task
          should open it in a view of its own") — a real `<button>`, not a
          `<span onClick>`, so this is reachable by keyboard and announced
          as interactive rather than as plain text. `text-left` overrides
          `<button>`'s own default centering; the rest of the classes
          reproduce the plain `<span>` this replaces exactly, so nothing
          about the row's layout shifts.
        */}
        <button
          type="button"
          onClick={() => detailActions.onOpenDetail(task)}
          className="truncate text-left text-sm hover:underline"
        >
          {task.content}
        </button>
        {/* A compact schedule summary, present only once there's something
            to summarise (issue #169, extended by #170's recurrence line) —
            Date, then Deadline, then Priority (never "no priority", the
            same restraint the sort chain itself applies: a level that
            means "nothing chosen" doesn't deserve a badge), then the
            recurrence rule exactly as typed. `formatTaskDate`/`formatDay`
            (lib/format-task-date.ts) are the same functions
            `TaskScheduleSheet` reads a Task's current value through, so
            this row can never show a date in words that disagree with
            what the picker itself would say. `dateString` is rendered
            verbatim, never re-derived through ../recurrence/'s engine —
            "the string is the truth" (task-types.ts's own doc comment on
            `Task.dateString`) means the reader sees exactly what they
            typed here too, not this row's own paraphrase of it. */}
        {hasSchedule && (
          <span className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
            {task.date !== null && <span>{formatTaskDate(task.date)}</span>}
            {task.deadline !== null && <span>Due {formatDay(task.deadline)}</span>}
            {task.priority !== 1 && <span>P{uiPriorityOf(task.priority)}</span>}
            {task.dateString !== null && <span>{task.dateString}</span>}
          </span>
        )}
      </span>
      {/*
        Both this Schedule button and the Delete button below follow the
        same visibility rule, revealed on hover or focus on a pointer
        device, always present on a touch one — the same split
        `entry-actions.tsx` already makes for an Entry row's Edit/Delete.
        Todo has no `EntryActionsSheet`-equivalent sheet a touch reader
        could reach either through instead, so base state is visible and
        `(hover: hover)` is what *takes each away* at rest — the inverse of
        the Entry row's rule, arriving at the same result on both device
        classes.

        `opacity`, not `display`, on the hover-capable path, for
        `entry-actions.tsx`'s own reason: each button stays in the layout
        and in the tab order, so `focus-visible` can bring it back for a
        keyboard user who never hovers anything.
      */}
      {/*
        Touch-reachable "Complete and archive recurring task" (this file's
        own `onCompleteForever` doc comment) — Shift+Click has no
        equivalent on a touch device at all, so a Task with no pointer
        (mouse/trackpad) attached would otherwise have no way to reach
        this action short of completing every future occurrence one at a
        time. Rendered only for a recurring Task (`isRecurring`); every
        other row keeps exactly the two buttons it had before this ticket.
      */}
      {isRecurring && (
        <button
          type="button"
          aria-label={`Complete and archive recurring task "${task.content}"`}
          onClick={onCompleteForever}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
            "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
          )}
        >
          <CheckCheck aria-hidden="true" className="size-4" />
        </button>
      )}
      {/*
        Moves this Task between the Sections of its own Project — issue
        #171. A plain `<select>`, not a drag target: the pointer recogniser
        (task-tree.tsx) only ever computes an insert-before/insert-after
        position within one sibling group, and reaching across a Section
        boundary that way is a gap this ticket's own report names rather
        than solves (task-drag-recognizer.ts has no "onto a different
        group" verdict at all). A `<select>` is a real, keyboard- and
        screen-reader-reachable way to move a Task into or out of a
        Section regardless of that gap. `sectionOptions` undefined/empty
        hides it entirely, the identical "the affordance isn't there
        rather than present and inert" rule `draggable` above follows.
      */}
      {sectionOptions !== undefined && sectionOptions.length > 0 && (
        <select
          aria-label={`Move "${task.content}" to a Section`}
          value={task.sectionId ?? ""}
          onChange={(event) =>
            onMoveToSection?.(event.target.value === "" ? null : event.target.value)
          }
          className="shrink-0 rounded-md border border-border bg-background px-1 py-1 text-muted-foreground text-xs"
        >
          <option value="">No Section</option>
          {sectionOptions.map((section) => (
            <option key={section.id} value={section.id}>
              {section.name}
            </option>
          ))}
        </select>
      )}
      {/*
        The four hover actions, in the fixed order issue #178's own
        reference behaviour observed live: Edit, Date, Comment, More —
        replacing the old Schedule/Delete pair. Edit opens the identical
        detail view the row's own words already open (this file's own
        `detailActions.onOpenDetail` doc comment); Comment does too, for
        now — there is no comment thread to scroll to yet (issue #180's
        own scope), so "open the Task's own view" is the honest, non-dead
        destination for that icon until #180 gives it something more
        specific to land in. Delete moved off the row entirely, into the
        command menu below (⌘⌫) — this ticket's own acceptance criterion
        is "reachable from a menu, not only from the hover actions," which
        for Delete specifically now means *only* from the menu, matching
        the reference layout exactly.
      */}
      <button
        type="button"
        aria-label={`Edit "${task.content}"`}
        onClick={() => detailActions.onOpenDetail(task)}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
        )}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label={`Date "${task.content}"`}
        onClick={onOpenSchedule}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
        )}
      >
        <CalendarClock aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label={`Comment on "${task.content}"`}
        onClick={() => detailActions.onOpenDetail(task)}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
        )}
      >
        <MessageSquare aria-hidden="true" className="size-4" />
      </button>
      <TaskCommandMenu
        task={task}
        projects={detailActions.projects}
        labels={detailActions.labels}
        open={commandMenuOpen}
        onOpenChange={setCommandMenuOpen}
        trigger={
          <button
            type="button"
            aria-label={`More actions for "${task.content}"`}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
              "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 aria-expanded:opacity-100",
            )}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        }
        onOpenDetail={() => detailActions.onOpenDetail(task)}
        onOpenSchedule={onOpenSchedule}
        onSetPriority={(priority) => detailActions.onSetPriority(task.id, priority)}
        onSetProject={(projectId) => detailActions.onSetProject(task.id, projectId)}
        onSetLabels={(labelIds) => detailActions.onSetLabels(task.id, labelIds)}
        onCopyLink={() => detailActions.onCopyLink(task)}
        onRequestDelete={onRequestDelete}
      />
    </li>
  );
}
