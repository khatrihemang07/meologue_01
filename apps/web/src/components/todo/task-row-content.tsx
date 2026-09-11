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
  CalendarClock,
  CheckCheck,
  GripVertical,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { Suspense, useRef, useState } from "react";
import { inlineProse } from "@/components/inline-prose";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { TaskCommandMenu } from "@/components/todo/task-command-menu";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { localDayKey } from "@/lib/local-day-key";
import { projectNameFor } from "@/lib/project-name";
import { useSettingsStore } from "@/lib/settings";
import { priorityColour } from "@/lib/task-priority-colors";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";
import { cn } from "@/lib/utils";

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
  onComplete: () => void;
  onCompleteForever: () => void;
  onRequestDelete: () => void;
  onOpenSchedule: () => void;
  isDropTarget: boolean;
  isNestTarget: boolean;
  depth: number;
  onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerMove?: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerUp?: (event: PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  sectionOptions?: { id: string; name: string }[];
  onMoveToSection?: (sectionId: string | null) => void;
  /** The full command set's own open state — owned by `task-row.tsx` (its `<li>`'s own `onContextMenu`/`onKeyDown` also set it), threaded down here only because the trigger button lives in this file. */
  commandMenuOpen: boolean;
  onCommandMenuOpenChange: (open: boolean) => void;
}

/**
 * The classes that reveal a row affordance on hover (ROW-04), named once
 * rather than repeated at each of the six sites that need them.
 *
 * **Written out in full here, never assembled.** Tailwind scans source as
 * raw text, so a class built by interpolation — `${variant}:opacity-0` —
 * is never emitted at all and the name reaches the DOM with no rule behind
 * it. That failed silently in this very file once, leaving every drag
 * handle and action icon at full opacity on every row while the whole
 * suite stayed green. A `const` holding the *complete, literal* strings is
 * safe for exactly the reason the interpolated variant was not: the
 * scanner can see them.
 *
 * The `pointer-fine` variant itself (index.css) is `(hover: hover)` OR
 * `(pointer: fine)` — the second arm is what keeps these reachable in a
 * Tauri window, which can report a coarse pointer for a trackpad and would
 * otherwise hide every row action outright.
 */
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
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  isDropTarget,
  isNestTarget,
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
}: TaskRowContentProps) {
  // Issue #225: inline row editing, which did not exist before this
  // ticket. Driven on the live app after the ticket's first pass shipped
  // a guessed gesture (a double-click, since removed): Todoist's own
  // hover controls — Complete, **Edit**, Date, Comment, More actions, in
  // that order — already include a pencil that activates the shared
  // `tiptap ProseMirror` editor in place, no dialog, no URL change. The
  // "Edit" button below (`aria-label={"Edit \"" + task.content + "\""}`,
  // this file's own pre-existing hover action) is that measured
  // affordance, not a new one — it used to call `onOpenDetail` the same
  // as the title itself; it now activates `editingTitle` instead. A
  // single click on the title keeps its one unambiguous meaning from
  // before this ticket — this app's own row title has always been a
  // `<button>` that opens the detail route — unchanged now that
  // activation has its own dedicated control. No timing heuristic needed.
  //
  // One real structural divergence, recorded in the ledger (ROW-11) rather
  // than silently absorbed: Todoist swaps the whole row out for an edit
  // form at the same position in the list (`editorInsideRow` measured
  // `false` — the editor is a sibling of `li.task_list_item`, not a
  // descendant). This component mounts `TaskTitleEditor` *inside* the
  // existing row instead, alongside the checkbox and metadata line that
  // stay visible underneath it. Matching Todoist's own swap would mean a
  // second row-shaped host rendered outside this `<li>` entirely — a
  // bigger structural change than this ticket's own brief asked for, and
  // not worth it for a divergence with no observed behavioural
  // consequence (the same editor, the same commit/cancel keys, land
  // either way).
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
  const optionsRef = useRef<QuickAddOptions>({ now: localDayKey(new Date()), smartDates });
  optionsRef.current = { now: localDayKey(new Date()), smartDates };

  function commitTitle(next: string) {
    setEditingTitle(false);
    const trimmed = next.trim();
    if (trimmed === "" || trimmed === task.content) {
      return;
    }
    detailActions.onRename(task.id, trimmed);
  }

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
  // Whether the metadata line has anything at all to show — extended by
  // issue #224 with Labels/Project/sub-tasks alongside the pre-existing
  // Date/Deadline/Priority/recurrence/comment checks, so a plain Task
  // with none of these still renders no empty, gap-holding line.
  const hasMetadata =
    task.date !== null ||
    task.deadline !== null ||
    task.priority !== 1 ||
    isRecurring ||
    resolvedLabels.length > 0 ||
    projectName !== null ||
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
      className={cn(
        "group flex items-center gap-2 rounded-lg border-t-2 border-t-transparent transition-colors",
        // ROW-02 (parity-ledger.md): a full-width divider, 0px inset —
        // living here rather than on the `<li>` around it because
        // `border-bottom` is measured from this element's own border-box,
        // which starts at the same left edge as the `<li>`'s regardless
        // of the `paddingLeft` below (padding sits *inside* the border,
        // never shifting it) — so the divider stays flush with the list's
        // own edge for a depth-1 row and a nested one alike, matching the
        // reference's own "not indented to align with the checkbox" note.
        "border-b border-border",
        // ROW-04: the row background no longer tints on hover — Todoist's
        // own reference measured no change at all, confirmed both by
        // computed style and by pixel-diffing a hover screenshot against
        // rest. `hover:bg-muted` used to sit here; only the four hover
        // actions below still animate anything now.
        isDropTarget && "border-t-primary",
        isNestTarget && "bg-primary/10 ring-2 ring-primary ring-inset",
      )}
      // ROW-01: 59px is the row's own baseline height for a single-line
      // title plus one metadata line — `min-h`, not a fixed `h`, because a
      // title long enough to wrap (ROW-05's own 4-line clamp, below) has
      // to be allowed to grow the row rather than clip against a hard
      // ceiling the reference itself never measured against a wrapped
      // title. "No padding on the row itself" is why this box carries
      // none of its own: the checkbox, title and metadata line supply
      // whatever internal spacing they need, and centring via
      // `items-center` is what keeps a short, unwrapped title vertically
      // balanced inside the 59px floor rather than pinned to its top.
      style={{ minHeight: "59px", paddingLeft: `${12 + (depth - 1) * 20}px`, paddingRight: "12px" }}
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
          // Revealed with the rest of the row's affordances (ROW-04), not
          // standing permanently — Todoist's own handle appears on hover
          // ahead of Edit/Date/Comment/More, and a grip drawn on every row
          // at rest is the single most obvious tell that a list is not it.
          //
          // `focus-visible:opacity-100` is not decoration here: this button
          // is the keyboard reorder target (arrow keys to move, Alt+arrows
          // to indent), so it has to become visible when tabbed to or the
          // whole reordering path is invisible to a keyboard reader.
          className={cn(
            "flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground active:cursor-grabbing",
            HOVER_REVEAL_CLASSES,
          )}
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      )}
      {/*
        ROW-03: a 24×24 hit box around an 18×18 visible ring — a `<label>`,
        not a plain wrapping `<span>`, is what makes the OUTER box
        clickable at all: a native `<label>` forwards a click anywhere in
        its own box to the `<input>` it wraps, which is what turns "18px
        input centred in a 24px box" into "24px hit box" rather than
        merely "24px of padding around an 18px click target." The ring
        itself is still the box-shadow `priorityColour` already produced
        pre-#224 (issue #223's own token work) — only the two sizes
        changed to match the measured pair.
      */}
      <label className="flex size-6 shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          checked={false}
          readOnly
          onClick={(event: MouseEvent<HTMLInputElement>) => {
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
          aria-label={task.content}
          style={{ boxShadow: `0 0 0 1px ${priorityColour(uiPriorityOf(task.priority))}` }}
          // `appearance-none` is what makes `rounded-full` mean anything at
          // all here (ROW-03). A native checkbox paints the platform widget
          // and ignores border-radius entirely, so this rendered as a square
          // against Todoist's circle while the computed style still
          // truthfully reported `border-radius: 9999px` — measuring the
          // property agreed; only the screenshot disagreed.
          //
          // Nothing is lost by dropping the native paint: this control never
          // renders ticked. A completed Task leaves the list, which is why it
          // is `checked={false} readOnly` above and why the priority ring,
          // not a checkmark, is the whole of what it draws.
          className="block size-[18px] shrink-0 appearance-none rounded-full accent-current"
        />
      </label>
      <span className="flex min-w-0 flex-1 flex-col">
        {editingTitle ? (
          // Todoist's own display/edit split (row-and-detail.md §2,
          // DET-06): the row hosts the shared editor only while actually
          // editing, never permanently — `<Suspense fallback={...}>` is
          // what keeps ProseMirror out of Todo's own eager chunk even
          // though this row renders synchronously (`lazy-task-title-
          // editor.ts`'s own header comment has the bundle numbers). The
          // fallback repeats the display button's own text rather than a
          // spinner, so the one frame before the lazy chunk resolves
          // shows the same words the reader just double-clicked, not a
          // flash of empty space.
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
            />
          </Suspense>
        ) : (
          <button
            type="button"
            onClick={() => detailActions.onOpenDetail(task)}
            // ROW-05: long titles wrap and clamp after 4 lines — they do
            // NOT truncate to one (the user's own complaint this ticket
            // names). `line-clamp-4` replaces the old `truncate`; ROW-06
            // needs no code of its own; `task.content` was already a plain
            // string interpolated as text, never run through a markdown
            // renderer, so it already stayed literal before this ticket.
            className={cn(
              "line-clamp-4 block w-full text-left hover:underline",
              "text-[length:var(--td-row-font-size)] leading-[length:var(--td-row-line-height)]",
            )}
          >
            {task.content}
          </button>
        )}
        {/* ROW-07: a Description previews as real HTML from markdown, one
            line, beneath the title — `inlineProse` (not the block-level
            `entryProse`) because a "first line" preview is exactly the
            unwrapped inline content that renderer already returns with no
            block wrapper of its own (inline-prose.tsx's own header
            comment), and a `<ul>`/second `<p>` from a multi-paragraph
            Description would defeat the one-line `truncate` below rather
            than cooperate with it. Only the first `\n`-delimited line, not
            the whole Description: this is a preview, and the full text is
            one tap away in the detail view (task-detail-view.tsx) already. */}
        {task.description !== null && (
          <div className="truncate text-muted-foreground text-xs">
            {inlineProse(descriptionFirstLine)}
          </div>
        )}
        {hasMetadata && (
          // ROW-09: adjacent flex children with a gap, no separator glyph
          // between any two of them — issue #224 extends this same rule
          // to every new field (Labels, Project, sub-task count) rather
          // than inventing a comma/pipe/dot the reference never showed
          // for the two fields it did observe (date, comment count).
          <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
            {dateDisplay !== null && (
              <span style={{ color: dateDisplay.colour }}>{dateDisplay.text}</span>
            )}
            {task.deadline !== null && <span>Due {formatDay(task.deadline)}</span>}
            {task.priority !== 1 && <span>P{uiPriorityOf(task.priority)}</span>}
            {resolvedLabels.map((label) => (
              <LabelBadge key={label.id} label={label} />
            ))}
            {projectName !== null && <span className="truncate">{projectName}</span>}
            {/* `task.dateString` verbatim — "the string is the truth"
                (task-types.ts's own doc comment) — stays alongside the ↻
                DATE-04 now appends to `dateDisplay.text` itself; the two
                aren't redundant so much as two different audiences for
                the identical fact, the glyph for a glance, the literal
                rule for a reader who wants to know exactly what they
                typed. */}
            {task.dateString !== null && <span>{task.dateString}</span>}
            {subtaskCount > 0 && (
              <span className="flex items-center gap-0.5">
                <ListTree aria-hidden="true" className="size-3" />
                {subtaskCount}
              </span>
            )}
            {commentCount > 0 && (
              <span className="flex items-center gap-0.5">
                <MessageSquare aria-hidden="true" className="size-3" />
                {commentCount}
              </span>
            )}
          </span>
        )}
      </span>
      {isRecurring && (
        <button
          type="button"
          aria-label={`Complete and archive recurring task "${task.content}"`}
          onClick={onCompleteForever}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
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
      {/* Edit/Date/Comment: hidden by default, revealed on a device this
          file's own `HOVER_REVEAL_CLASSES` (above) judges capable of hover —
          see that constant's own doc comment for why the condition
          widened beyond plain `(hover: hover)`. More stays unconditional:
          it is the one door onto Edit/Date/Comment's own actions (via the
          command menu) that a touch reader — genuinely coarse, not merely
          misreported — can always reach.

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
          "hidden pointer-fine:flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          HOVER_REVEAL_CLASSES,
        )}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label={`Date "${task.content}"`}
        onClick={onOpenSchedule}
        className={cn(
          "hidden pointer-fine:flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          HOVER_REVEAL_CLASSES,
        )}
      >
        <CalendarClock aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label={`Comment on "${task.content}"`}
        onClick={() => detailActions.onOpenDetail(task)}
        className={cn(
          "hidden pointer-fine:flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
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
              "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
              HOVER_REVEAL_CLASSES,
              "aria-expanded:opacity-100",
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
    </div>
  );
}
