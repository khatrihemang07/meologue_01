/**
 * `TaskRow`'s own visual layer (issue #224) — every element that used to
 * live inside that file's `<div data-task-row-box>`, split out because
 * that file had grown to 41KB and most of that weight was drag, nesting
 * and keyboard-reorder behaviour that has nothing to do with what a row
 * *looks* like. `task-row.tsx` keeps the `<li>` (identity, the full
 * command set's own `onContextMenu`/`onKeyDown`, and this row's own
 * sub-tasks as `children`) and renders exactly one `<TaskRowContent>`
 * inside it; every prop below is either a Task field this component reads
 * directly or a callback/flag `task-row.tsx` forwards unchanged from its
 * own props — this file owns no drag geometry, no keyboard-reorder maths
 * and no TaskTree wiring of its own.
 *
 * **This component's own root element IS `<div data-task-row-box>`.**
 * That marker is task-tree.tsx's own `measureRows` contract with
 * task-row.tsx (that file's own header comment on the div carries the
 * full reasoning) — `:scope > [data-task-row-box]`, read off the `<li>`
 * task-row.tsx renders this component inside of, is what has to keep
 * resolving to this element's own border-box. A component boundary adds
 * nothing to the DOM by itself, so `<li><TaskRowContent />{children}</li>`
 * still puts this div exactly where the pre-#224 single-file version did:
 * a direct child of the `<li>`, sibling to `children`, never a level
 * deeper.
 */
import type { Label, QuickAddOptions, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import {
  Calendar,
  CalendarClock,
  Check,
  CheckCheck,
  GripVertical,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Repeat,
} from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { Suspense, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { inlineProse } from "@/components/inline-prose";
import { LazyTaskSchedulePopover } from "@/components/todo/lazy-task-schedule-popover";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { TaskCommandMenu } from "@/components/todo/task-command-menu";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { taskTitleText } from "@/components/todo/task-title-text";
import { SWIPE_TARGET_ATTRIBUTE } from "@/hooks/use-swipe-actions";
import { useTaskDateState } from "@/hooks/use-task-date-state";
import { formatTaskDate } from "@/lib/format-task-date";
import { localDateTimeKey, localDayKey } from "@/lib/local-day-key";
import { projectNameFor } from "@/lib/project-name";
import type { QuickAddAutocompleteOptions } from "@/lib/quick-add-autocomplete";
import { useSettingsStore } from "@/lib/settings";
import { taskDetailPath } from "@/lib/task-detail-route";
import { priorityColour } from "@/lib/task-priority-colors";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";
import { cn } from "@/lib/utils";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";

export interface TaskRowContentProps {
  task: Task;
  detailActions: TaskDetailActions;
  commentCount: number;
  /**
   * How many direct sub-tasks this Task has (issue #224's own "must gain"
   * list) — `task-tree.tsx`'s `TaskTreeRow` already fetches this Task's
   * own children (to decide whether to render a nested `TaskTree` at
   * all), so it hands the count straight through rather than this row
   * reaching for a second, redundant query for a number the caller
   * already has in hand.
   */
  subtaskCount: number;
  /** How many of them are done (issue #298). See TaskRow's own prop doc for why this cannot come from the rendered children. */
  subtaskDone: number;
  onComplete: () => void;
  onCompleteForever: () => void;
  onUncomplete?: () => void;
  onRequestDelete: () => void;
  isDropTarget: boolean;
  isNestTarget: boolean;
  /** See `TaskRow`'s own `isDragging` doc comment (TaskRowProps) — forwarded straight through, unchanged. */
  isDragging?: boolean;
  depth: number;
  onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  /** Widened from `HTMLButtonElement` — see `TaskRow`'s own identical prop doc comment (TaskRowProps) for why. */
  onHandlePointerMove?: (event: PointerEvent<HTMLElement>) => void;
  onHandlePointerUp?: (event: PointerEvent<HTMLElement>) => void;
  onHandlePointerCancel?: (event: PointerEvent<HTMLElement>) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  sectionOptions?: { id: string; name: string }[];
  onMoveToSection?: (sectionId: string | null) => void;
  /** The full command set's own open state — owned by `task-row.tsx` (its `<li>`'s own `onContextMenu`/`onKeyDown` also set it), threaded down here only because the trigger button lives in this file. */
  commandMenuOpen: boolean;
  onCommandMenuOpenChange: (open: boolean) => void;
  /**
   * This row's own `TaskSchedulePopover` open state (issue #253) — owned by
   * `task-row.tsx` for the identical reason `commandMenuOpen` above is: the
   * hover Date button (this file), the More-actions "Date…" item (also
   * this file, via `TaskCommandMenu`) and the `T` shortcut
   * (`task-row.tsx`'s own `OPEN_SCHEDULE_EVENT` listener) all have to flip
   * the same flag regardless of which one fires.
   */
  scheduleOpen: boolean;
  onScheduleOpenChange: (open: boolean) => void;
  suppressDateBadge?: boolean;
  suppressProjectBadge?: boolean;
}

const HOVER_REVEAL_CLASSES =
  "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100";

/** One resolved Label as a compact row badge — a dot in the Label's own colour plus its name, mirroring the detail view's identical dot-plus-name pairing (`task-detail-view.tsx`'s Labels attribute) at a size that fits this row's single metadata line rather than that view's own full-width picker row. */
function LabelBadge({ label }: { label: Label }) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: label.colour }}
      />
      {label.name}
    </span>
  );
}

export function TaskRowContent({
  task,
  detailActions,
  commentCount,
  subtaskCount,
  subtaskDone,
  onComplete,
  onCompleteForever,
  onUncomplete,
  onRequestDelete,
  isDropTarget,
  isNestTarget,
  isDragging = false,
  depth,
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
  commandMenuOpen,
  onCommandMenuOpenChange,
  scheduleOpen,
  onScheduleOpenChange,
  suppressDateBadge = false,
  suppressProjectBadge = false,
}: TaskRowContentProps) {
  const [editingTitle, setEditingTitle] = useState(false);

  // Issue #247: the identical recognition plugin add-task-form.tsx and
  // task-detail-view.tsx already attach to their own title editors — this
  // row had none at all before now, so a phrase typed while renaming here
  // highlighted nothing even though the rename itself has, since this
  // ticket, started resolving it (task-title-commit.ts, wired one layer up
  // by whichever page builds `detailActions.onRename`). A ref, not plain
  // state, matching both of those files' own reasoning: `extraPlugins` is
  // read once, at the editor's mount, while `smartDates`/`now` are read
  // live on every decoration pass through `getOptions` below. A ref PER
  // ROW is correct here and must not be hoisted above this component: the
  // editor only mounts while `editingTitle` is true, so each edit is a
  // fresh mount with nothing stale to carry over from the last one.
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);
  const optionsRef = useRef<QuickAddOptions>({ now: localDateTimeKey(new Date()), smartDates });
  optionsRef.current = { now: localDateTimeKey(new Date()), smartDates };

  const autocompleteOutlet = useOutletContext<EntryStoreOutletContext | undefined>();
  const autocomplete: QuickAddAutocompleteOptions = {
    getProjects: () => detailActions.projects,
    getLabels: () => detailActions.labels,
    onCreateProject: autocompleteOutlet?.addProject,
    onCreateLabel: autocompleteOutlet?.addLabel,
  };

  function commitTitle(next: string) {
    setEditingTitle(false);
    const trimmed = next.trim();
    if (trimmed === "" || trimmed === task.content) {
      return;
    }
    detailActions.onRename(task.id, trimmed);
  }

  // Issue #256: this row's own `TaskSchedulePopover` reads `task.date` split
  // into its day/time components through `useTaskDateState` — the
  // identical hook `task-detail-view.tsx`'s own popover instance also
  // consumes, replacing what used to be a byte-identical local split and
  // combine in both files (that duplication is what #256 exists to close).
  const { dateDay, dateTime, setScheduleDay, setScheduleTime } = useTaskDateState(
    task,
    detailActions.onSetDate,
  );

  const isRecurring = task.dateString !== null;
  const isCompleted = task.completedAt !== null;
  // Resolved once, not inline in the JSX below, so the metadata line's
  // `style={{ color }}` and its own text can't be read off two separate
  // calls that could in principle disagree (format-task-date.ts's own
  // header comment makes the identical argument for why this function
  // takes `completed`/`recurring` itself rather than leaving a caller to
  // splice them on afterwards).
  const dateDisplay =
    task.date === null
      ? null
      : formatTaskDate(task.date, { completed: isCompleted, recurring: isRecurring });
  const resolvedLabels = task.labelIds
    .map((id) => detailActions.labels.find((label) => label.id === id))
    // A dangling labelId (label-types.ts's own `labelIds` doc comment:
    // "an accepted, transient state, not something this store reaches
    // across tables to enforce") reads as "filter it out," the identical
    // stance task-detail-view.tsx's own Labels attribute already takes.
    .filter((label): label is Label => label !== undefined);
  const projectName =
    task.projectId === null ? null : projectNameFor(detailActions.projects, task.projectId);
  const descriptionFirstLine = task.description?.split("\n")[0] ?? "";
  const hasMetadata =
    (dateDisplay !== null && !suppressDateBadge) ||
    isRecurring ||
    resolvedLabels.length > 0 ||
    (projectName !== null && !suppressProjectBadge) ||
    subtaskCount > 0 ||
    commentCount > 0;
  const draggable =
    onHandlePointerDown !== undefined &&
    onHandlePointerMove !== undefined &&
    onHandlePointerUp !== undefined &&
    onHandlePointerCancel !== undefined &&
    onMoveUp !== undefined &&
    onMoveDown !== undefined &&
    onIndent !== undefined &&
    onOutdent !== undefined;
  // The row's hover actions reveal under the `pointer-fine` variant
  // declared in index.css — `(hover: hover)` OR `(pointer: fine)`.
  //
  // Issue #224: they used to hide entirely outside `(hover: hover)`, which
  // is right for a genuine touchscreen and wrong for a Tauri desktop
  // window — a mouse-only window can report `(hover: none)` even though the
  // input attached to it is a mouse. A touchscreen reports BOTH
  // `(hover: none)` AND `(pointer: coarse)`; the Tauri misreport has only
  // been seen getting hover wrong while `(pointer: fine)` still names the
  // real input. Hiding only when BOTH read coarse-and-hoverless keeps the
  // touch fix this file's own history records — four 44px buttons once left
  // "call the dentist" room for "call …" on a 349px row — without punishing
  // a desktop build for a media-feature bug that is not this row's to fix.
  //
  // Written as a **named variant used literally**, never assembled by
  // interpolation. Tailwind scans source as raw text, so a class built as
  // `${variant}:opacity-0` is never emitted at all: the name reaches the
  // DOM with no rule behind it. That failed silently here once, leaving
  // every action visible on every row while the whole suite stayed green.

  return (
    <div
      data-task-row-box
      // Issue #303: this row's own swipe-to-schedule target — the identical
      // door `entry-bubble.tsx` already opens onto `use-swipe-actions.ts`'s
      // shared recogniser, not a second one. `data-task-id` here is a second
      // copy of the identical attribute `task-row.tsx`'s own `<li>` already
      // carries, not a competing identity: the swipe hook resolves "which
      // Task" off whichever element carries `[data-swipe-target]`, which is
      // this div, not the `<li>` around it, so this is the one place that
      // needs the id in hand. `closest("[data-task-id]")` elsewhere in this
      // app (`todo-keymap.ts`'s `focusedTaskId`) still resolves to the same
      // value either way, since this div sits *inside* the `<li>` that also
      // carries it.
      {...{ [SWIPE_TARGET_ATTRIBUTE]: "", "data-task-id": task.id }}
      className={cn(
        // `touch-pan-y` is not decoration — it is half of the contract the
        // attribute above enters into, and `entry-bubble.tsx` carries the
        // identical class for the identical reason (swipe-recognizer.ts:194
        // names it outright). Left at the default `touch-action: auto`, the
        // browser claims BOTH axes for panning, so a horizontal drag is
        // handled by the compositor and the sequence ends in `pointercancel`
        // before the recogniser's threshold is ever reached. `pan-y` keeps
        // vertical scrolling with the browser and leaves the horizontal axis
        // to `use-swipe-actions.ts`.
        //
        // Driven on the device 2026-09-15: without this the row reported
        // `touch-action: auto` and no left swipe ever opened the scheduler,
        // while every jsdom test stayed green — jsdom has no compositor, so
        // it never cancels, and a unit test cannot observe this at all.
        "touch-pan-y",
        "group flex items-center gap-2 rounded-lg border-t-2 border-t-transparent transition-colors",
        "border-b border-border",
        isDropTarget && "border-t-primary",
        isNestTarget && "bg-primary/10 ring-2 ring-primary ring-inset",
        isDragging && "relative z-10 -translate-y-1 bg-background shadow-lg",
      )}
      style={{
        minHeight: hasMetadata ? "59px" : "43px",
        paddingLeft: `${12 + (depth - 1) * 20}px`,
        paddingRight: "12px",
      }}
    >
      {draggable && (
        <button
          type="button"
          aria-label={`Reorder or reparent "${task.content}" — arrow keys to move, Alt+arrow keys to indent or outdent`}
          data-testid="task-drag-handle"
          // `stopPropagation()` on all four (issue #308, new here — the
          // grip needed none of this before): `task-row.tsx`'s own `<li>`
          // now carries this identical trio of callbacks too, armed from
          // a long-press on the row's own body rather than from this
          // button. Pointer capture on THIS button still lets a grip-drag's
          // own pointermove/up/cancel bubble up through that ancestor
          // `<li>` regardless of which element captured the pointer — so
          // without stopping it here, a single grip-drag gesture would
          // invoke `task-tree.tsx`'s `handlePointerMove`/`handlePointerUp`
          // TWICE per event (once via this button, once via the bubbled
          // copy on the `<li>`), double-writing `reorderTask` on release.
          // That state is idempotent against redundant `pointerId`
          // mismatches but not against two genuine matches for the one
          // event it's currently handling, so this has to stop the second
          // copy from ever being dispatched, not rely on the handler
          // shrugging it off.
          onPointerDown={(event) => {
            event.stopPropagation();
            onHandlePointerDown?.(event);
          }}
          onPointerMove={(event) => {
            event.stopPropagation();
            onHandlePointerMove?.(event);
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            onHandlePointerUp?.(event);
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            onHandlePointerCancel?.(event);
          }}
          onKeyDown={(event) => {
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
          className={cn(
            "hidden pointer-fine:flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground active:cursor-grabbing",
            HOVER_REVEAL_CLASSES,
          )}
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: deliberately NOT a native `<input type="checkbox">` — the 24×24 hit box has to be the button's own border-box, with the 18×18 ring on a separate inner span so the two sizes stay independent, which a native checkbox's fixed-size widget can't do. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isCompleted}
        aria-label={isCompleted ? "Mark task as incomplete" : "Mark task as complete"}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          if (isCompleted) {
            onUncomplete?.();
            return;
          }
          // Shift+Click on a recurring Task's checkbox is Todoist's own
          // documented "Complete and archive recurring task" — ends the
          // series, not "complete this occurrence" (`onCompleteForever`'s
          // own doc comment, task-row.tsx). Meaningless on a
          // non-recurring Task, so the modifier is simply ignored there.
          if (isRecurring && event.shiftKey) {
            onCompleteForever();
          } else {
            onComplete();
          }
        }}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center"
      >
        <span
          aria-hidden="true"
          style={{
            boxShadow: `0 0 0 ${uiPriorityOf(task.priority) === 4 ? "1px" : "2px"} ${priorityColour(uiPriorityOf(task.priority))}`,
            color: priorityColour(uiPriorityOf(task.priority)),
          }}
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full"
        >
          {isCompleted && <Check aria-hidden="true" className="size-3" strokeWidth={3} />}
        </span>
      </button>
      <span className="flex min-w-0 flex-1 flex-col">
        {editingTitle ? (
          <Suspense
            fallback={
              <span
                className={cn(
                  "line-clamp-4 block w-full text-left",
                  "text-[length:var(--td-row-font-size)] leading-[length:var(--td-row-line-height)]",
                )}
              >
                {task.content}
              </span>
            }
          >
            <LazyTaskTitleEditor
              value={task.content}
              onCommit={commitTitle}
              onCancel={() => setEditingTitle(false)}
              className={cn(
                "text-[length:var(--td-row-font-size)] leading-[length:var(--td-row-line-height)]",
              )}
              extraPlugins={[quickAddRecognitionPlugin(() => optionsRef.current)]}
              autocomplete={autocomplete}
            />
          </Suspense>
        ) : (
          <button
            type="button"
            onClick={() => detailActions.onOpenDetail(task)}
            className={cn(
              "line-clamp-4 block w-full text-left hover:underline",
              "text-[length:var(--td-row-font-size)] leading-[length:var(--td-row-line-height)]",
              isCompleted && "completed-task-text",
            )}
            data-row-nav-target
          >
            {taskTitleText(task.content)}
          </button>
        )}
        {task.description !== null && (
          <div className="truncate text-muted-foreground text-xs">
            {inlineProse(descriptionFirstLine)}
          </div>
        )}
        {hasMetadata && (
          <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
            {dateDisplay !== null && suppressDateBadge && isRecurring ? (
              <span aria-hidden="true" style={{ color: dateDisplay.colour }}>
                <Repeat className="size-3" />
              </span>
            ) : (
              dateDisplay !== null &&
              !suppressDateBadge && (
                <span className="flex items-center gap-0.5" style={{ color: dateDisplay.colour }}>
                  <Calendar aria-hidden="true" className="size-3" />
                  {dateDisplay.text}
                </span>
              )
            )}
            {resolvedLabels.map((label) => (
              <LabelBadge key={label.id} label={label} />
            ))}
            {projectName !== null && !suppressProjectBadge && (
              <span className="truncate">{projectName}</span>
            )}
            {task.dateString !== null && <span>{task.dateString}</span>}
            {subtaskCount > 0 && (
              // Issue #298: `done/total`, as Todoist's own badge reads.
              // This used to render `listChildren(...).length` — the count
              // of *active* children — so a parent whose sub-tasks were all
              // finished counted 0 and the badge emptied as work got done,
              // which is the opposite of the progress signal it looks like.
              <span className="flex items-center gap-0.5">
                <ListTree aria-hidden="true" className="size-3" />
                {/* "0/2" read aloud is ambiguous, and a bare <span> takes no
                    aria-label — so the glyphs are hidden and the sentence is
                    the accessible name, the same split the date badge above
                    already makes between a glyph for a glance and a literal
                    reading for anyone who wants it spelled out. */}
                <span aria-hidden="true">
                  {subtaskDone}/{subtaskCount}
                </span>
                <span className="sr-only">
                  {subtaskDone} of {subtaskCount} sub-tasks done
                </span>
              </span>
            )}
            {commentCount > 0 && (
              <Link
                to={taskDetailPath(task, { commentIntent: true })}
                aria-label={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
                onClick={(event) => event.stopPropagation()}
                className="flex items-center gap-0.5 hover:underline"
              >
                <MessageSquare aria-hidden="true" className="size-3" />
                <span aria-hidden="true">{commentCount}</span>
              </Link>
            )}
          </span>
        )}
      </span>
      {isRecurring && !isCompleted && (
        <button
          type="button"
          aria-label={`Complete and archive recurring task "${task.content}"`}
          onClick={onCompleteForever}
          className={cn(
            "flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
            HOVER_REVEAL_CLASSES,
          )}
        >
          <CheckCheck aria-hidden="true" className="size-4" />
        </button>
      )}
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
      {/* Edit/Date/Comment/More: hidden by default, revealed on a device
          this file's own `HOVER_REVEAL_CLASSES` (above) judges capable of
          hover — see that constant's own doc comment for why the condition
          widened beyond plain `(hover: hover)`.

          Issue #309: More used to stay unconditional — "the one door onto
          Edit/Date/Comment's own actions… that a touch reader can always
          reach" — while #178's full command set (Edit, Date, Priority,
          Deadline, Labels, Move to…, Copy link, Delete) had nowhere else to
          go on a phone. It has one now: #302's detail sheet renders Date,
          Priority, Labels and Project as inline attribute fields (Deadline
          too, until issue #376 removed its own field from that list) in
          its own body, and its own `⋮` overflow carries Copy link,
          Complete forever and Delete — the same three actions this menu's
          own Copy-link/Delete items duplicate. "Edit" here just calls
          `onOpenDetail`, the identical destination the title button already
          opens on a single tap. Nothing this menu offers is missing from
          that path, so More can now ride the identical `hidden
          pointer-fine:flex` gate as the other three, and a touch reader
          loses no capability — checked against #178's own full list, not
          assumed.

          Edit is issue #225's own measured inline-rename trigger — driven
          on Todoist directly: hovering a row mounts Complete, Edit, Date,
          Comment, More actions in that order, and clicking Edit activates
          the shared `tiptap ProseMirror` editor in place, no dialog, no
          URL change. This button used to call `onOpenDetail`, the same
          destination the title and Comment still open; it now activates
          `editingTitle` instead — the title's own single click keeps
          meaning "open the detail view," unchanged from before this
          ticket. */}
      <button
        type="button"
        aria-label={`Edit "${task.content}"`}
        onClick={() => setEditingTitle(true)}
        className={cn(
          "hidden pointer-fine:flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          HOVER_REVEAL_CLASSES,
        )}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>
      {/*
        Issue #253: Todoist's own scheduler — an anchored popover, not the
        bottom sheet this button used to open (`TaskScheduleSheet`, reached
        from this row only via its now-removed "Deadline…" command-menu
        item — issue #376). One `TaskSchedulePopover` instance per
        row (`scheduleOpen`/`onScheduleOpenChange`'s own doc comment above),
        anchored to this very button — a plain `<button>`, not `<Button>`
        (ui/button.tsx): Radix's `asChild` clones this element and attaches
        a ref to it to measure where to anchor, and `Button` is a plain
        function component with no `forwardRef`, so that ref would silently
        go nowhere (found the hard way, in a real browser, not by this
        file's own test suite — jsdom never lays anything out to notice).
        This button was already a plain native element before this ticket,
        so it needs no change to be a valid trigger.
      */}
      <Suspense
        fallback={
          <button
            type="button"
            aria-label={`Date "${task.content}"`}
            disabled
            className={cn(
              "hidden pointer-fine:flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
              HOVER_REVEAL_CLASSES,
            )}
          >
            <CalendarClock aria-hidden="true" className="size-4" />
          </button>
        }
      >
        <LazyTaskSchedulePopover
          open={scheduleOpen}
          onOpenChange={onScheduleOpenChange}
          dateDay={dateDay}
          dateTime={dateTime}
          onSetTime={setScheduleTime}
          dateString={task.dateString}
          datesWithTasks={detailActions.datesWithTasks}
          onPickDay={(day) => {
            setScheduleDay(day);
            if (day === null && task.dateString !== null) {
              detailActions.onSetDateString(task.id, null, localDayKey(new Date()));
            }
          }}
          onPickRecurrence={(dateString) =>
            detailActions.onSetDateString(task.id, dateString, localDayKey(new Date()))
          }
          trigger={
            <button
              type="button"
              aria-label={`Date "${task.content}"`}
              className={cn(
                "hidden pointer-fine:flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
                HOVER_REVEAL_CLASSES,
              )}
            >
              <CalendarClock aria-hidden="true" className="size-4" />
            </button>
          }
        />
      </Suspense>
      <button
        type="button"
        aria-label={`Comment on "${task.content}"`}
        onClick={() => detailActions.onOpenDetail(task)}
        className={cn(
          "hidden pointer-fine:flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          HOVER_REVEAL_CLASSES,
        )}
      >
        <MessageSquare aria-hidden="true" className="size-4" />
      </button>
      <TaskCommandMenu
        task={task}
        projects={detailActions.projects}
        labels={detailActions.labels}
        open={commandMenuOpen}
        onOpenChange={onCommandMenuOpenChange}
        trigger={
          <button
            type="button"
            aria-label={`More actions for "${task.content}"`}
            className={cn(
              "hidden pointer-fine:flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
              HOVER_REVEAL_CLASSES,
              "aria-expanded:opacity-100",
            )}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        }
        onOpenDetail={() => detailActions.onOpenDetail(task)}
        onOpenDate={() => onScheduleOpenChange(true)}
        onSetPriority={(priority) => detailActions.onSetPriority(task.id, priority)}
        onSetProject={(projectId) => detailActions.onSetProject(task.id, projectId)}
        onSetLabels={(labelIds) => detailActions.onSetLabels(task.id, labelIds)}
        onCopyLink={() => detailActions.onCopyLink(task)}
        onRequestDelete={onRequestDelete}
      />
    </div>
  );
}
