import type { Label, Project, Task } from "@meologue/core";
import type { PointerEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { TaskRowContent } from "@/components/todo/task-row-content";
import {
  OPEN_COMMAND_MENU_EVENT,
  OPEN_SCHEDULE_EVENT,
  type OpenCommandMenuDetail,
  type OpenScheduleEventDetail,
} from "@/lib/todo-keymap";

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
  /** Opens the Task's own route/modal/sheet (issue #178) — the destination Edit, clicking the row's own words, and the Comment hover action all share; the Comment thread itself lives inside that view (issue #180), not behind a second destination of its own. */
  onOpenDetail: (task: Task) => void;
  onSetPriority: (id: string, priority: number) => void;
  onSetProject: (id: string, projectId: string | null) => void;
  onSetLabels: (id: string, labelIds: string[]) => void;
  onCopyLink: (task: Task) => void;
  /**
   * Sets or clears the Task's `date` (issue #253) — the row's hover Date
   * button, the More-actions "Date…" item and the `T` shortcut all reach
   * this through the identical per-row `TaskSchedulePopover` instance
   * `task-row-content.tsx` owns (that file's own doc comment). Bundled
   * here, not threaded as a sixth prop through TaskList/TaskTree/
   * TodayView/ProjectView, for the identical reason every other setter in
   * this object already is.
   */
  onSetDate: (id: string, date: string | null) => void;
  /**
   * Sets or clears the Task's Recurrence phrase (issue #253) —
   * `TaskStore.setDateString`'s own doc comment (task-schedule-sheet.tsx)
   * has the reasoning for why `date` is recomputed by the store rather
   * than trusted from a caller.
   */
  onSetDateString: (id: string, dateString: string | null, now: string) => void;
  /**
   * Day-keys carrying at least one active Task, mapped to how many —
   * threaded straight through to `TaskSchedulePopover`'s identical prop
   * (its own doc comment: SCHED-09's calendar dot and SCHED-04's preview
   * subline share this one source).
   */
  datesWithTasks: ReadonlyMap<string, number>;
  /**
   * Renames this Task (issue #225) — reached by clicking the row's own
   * Edit pencil, which swaps the title from the display `<button>` into
   * `TaskTitleEditor` in place (`task-row-content.tsx`'s own doc comment
   * on why this is a *new* affordance, not a Todoist-measured one: the
   * reference docs never drove a row-level rename, only the detail
   * view's). `task-row-content.tsx`'s own `commitTitle` still hands this
   * raw, verbatim text — since issue #247, it no longer reaches
   * `renameTask` directly: whichever page builds this bundle
   * (todo-page.tsx's/composer-page.tsx's own `commitRename`) resolves it
   * through `commitTaskTitle` (task-title-commit.ts) first, the identical
   * door `task-detail-view.tsx`'s own title already reaches through that
   * same wrapper. This is not a second rename path with its own rules,
   * just a second place to reach the one shared one.
   */
  onRename: (id: string, content: string) => void;
  /**
   * A Task's own comment count (issue #180) — `TaskRow`'s own
   * `commentCount` doc comment. Bundled here rather than a sixth prop on
   * every intermediate component for the identical reason every field
   * above it already is: `comment-counts.ts`'s `commentCountForTask`
   * closed over `useEntryStore()`'s `comments`, computed once by
   * whichever page builds this object rather than every row reaching
   * into that list itself.
   */
  commentCountFor: (taskId: string) => number;
}

export interface TaskRowProps {
  task: Task;
  /** See `TaskDetailActions`'s own doc comment. */
  detailActions: TaskDetailActions;
  /**
   * How many live Comments this Task carries (issue #180) — Todoist's
   * own `note_count`, a speech-bubble glyph plus a number next to the
   * date chip, shown only when this is non-zero. Callers read this off
   * `comments` (`useEntryStore()`) through comment-counts.ts's
   * `commentCountForTask` rather than this row reaching into a store of
   * its own — this file has no store access, the same "core/the caller
   * computes, the row only renders" split every other Task attribute
   * here already follows.
   */
  commentCount?: number;
  /**
   * How many direct sub-tasks this Task has (issue #224) — `task-tree.tsx`'s
   * `TaskTreeRow` already fetches this Task's own children to decide
   * whether to render a nested `TaskTree` beneath this row at all
   * (`children`'s own doc comment below), so it hands the count straight
   * through rather than this row running a second, redundant query for a
   * number the caller already has. Defaults to 0, the same "nothing here
   * yet" default `commentCount` above already uses.
   */
  subtaskCount?: number;
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
   * Un-completes this Task (ROW-14, parity-ledger.md) — the door back for
   * a completed Task rendered inline through this same row, forwarded
   * straight to `TaskRowContent`'s identical prop (that file's own doc
   * comment). Optional: Today and Upcoming never hand this row a
   * completed Task, so they never need to pass it.
   */
  onUncomplete?: () => void;
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
   * Task — every one of Date/Deadline/Priority is reachable from
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
  /**
   * A row's own sub-tasks (issue #171), rendered as a nested `TaskTree` by
   * `TaskTreeRow` (task-tree.tsx) — accepted here, not rendered by that
   * caller as a sibling `<ul>` beside this row's own `<li>`, because issue
   * #192 is exactly the difference between those two: a `ul` may contain
   * only `li` (plus `script`/`template`), so a nested Task's own sub-task
   * list has to land *inside* this row's own `<li>` to be valid HTML, and
   * `<li>{children}</li>` below is what does that. `undefined` for a Task
   * with none, the same "the affordance isn't there" default every other
   * optional prop here already uses — `TaskTreeRow` only ever passes a
   * `TaskTree` once `children.length > 0` is already true.
   */
  children?: ReactNode;
  /** Threaded straight through to `TaskRowContent` — see that prop's own doc comment (task-row-content.tsx). Defaults to `false` there when omitted. */
  suppressDateBadge?: boolean;
}

/**
 * One Task's own row, active or completed, in Inbox, a Project's own
 * view, or Today (issue #169 — every one of those renders this same row
 * rather than each growing its own; ROW-14, parity-ledger.md, extended
 * that to a completed Task too — Todoist's own completed row is "the same
 * row component... distinguished only by an added `--completed` class,"
 * not a second, reduced one). This file owns the `<li>` — identity
 * (`data-task-id`, and `data-completed-task` once `task.completedAt` is
 * set — see that attribute's own comment below), the full command set's
 * own `onContextMenu`/`.`-key handler, and this row's own sub-tasks as
 * `children` — and the drag/keyboard-reorder wiring TaskTree hands it
 * unbound (`onHandlePointerDown` et al., `onMoveUp`/`onIndent` et al.,
 * TaskRowProps' own doc comments on each) — omitted entirely for a
 * completed row, task-tree.tsx's own call site, so it renders with no
 * drag handle at all rather than an inert one (the same "no affordance
 * for a gesture that can't happen here" rule Today's own rows already
 * follow). Everything a reader actually SEES — the checkbox, the title,
 * the metadata line, the hover actions — is issue #224's `TaskRowContent`
 * (task-row-content.tsx), one call below: that split exists because this
 * file had grown to 41KB before it, and nearly all of that weight was the
 * drag/nesting/keyboard machinery described above, not anything about
 * what a row looks like.
 *
 * **The `<li>` itself carries only identity and the full command set's own
 * handlers; `TaskRowContent`'s own root `<div data-task-row-box>` carries
 * every visual concern** — issue #192, and unchanged in shape by #224's
 * later split. Before #192, this `<li>` was both the list item *and* the
 * row: every visual class and the depth padding lived on it directly,
 * which worked only because a Task's own sub-tasks rendered as a second
 * `<ul>` beside this `<li>`, never inside it — invalid HTML (a `ul` may
 * hold only `li`), and a structure that handed assistive technology no
 * relationship between a Task and its sub-tasks at all, only the illusion
 * of one from `paddingLeft` (task-tree.tsx's own header comment carries
 * the fuller account, and this file's own task-row.test.tsx now pins the
 * a11y evidence for the fix). Nesting the sub-task `<ul>` inside this
 * `<li>` fixes the markup, but everything this `<li>` used to render
 * directly would otherwise now describe the *whole subtree* rather than
 * just this row: a hover state would light up every descendant, and
 * `paddingLeft` would indent the nested `<ul>` a second time on top of
 * the depth padding its own rows already carry. `TaskRowContent`'s own
 * div is what keeps every one of those scoped to this row alone —
 * `children` (sub-tasks, if any) lands as its sibling inside the `<li>`,
 * not as its descendant.
 *
 * `onContextMenu`/`onKeyDown` stay on the `<li>`, not on `TaskRowContent`'s
 * div — the one thing about this row #192 did *not* have to move, and
 * #224 didn't either — but they gain a `stopPropagation()` neither needed
 * before: with a sub-task's own `<ul>` now a DOM descendant of this
 * `<li>`, a right-click or a `.` keypress on a *child* row would
 * otherwise bubble up through this row's own `<li>` too and pop a second
 * command menu open on the parent — something that was structurally
 * impossible before #192, since the two `<ul>`s were siblings, not
 * ancestor and descendant. `<li>` also carries its own accessible
 * `listitem` role for free, which is what keeps these handlers off
 * biome's `noStaticElementInteractions` lint without an explicit `role`
 * — the same reason they never moved onto that div in the first place.
 */
export function TaskRow({
  task,
  detailActions,
  commentCount = 0,
  subtaskCount = 0,
  onComplete,
  onCompleteForever,
  onUncomplete,
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
  children,
  suppressDateBadge,
}: TaskRowProps) {
  // The full command set's own open state (issue #178) — right-click
  // anywhere on the row, the `.` key while a Task row has focus (issue
  // #228's own `use-todo-keymap.ts`, listening once at the document level
  // rather than here — see the `useEffect` below), or clicking the "More
  // actions" button below all just flip this one flag, and TaskCommandMenu
  // (its own header comment) renders the identical menu regardless of
  // which of the three opened it. Owned here, not in `TaskRowContent`
  // (issue #224's own visual/interaction split, that file's header
  // comment): both this `<li>`'s `onContextMenu` below AND that file's
  // trigger button need to flip the identical flag, and a `<li>` reaching
  // *down* into a child's state would invert the ownership this file
  // already has of everything the `<li>` itself does.
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);

  // Issue #253: the row's own anchored `TaskSchedulePopover` instance
  // (task-row-content.tsx) — a second, independent open flag alongside
  // `commandMenuOpen` above, owned here for the identical reason: both the
  // full command set's own trigger and this row's own Date popover need a
  // single flag two different entry points can flip (a direct click on
  // this row's own controls, or the `T` shortcut's document-level event,
  // `OPEN_SCHEDULE_EVENT`'s own doc comment in todo-keymap.ts), and only
  // this `<li>` — not `TaskRowContent`, issue #224's own visual/interaction
  // split — owns state two of its own children (the Date button and
  // `TaskCommandMenu`'s "Date…" item) both need to reach.
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Issue #228: supersedes this row's own former `.`-key `onKeyDown` —
  // `use-todo-keymap.ts`'s one document-level listener resolves "which
  // Task" from `document.activeElement` and dispatches this event rather
  // than every row keeping a keydown handler of its own (that file's own
  // header comment on why centralising this is a real simplification, not
  // just relocation: the old per-row handler needed `stopPropagation()`
  // solely to keep a nested sub-task's `.` press from also popping its
  // parent's menu, issue #192's own nesting — a single listener keyed off
  // focus is never ambiguous between ancestor and descendant rows, so
  // that guard has nothing left to do).
  useEffect(() => {
    function onOpenCommandMenu(event: Event) {
      const detail = (event as CustomEvent<OpenCommandMenuDetail>).detail;
      if (detail.taskId === task.id) {
        setCommandMenuOpen(true);
      }
    }
    document.addEventListener(OPEN_COMMAND_MENU_EVENT, onOpenCommandMenu);
    return () => document.removeEventListener(OPEN_COMMAND_MENU_EVENT, onOpenCommandMenu);
  }, [task.id]);

  // Issue #253: the `T` shortcut's own door onto this row's Date popover —
  // mirrors the `OPEN_COMMAND_MENU_EVENT` listener above exactly, one
  // document-level event, keyed on `task.id`, dispatched by
  // `use-todo-keymap.ts` for a Task it has no direct component reference
  // to.
  useEffect(() => {
    function onOpenSchedule(event: Event) {
      const detail = (event as CustomEvent<OpenScheduleEventDetail>).detail;
      if (detail.taskId === task.id) {
        setScheduleOpen(true);
      }
    }
    document.addEventListener(OPEN_SCHEDULE_EVENT, onOpenSchedule);
    return () => document.removeEventListener(OPEN_SCHEDULE_EVENT, onOpenSchedule);
  }, [task.id]);

  return (
    <li
      data-task-id={task.id}
      // ROW-14 (parity-ledger.md): a completed Task renders through this
      // very row, inline, at its own `orderKey` position — this marker
      // (derived straight from `task.completedAt`, the same field
      // `TaskRowContent`'s own `isCompleted` reads, rather than a second
      // prop this file would have to keep in sync with it) is what lets
      // `task-tree.tsx`'s `measureRows` exclude a completed row from drag
      // and keyboard-reorder geometry — that file's own header comment on
      // why a completed row is never a legal drop/nest target.
      data-completed-task={task.completedAt !== null ? "true" : undefined}
      // The full command set, reached from anywhere on the row — issue
      // #178's own reference behaviour ("the full command set lives
      // behind right-click and the `.` key, not on the row"). Right-click
      // is still read here, on the `<li>` itself: a click anywhere on the
      // row bubbles up to this handler, so the reader doesn't have to land
      // on one specific element first. `.` itself moved off this element
      // entirely (issue #228) — the `useEffect` above listens for the
      // centralised hook's own event instead.
      //
      // `stopPropagation()` here is new with issue #192, not incidental:
      // that ticket nested a row's own sub-task `<ul>` *inside* its own
      // `<li>` (this file's own header comment), which means a click on a
      // *child* row's `<li>` now bubbles up through every ancestor row's
      // `<li>` too, not just through the outer `<ul>` the way it did when
      // the two were siblings. Without stopping it here, right-clicking a
      // sub-task would pop that sub-task's own menu *and* its parent's,
      // both reading the identical event — silently impossible before
      // #192, since nothing this handler could bubble through belonged to
      // another row's own `<li>` at all.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setCommandMenuOpen(true);
      }}
    >
      {/*
        `TaskRowContent`, not an inline `<div>` — issue #224 pulled every
        visual/styling concern out of this file into that one (its own
        header comment carries the full reasoning). Its own root element
        IS `<div data-task-row-box>`, so this call site still puts that
        marker exactly where task-tree.tsx's `measureRows` expects it: a
        direct child of this `<li>`, sibling to `children` below — a
        component boundary adds no DOM level of its own. This `<li>`
        keeps no `onContextMenu`/`onKeyDown` on that div (both stay above,
        on the `<li>` itself) for the identical reason they always did:
        one row's own sub-tasks now nest inside its `<li>` (issue #192),
        so stopping propagation has to happen at the `<li>`, the one
        element every descendant row's own event actually bubbles through.
      */}
      <TaskRowContent
        task={task}
        detailActions={detailActions}
        commentCount={commentCount}
        subtaskCount={subtaskCount}
        onComplete={onComplete}
        onCompleteForever={onCompleteForever}
        onUncomplete={onUncomplete}
        onRequestDelete={onRequestDelete}
        onOpenSchedule={onOpenSchedule}
        isDropTarget={isDropTarget}
        isNestTarget={isNestTarget}
        depth={depth}
        onHandlePointerDown={onHandlePointerDown}
        onHandlePointerMove={onHandlePointerMove}
        onHandlePointerUp={onHandlePointerUp}
        onHandlePointerCancel={onHandlePointerCancel}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onIndent={onIndent}
        onOutdent={onOutdent}
        sectionOptions={sectionOptions}
        onMoveToSection={onMoveToSection}
        commandMenuOpen={commandMenuOpen}
        onCommandMenuOpenChange={setCommandMenuOpen}
        scheduleOpen={scheduleOpen}
        onScheduleOpenChange={setScheduleOpen}
        suppressDateBadge={suppressDateBadge}
      />
      {/*
        This row's own sub-tasks, if any — `TaskTreeRow` (task-tree.tsx)
        passes a nested `TaskTree` here once `children.length > 0`, and it
        lands as a sibling of the `<div data-task-row-box>` above, both
        inside this same `<li>`, which is what makes the sub-task `<ul>` a
        child of this row's own `<li>` rather than of the outer one two
        levels up (issue #192; this file's own header comment above has
        the fuller account of why that distinction is the whole ticket).
      */}
      {children}
    </li>
  );
}
