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
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { TaskCommandMenu } from "@/components/todo/task-command-menu";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { TaskSchedulePopover } from "@/components/todo/task-schedule-popover";
import { useTaskDateState } from "@/hooks/use-task-date-state";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { localDayKey } from "@/lib/local-day-key";
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
  onComplete: () => void;
  onCompleteForever: () => void;
  /**
   * Un-completes this Task — ROW-14's own gap (parity-ledger.md): this
   * component already derives `isCompleted` from `task.completedAt` and
   * renders the correct `aria-checked`/"Mark task as incomplete" wording
   * (`git show c0d16a4`), but until now the checkbox's own `onClick`
   * always called `onComplete`, with no way back. Optional — every caller
   * that only ever hands this component an active Task (Today, Upcoming)
   * has no completed state to reverse and needs no change; `task-tree.tsx`
   * is the one caller that renders a completed Task through this
   * component now and always supplies it.
   */
  onUncomplete?: () => void;
  onRequestDelete: () => void;
  /**
   * Opens the shared `TaskScheduleSheet` (Deadline and Priority) — narrowed
   * by issue #253, which moved Date onto its own anchored
   * `TaskSchedulePopover` instance (`scheduleOpen`/`onScheduleOpenChange`
   * above) rather than the sheet's own "Pick a date" button. This prop is
   * now reached only from `TaskCommandMenu`'s "Deadline…" item.
   */
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
  /**
   * ROW-13 (parity-ledger.md), issue #250: Today's own "Due today" section
   * shows every row due today, so the tone-coloured date badge below says
   * nothing there a reader doesn't already know from the section heading.
   * pass2-2026-09-11.md §3 measured Todoist omitting the date control from
   * the DOM entirely on such a row, not merely hiding it with CSS — this
   * prop is that same suppression, threaded down from whichever caller
   * knows it is rendering a "due today, and only today" list (today-view.tsx's
   * own `dueToday` section; its `overdue` section leaves this unset, since
   * an overdue Task's own date is not redundant there). Defaults to
   * `false` — every other caller (Inbox, a Project's own view, Today's own
   * Overdue section) keeps the badge exactly as before.
   */
  suppressDateBadge?: boolean;
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
  onUncomplete,
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
  scheduleOpen,
  onScheduleOpenChange,
  suppressDateBadge = false,
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

  // QA-14's own second half, wired into the row's rename editor: the
  // `#`/`@` autocomplete popup (`quick-add-autocomplete.ts`) needs live
  // Project/Label lists plus a create hook, none of which `TaskRowContent`
  // otherwise has in scope — `detailActions.projects`/`.labels` (above,
  // already threaded for the Project/Labels metadata badges) cover the
  // list half, but the create half (`addProject`/`addLabel`) has no
  // equivalent on `TaskDetailActions`, and adding one would mean
  // `todo-page.tsx` growing two new fields on the object it builds — a
  // file another agent owns right now, rebuilding the composer. Reading
  // `useOutletContext` directly here instead, rather than through
  // `TaskDetailActions` or a bespoke context/provider: `TaskRow`/
  // `TaskRowContent` are never rendered anywhere but inside `todo-page.tsx`'s
  // own subtree, itself a child of `EntryStoreLayout`'s `<Outlet
  // context={...}>` (App.tsx) — the exact same door `todo-page.tsx`'s own
  // `useEntryStore()` already opens (that hook is nothing but this call,
  // typed — entry-store-layout.tsx's own header comment on the export).
  // `useOutletContext` is a plain `React.useContext` under the hood
  // (react-router's own `hooks.ts`), so it needs no `<Outlet>`/Router
  // ancestor to be SAFE to call — outside one it simply reads the
  // context's default (`undefined`), never throws — which is what keeps
  // `task-row.test.tsx`'s existing `MemoryRouter`-only rendering (no
  // `EntryStoreLayout` in that tree) working unchanged: `addProject`/
  // `addLabel` there are `undefined`, so selecting "Create" only inserts
  // the typed token and mints nothing (`QuickAddAutocompleteOptions`'s own
  // doc comment already treats that as a fully supported, non-crashing
  // case, not a special one this file has to guard itself).
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
  // Whether the metadata line has anything at all to show — extended by
  // issue #224 with Labels/Project/sub-tasks alongside the pre-existing
  // Date/Deadline/Priority/recurrence/comment checks, so a plain Task
  // with none of these still renders no empty, gap-holding line.
  // ROW-10(a) (parity-ledger.md): Todoist shows priority ONLY through the
  // checkbox ring — `task-info-tags` reads empty even for a P1 Task
  // (`live-audit-dom/flow2-ROW-09-10-todoist.json`) — so `task.priority`
  // no longer counts toward whether this row has a metadata line. A
  // priority-only Task is now a title-only row (43px, ROW-01), exactly
  // Todoist's own P1 fixture (`flow2-ROW-01-02-todoist.json`).
  const hasMetadata =
    (dateDisplay !== null && !suppressDateBadge) ||
    task.deadline !== null ||
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
      // title plus one metadata line; a title-only row (no date, deadline,
      // priority, recurrence, Label, Project, sub-task or comment count —
      // `hasMetadata`, above, the SAME boolean that decides whether the
      // metadata `<span>` below renders at all) is 43px, +16px shorter.
      // Restated live (`live-audit-2026-09-11.md`): the corpus's original
      // 59px was measured on "hair wash," which carries a date badge, so it
      // was always the one-metadata-line height, never a fixed one; a
      // disposable title-only fixture measured 43px instead. This used to
      // be a single hard-coded `minHeight: "59px"` floor that held every
      // title-only row at 59 regardless — keying the floor to `hasMetadata`
      // ties it to the actual rendered content instead of a second,
      // independent guess at whether this row has a metadata line.
      //
      // Still `min-h`, not a fixed `h`, for the reason it always was: a
      // title long enough to wrap (ROW-05's own 4-line clamp, below) has to
      // be allowed to grow the row rather than clip against a hard ceiling
      // the reference itself never measured against a wrapped title. "No
      // padding on the row itself" is why this box carries none of its
      // own: the checkbox, title and metadata line supply whatever internal
      // spacing they need, and centring via `items-center` is what keeps a
      // short, unwrapped title vertically balanced inside whichever floor
      // applies, rather than pinned to its top.
      //
      // Two measured literals switched on `hasMetadata`, not a formula: the
      // row has no padding of its own to derive one from.
      //
      // The row actions (Edit, Date, Comment, More, and the recurring
      // archive button) are `size-11`, a 44px touch target that stays in the
      // layout at `opacity: 0`. Flow 11 R2 read a title-only row at 47px
      // against Todoist's 43: that 44px button plus this box's 2px
      // drop-target top border and 1px divider. Each action carries `-my-1`,
      // so it keeps its full 44px hit area but lays out at 36px, and the 43px
      // floor is what sets the row.
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
        ROW-03: a 24×24 hit box around an 18×18 visible ring. The user's
        2026-09-13 decision was to match Todoist's own element/role/name
        exactly here: `<button class="task_checkbox" role="checkbox"
        aria-checked="…" aria-label="Mark task as complete">`
        (`live-audit-dom/flow11-R2-ROW-03-PRI-05-06-both.json`'s own
        structural note; the wording itself, including the completed-state
        "Mark task as incomplete", is `lifecycle.md:70`). This used to be a
        `<label><input type="checkbox" readOnly aria-label={task.content}>`
        — a different element, role and accessible name than Todoist's own,
        the one structural divergence ROW-03 still carried after issue #250
        fixed the ring's width axis.
        A `<button>`, not a `<label>` wrapping an `<input>`, is now what
        supplies the 24×24 hit box directly — a button's own click target
        IS its border-box, so there is no wrapper needed to turn "an 18px
        control" into "a 24px hit box" the way `<label>` forwarding a click
        to its `<input>` used to. The 18×18 ring itself moves to a plain
        `aria-hidden` inner `<span>`, sized independently of the button's
        own 24×24 box, so the ring's own dimensions and priority colour
        (below) are untouched by the element swap.

        The ring's own WIDTH (issue #250, ROW-03's own "dimensionally
        incomplete" caveat) is a second axis pass2-2026-09-11.md §2
        measured and this used to flatten to a fixed 1px everywhere.

        Restated again by PRI-06 (flow 2, driven live with P1-P4 fixtures):
        the ring is 2px for EVERY non-default priority — P1 `rgb(255,112,
        102)`, P2 `rgb(255,154,19)`, P3 `rgb(82,151,255)` — and 1px only at
        P4 ("no priority", `rgb(169,169,169)`). This used to test
        `uiPriorityOf(...) === 1`, so only P1 got the 2px ring and P2/P3
        fell through to the 1px branch alongside P4 — testing "not the
        default level" (`!== 4`) instead is what covers all three.

        **CMT-05 trap, checked rather than assumed:** clicking this button
        leaves focus ON it, exactly as the old `<input>` did — a `<button>`
        is not one of `isTypingTarget`'s `INPUT`/`TEXTAREA`/
        `isContentEditable` cases, so it was never at risk of re-tripping
        the CMT-05 bug (`todo-keymap.ts`'s own denylist existed for the
        `<input>` case specifically), and `z`/`Ctrl+Z` undo after a click
        was re-verified against this exact button.
      */}
      {/* biome-ignore lint/a11y/useSemanticElements: deliberately NOT a native `<input type="checkbox">` — ROW-03's own header comment above explains why (the 24×24 hit box has to be the button's own border-box, with the 18×18 ring on a separate inner span so the two sizes stay independent, which a native checkbox's own fixed widget can't do); this is also Todoist's own exact element (`<button class="task_checkbox" role="checkbox">`), not a divergence to fix. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isCompleted}
        // Todoist's own exact wording (`lifecycle.md:70`,
        // `keyboard.md:244/278`) — ROW-14 (parity-ledger.md) is what
        // actually exercises the `true` branch now: a completed Task
        // renders through this same row inline, in place, rather than
        // leaving the list for a separate one, so `isCompleted` is real
        // here, not merely future-proofing.
        aria-label={isCompleted ? "Mark task as incomplete" : "Mark task as complete"}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          // ROW-14: an already-completed Task's checkbox only ever
          // reverses that — Shift+Click "complete and archive recurring"
          // (below) has nothing left to end once the Task is done, so it
          // isn't checked here at all.
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
          {/* ROW-14: the fill this row's own predecessor
              (`completed-tasks.tsx`'s now-removed `CompletedTaskRow`)
              added on top of the ring so a checked row reads as checked
              at a glance, not merely by `aria-checked` — carried over
              here rather than dropped, since a ring that looks identical
              whether ticked or not was never something either app's own
              artifact asked for either way. */}
          {isCompleted && <Check aria-hidden="true" className="size-3" strokeWidth={3} />}
        </span>
      </button>
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
              autocomplete={autocomplete}
            />
          </Suspense>
        ) : (
          <button
            type="button"
            onClick={() => detailActions.onOpenDetail(task)}
            // ROW-05: long titles wrap and clamp after 4 lines — they do
            // NOT truncate to one (the user's own complaint this ticket
            // names). `line-clamp-4` replaces the old `truncate`.
            //
            // ROW-14/ROW-15 (parity-ledger.md): `completed-task-text`
            // (issue #237's shared completed-style class, the same one
            // `task-detail-view.tsx`, `filter-view.tsx` and
            // `task-search-page.tsx` already gate on `completedAt`) —
            // this row's own predecessor gap: `isCompleted` was already
            // computed above, but nothing here read it until now.
            className={cn(
              "line-clamp-4 block w-full text-left hover:underline",
              "text-[length:var(--td-row-font-size)] leading-[length:var(--td-row-line-height)]",
              isCompleted && "completed-task-text",
            )}
            // KBD-03/04 (parity ledger): this button, not the `<li data-
            // task-id>` it lives inside, is what Todoist's own measured
            // target actually is — a `role="button"` element carrying the
            // task title (`meologue-parity-docs/todoist/live-audit-dom/flow6-
            // KBD-03-todoist.json`). `use-todo-keymap.ts`'s `focusAdjacentRow`
            // walks every `[data-row-nav-target]` in one live `querySelectorAll`
            // to build the row-to-row cycle straight from the DOM, so a
            // future row type only needs this one attribute to join it —
            // no second, hand-maintained list to fall out of sync with
            // (exactly the parity defect a destination added to one nav
            // but not the other already produced once in this repo).
            data-row-nav-target
          >
            {/* ROW-06 (parity-ledger.md): driven live, both apps, flow 10 —
                Todoist parses markdown in a task TITLE at render time
                (`<strong>`/`<em>`/`<code>` in the row's own
                `div.task_content`), verified with a title whose stored text
                was confirmed to hold only literal delimiters, never
                composer-converted marks
                (`live-audit-dom/flow10-ROW-06-both.json`'s own
                `decisiveTest`). `task.content` itself is untouched — this
                is `inlineProse` (inline-prose.tsx), the same inline-only
                renderer ADR 0041 already uses for a Description preview two
                lines below, chosen because a title is one line and that
                renderer never enters the block layer. The stored/edited
                value stays raw: this only swaps what the reader sees. Every
                `aria-label` on this row still interpolates the raw
                `task.content` (below and throughout this file) — the
                artifact only measured Todoist keeping ITS OWN raw markdown
                on the tab-title/dialog-accessible-name strings, never on a
                hover button's aria-label, so there is nothing recorded to
                match there; changing them was also not asked for, and
                `line-clamp-4`/`hover:underline` above needs no change either. */}
            {inlineProse(task.content)}
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
            {/* DATE-01 (parity-ledger.md), issue #257: an inline 12×12
                calendar `<svg>` beside the date text, measured live on an
                overdue row (`live-audit-dom/flow8-DATE-01-todoist.json`) —
                `hasSvgIconInsideDateControl: true`, `svgViewBox: "0 0 12
                12"`. That artifact only ever sampled overdue rows (four
                "Yesterday" captures, `flow8-DATE-01-debug.json`), so
                whether Todoist's non-overdue dates (Today, a weekday, "21
                Sep") also carry the icon was NOT settled either way — put
                here on every dated row, per this fix's own instruction for
                an unsettled artifact, rather than gated to overdue only. */}
            {dateDisplay !== null && suppressDateBadge && isRecurring ? (
              // DATE-04 (parity-ledger.md): driven live on Today (flow 2)
              // — a recurring Task due today is NOT fully suppressed like
              // a plain due-today row (ROW-13) is. Todoist keeps the
              // `due-date-control` button but empties its text, leaving an
              // icon-only badge: `<span class="date date_today"><svg
              // .../></span>`, tinted the Today green
              // (`rgb(37,184,76)`, `live-audit-dom/flow2-ROW-13-todoist.
              // json`'s own `colorOfRecurrenceIcon`). The artifact's own
              // verdict calls that lone svg "the recurrence glyph," not a
              // second calendar icon beside it — a single icon replacing
              // both the calendar (DATE-01) and the date text, not the two
              // stacked — so this renders `Repeat` alone, colour-matched
              // via `dateDisplay.colour` (already "today" green here,
              // since this only fires on a due-today row), and no text.
              // No `aria-label` was recorded on Todoist's own button
              // (`due-date-control` carries none), so none is added here
              // either. Non-Today views (Inbox, Upcoming) were not
              // re-driven for this row — `flow2-ROW-13-todoist.json` notes
              // "Todoist's Inbox rendering of the same task was not read" —
              // so they keep the existing "Today ↻" plus the separate
              // `task.dateString` badge below, unchanged.
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
            {task.deadline !== null && <span>Due {formatDay(task.deadline)}</span>}
            {/* ROW-10(a): Todoist shows NO priority text badge on a row —
                `task-info-tags` is empty even for a P1 Task
                (`live-audit-dom/flow2-ROW-09-10-todoist.json`), priority
                shows only through the checkbox ring (ROW-03/PRI-05/PRI-06).
                This used to render `P1`/`P2`/`P3` here for every non-default
                priority; removed rather than kept "for information," since
                the reference itself never shows it and `hasMetadata` above
                no longer counts priority either. */}
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
              // ROW-08 (parity-ledger.md): Todoist's own badge is a real
              // `<a aria-label="N comment(s)" href="…?intent=reply">`
              // (`row-and-detail.md:120`, singular confirmed live —
              // `flow10-ROW-09-both.json`'s own `"1 comment"` reading —
              // plural `"2 comments"` from `flow2-ROW-06-07-08-todoist.
              // json`) — this used to be a plain, non-interactive `<span>`.
              // `taskDetailPath` (task-detail-route.ts) is the one place
              // this app already builds a Task's own detail address; no
              // `?intent=reply` equivalent is added here because
              // `task-detail-view.tsx` has no query-param door onto
              // focusing its comment composer to answer that intent (its
              // `CommentComposer` is a plain always-visible field with no
              // read of `useSearchParams` at all) — building that focus
              // behaviour is a separate piece of work this row's own fix
              // doesn't take on, so the link's destination is the bare
              // detail path, same place the title/Comment hover action
              // already open.
              // `stopPropagation` keeps this link's own navigation from
              // also bubbling into whatever ancestor click handling this
              // row picks up in the future — the same defensive posture
              // the checkbox's Shift+Click branch above already takes for
              // a different reason.
              <Link
                to={taskDetailPath(task)}
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
      {/* ROW-14 decision: hidden once the Task is already completed — "end
          the series" has nothing left to do to a Task that's already
          done, and the checkbox's own Shift+Click branch above is
          disabled for the identical reason. Neither artifact measured a
          completed recurring row's own hover controls (this ticket's own
          report), so this is a judgment call, not a read fact: recorded
          here rather than left to look like an oversight. */}
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
          "hidden pointer-fine:flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          HOVER_REVEAL_CLASSES,
        )}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>
      {/*
        Issue #253: Todoist's own scheduler — an anchored popover, not the
        bottom sheet this button used to open (`onOpenSchedule`, now reached
        only from Deadline/Priority). One `TaskSchedulePopover` instance per
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
      <TaskSchedulePopover
        open={scheduleOpen}
        onOpenChange={onScheduleOpenChange}
        dateDay={dateDay}
        dateTime={dateTime}
        onSetTime={setScheduleTime}
        dateString={task.dateString}
        datesWithTasks={detailActions.datesWithTasks}
        onPickDay={(day) => {
          setScheduleDay(day);
          // A plain date (or "No Date") ends any Recurrence the Task
          // already had — TaskSchedulePopover's own doc comment names
          // this a deliberate, disclosed design decision, mirrored here
          // from task-schedule-sheet.tsx's own former identical wiring.
          if (task.dateString !== null) {
            detailActions.onSetDateString(task.id, null, new Date().toISOString());
          }
        }}
        onPickRecurrence={(dateString) =>
          detailActions.onSetDateString(task.id, dateString, new Date().toISOString())
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
              "flex -my-1 size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
              HOVER_REVEAL_CLASSES,
              "aria-expanded:opacity-100",
            )}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        }
        onOpenDetail={() => detailActions.onOpenDetail(task)}
        onOpenDate={() => onScheduleOpenChange(true)}
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
