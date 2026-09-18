/**
 * A Task's own view (issue #178) — a route AND a modal/sheet at once,
 * this ticket's own reference behaviour: `role="dialog"` over a dimmed
 * background on a wide screen, a bottom sheet with a drag handle on a
 * narrow one, driven by the identical `useWideLayout()` `todo-nav.tsx`
 * and every other responsive component in this app already reads rather
 * than a bespoke breakpoint of this view's own. Built on Radix `Dialog`
 * directly (not `sheet.tsx`'s `Sheet`, which only ever renders the
 * bottom-anchored shape) — this is the one view in the app that has to be
 * *both* shapes depending on screen width, where every existing caller of
 * `Sheet` only ever wants one.
 *
 * **Description and Comments** (issue #180) sit directly under the
 * title, not in the attribute sidebar — that's the one reference-
 * behaviour departure from Project/Date/Deadline/Priority/Labels below,
 * which stay a sidebar of pills-or-rows. Description follows the
 * identical pill-then-row promotion those five already use
 * (`AttributePill`/`AttributeRow`'s own doc comments): unset, it's a
 * pill; once it has words, it's promoted into a rendered block, edited
 * in place by tapping it. Both a description and a Comment's own `text`
 * are Markdown, rendered by the identical renderer an Entry's body
 * already uses (`entryProse`, ../entry-prose.tsx) — this file writes no
 * second renderer for either.
 *
 * **Out of scope, deliberately** (issue #178's own report names these
 * rather than leaving them to look like oversights): the composer chip
 * that would open this route directly from a Sent checkbox (issue #181),
 * and duration — `Task.duration` is being removed in a concurrent ticket
 * (issue #179) and nothing here reads or renders it.
 *
 * **Activity** (issue #184, ADR 0056; relocated by issue #288) is no
 * longer a `<details>` disclosure sitting a few rows below Comments —
 * live-audited fixtures found 8 of a Task's 10 Activity entries were
 * comment events, so the same Comment a reader had just read in the
 * thread above reappeared, quoted, in a second disclosure right below
 * it. The owner's ratified fix is exact parity with Todoist: Activity
 * moves behind a **`View activity`** item in the header's overflow menu
 * (`TaskDetailOverflowMenu` below), in Todoist's own relative order
 * (after "Copy link to task," before "Delete task"), opening
 * `TaskActivityDialog` — the identical `ActivityFeed` content that used
 * to render inline, unchanged in wording, on the identical `events`
 * (still narrowed to this one Task by the caller — `listEventsByTask`,
 * entry-store-layout.tsx — the identical "the caller scopes it, this
 * view only renders" split `comments` above already takes). Comment
 * events are still rendered there — Todoist's own per-task activity
 * lists them too (CMT-06's "You commented {content} on {task}"), and
 * removing them would trade a matched parity row for a divergent one
 * while claiming to fix parity. What's actually fixed is the
 * adjacency: the two can no longer both be on screen at once.
 *
 * **Deadline and Priority open the identical `TaskScheduleSheet` every
 * row's own More-actions "Deadline…" item already opens** (`onOpenSchedule`
 * below) — the brief's own "Reuse what exists" instruction, applied
 * literally: this view has no second Deadline/Priority picker of its own
 * to keep in sync with the row's. Project and Labels have no existing
 * picker to reuse (neither TaskScheduleSheet nor anything else in this
 * app edits either), so this file builds the one inline control each
 * needs.
 *
 * **Date is the one exception (issue #253).** It no longer shares
 * `onOpenSchedule` at all — the sheet lost its own Date section entirely
 * — and instead opens its own `TaskSchedulePopover` instance
 * (`dateScheduleOpen` below), anchored directly under the Date attribute
 * itself, the identical per-site instance a row's own hover Date button
 * opens (`task-row-content.tsx`'s own doc comment). This view has exactly
 * one Task open at a time, so "per-site" here just means "owned by this
 * component," with no fan-in of its own to build: nothing else in this
 * view can open a Task's Date.
 */
import type { Comment, Event, Label, LocalDayKey, Project, Section, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Copy,
  History,
  Link2,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type * as React from "react";
import { forwardRef, Suspense, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { entryProse } from "@/components/entry-prose";
import { inlineProse } from "@/components/inline-prose";
import { LazyActivityFeed } from "@/components/todo/lazy-activity-feed";
import { LazyTaskDescriptionEditor } from "@/components/todo/lazy-task-description-editor";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { TaskSchedulePopover } from "@/components/todo/task-schedule-popover";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { useAutoGrowTextarea } from "@/hooks/use-auto-grow-textarea";
import { useTaskDateState } from "@/hooks/use-task-date-state";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { deviceUtcOffsetMinutes, formatClockTime, formatCommentTimestamp } from "@/lib/entry-day";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { isRenderableEvent } from "@/lib/is-renderable-event";
import { localDayKey } from "@/lib/local-day-key";
import type { QuickAddAutocompleteOptions } from "@/lib/quick-add-autocomplete";
import { useSettingsStore } from "@/lib/settings";
import { taskDetailPath } from "@/lib/task-detail-route";
import { priorityColour } from "@/lib/task-priority-colors";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";
import { cn } from "@/lib/utils";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";

/**
 * DET-16 (parity-ledger.md): live Todoist's own "Date updated to Tomorrow"
 * toast, with Undo, was present through 9,609ms and gone by 10,119ms after
 * Save (`rename-capture-2026-09-11.md`; flow 4, polled every ~500ms). 10s —
 * the same value the shared completion toast's own
 * `COMPLETION_TOAST_DURATION_MS` carries (`use-completion-toast.tsx`,
 * issue #355) — but this is still its own independent measurement, not a
 * reused constant: the two aren't sharing a source, they just happen to
 * match now that both have been corrected to ~10s.
 */
const RENAME_DATE_TOAST_DURATION_MS = 10_000;

export interface TaskDetailViewProps {
  task: Task;
  /** The Task's own Project, or `null` for Inbox — the breadcrumb's own first segment. */
  project: Project | null;
  /** The Task's own Section, or `null` — the breadcrumb's own second segment, present only alongside a non-null `project`. */
  section: Section | null;
  /** Every Project, for the "Move to…" attribute's own picker. */
  projects: Project[];
  /** Every Label, for the Labels attribute's own picker. */
  labels: Label[];
  /** The Task immediately before/after this one in whichever list the reader opened it from — `null` when there is none, which disables that chevron rather than hiding it (a reader mid-review of a list benefits from seeing "there's nothing further" as much as from the chevron itself). */
  prevTask: Task | null;
  nextTask: Task | null;
  onClose: () => void;
  /** Steps to `prevTask`/`nextTask` without closing (issue #178's own acceptance criterion) — the caller's job is to navigate to that Task's own address; this view never closes itself for a step. */
  onNavigate: (task: Task) => void;
  onRename: (content: string) => void;
  /**
   * Completes/un-completes this Task (issue #184's own gap-fix report) —
   * a real toggle, unlike `task-row.tsx`'s own checkbox, which never
   * renders a completed Task at all (a completed row leaves that list
   * entirely). This view has to render *both* states, since its own
   * address now resolves a completed Task too (`todo-page.tsx`'s own
   * `openTask` lookup), and "reachable but not actionable" is exactly
   * the half-feature the coordinator's own report refused to leave in
   * place. No recurring-Task Shift+Click distinction here — that
   * gesture is `task-row.tsx`'s own checkbox-specific shortcut for
   * "complete and archive the whole series"; this view's checkbox is a
   * plain toggle, and a recurring Task's own advance-vs-end choice stays
   * wherever the caller's own `onComplete` routes it (`todo-page.tsx`'s
   * `handleComplete`, unchanged).
   */
  onComplete: () => void;
  onUncomplete: () => void;
  /**
   * Copies this Task's own link (issue #302) — the header's overflow menu's
   * "Copy link to task" item, reusing `TaskDetailActions.onCopyLink`
   * (`task-row.tsx`'s own doc comment), the identical door the row's
   * `TaskCommandMenu` already opens onto the same capability. This view
   * takes zero arguments, not a `(task: Task) => void` — unlike that
   * bundle, this view already has exactly one Task in scope and no reason
   * to make every caller re-bind it.
   */
  onCopyLink: () => void;
  /**
   * Deletes this Task outright (issue #302) — the header's overflow menu's
   * "Delete task" item, reached only after this view's own `ConfirmDialog`
   * confirms (`TaskDetailBody`'s own doc comment on why that dialog lives
   * here rather than being left to whichever caller renders this view: a
   * caller can supply the real mutation, since this view already asks
   * before ever calling it, matching the row menu's identical two-step
   * shape). Deleting the Task this view is currently showing is what
   * closes it — this view calls no `onClose` of its own: `openTask`
   * (`todo-page.tsx`/`composer-page.tsx`) simply stops resolving once the
   * Task is gone, which is the identical mechanism a Task disappearing out
   * from under an open detail view already has to handle for a Sync-driven
   * delete from another Device.
   */
  onDelete: () => void;
  /**
   * Ends this Task's recurring series without deleting it (issue #302) —
   * exposes `task-row.tsx`'s own `onCompleteForever` (that prop's own doc
   * comment: "Shift+Click on the checkbox... and a dedicated button" are
   * its only two doors before this ticket) on a third surface, the detail
   * view's own overflow menu. Rendered there only when `task.dateString`
   * is non-null — a non-recurring Task has no series to end, the identical
   * gate the row's own dedicated button already applies
   * (`task-row-content.tsx`'s `isRecurring`).
   */
  onCompleteForever: () => void;
  /** Opens the shared `TaskScheduleSheet` — this file's own header comment on why Deadline/Priority funnel through the one door rather than each growing a picker of its own. Date no longer does (issue #253) — see `onSetDate`/`onSetDateString`/`datesWithTasks` below. */
  onOpenSchedule: () => void;
  /** Sets or clears the Task's `date` (issue #253) — reaches this view's own `TaskSchedulePopover` instance for the Date attribute, mirroring `task-row-content.tsx`'s identical wiring. */
  onSetDate: (id: string, date: string | null) => void;
  /** Sets or clears the Task's Recurrence phrase (issue #253) — `TaskStore.setDateString`'s own doc comment (task-schedule-sheet.tsx) has the reasoning for why `date` is recomputed by the store rather than trusted from a caller. `today` (not an instant — issue #296, `lib/local-day-key.ts`'s `localDayKey`) is what this view threads through below. */
  onSetDateString: (id: string, dateString: string | null, today: LocalDayKey) => void;
  /** Day-keys carrying at least one active Task, mapped to how many — threaded straight through to `TaskSchedulePopover`'s identical prop (its own doc comment: SCHED-09's calendar dot and SCHED-04's preview subline share this one source). */
  datesWithTasks: ReadonlyMap<string, number>;
  onSetProject: (projectId: string | null) => void;
  onSetLabels: (labelIds: string[]) => void;
  /** Sets the Task's `description` (issue #180) — `null` clears it back to "nothing chosen yet." */
  onSetDescription: (description: string | null) => void;
  /** This Task's own Comment thread, oldest first — already scoped to this Task by the caller (comment-counts.ts's `commentsForTask`), not the whole app's Comments. */
  comments: Comment[];
  /** Adds a new Comment to this Task. */
  onAddComment: (text: string) => void;
  onEditComment: (id: string, text: string) => void;
  onRemoveComment: (id: string) => void;
  /**
   * Issue #306: opens `CommentComposer` already expanded, with focus
   * placed in the field, instead of collapsed at rest (CMT-11's own doc
   * comment on that component has the full behaviour and the reasoning
   * for reusing its existing open/focus mechanism rather than adding a
   * new one). `todo-page.tsx` is the one caller that ever passes `true` —
   * read off the `?intent=reply` query parameter
   * (`hasCommentReplyIntent`, task-detail-route.ts) a Task row's comment
   * badge now links with. Optional, defaulting to the CMT-11 collapsed
   * rest state, so every other way of reaching this view (a title click,
   * "Copy link to task," an Activity row's own link, a bookmarked or
   * reloaded address) is unaffected.
   */
  openCommentComposer?: boolean;
  /**
   * This Task's own direct sub-tasks (issue #229) — already scoped by the
   * caller (`TaskStore.listChildren`), the identical "the caller scopes
   * it, this view only renders" split `comments`/`events` above already
   * take. Both active and completed children render here (a completed
   * sub-task still shows, struck through) — there is no separate
   * "completed sub-tasks" surface the way the main Task list has one.
   */
  subtasks: Task[];
  /** Creates a new sub-task directly under this Task (`AddTaskOverrides.parentId`, use-tasks.ts). */
  onAddSubtask: (content: string) => void;
  onCompleteSubtask: (id: string) => void;
  onUncompleteSubtask: (id: string) => void;
  /**
   * This Task's own history (issue #184), newest first — already scoped
   * to this Task by the caller (`listEventsByTask`), the identical split
   * `comments` above already takes. `projects` above (this file's own
   * "Move to…" picker) doubles as `ActivityFeed`'s own "moved to
   * <Project>" name resolution — no second list needed for it.
   */
  events: Event[];
}

/**
 * A Task's attribute, before it has one — a small, tappable pill rather
 * than an empty row (this file's own header comment: "the view grows with
 * the Task instead of showing empty fields").
 *
 * **`forwardRef`, since issue #253.** The Date attribute anchors a
 * `TaskSchedulePopover` directly to this pill via Radix `asChild`, which
 * clones this element and attaches a ref to it to measure where to
 * anchor — a plain function component (no `forwardRef`) would silently
 * swallow that ref the identical way `ui/button.tsx`'s own `Button` does
 * (`task-row-content.tsx`'s own doc comment has the fuller account of that
 * trap, found once already in this repo). `onClick` is optional now for
 * the identical reason: the Date attribute passes none — Radix's own
 * trigger click is what opens its popover — where Project/Deadline/
 * Priority/Labels below still pass one to toggle their own local picker.
 */
const AttributePill = forwardRef<HTMLButtonElement, { label: string; onClick?: () => void }>(
  function AttributePill({ label, onClick }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className="w-fit rounded-full border border-border px-2.5 py-1 text-muted-foreground text-xs transition hover:border-foreground/30 hover:text-foreground"
      >
        {label}
      </button>
    );
  },
);

/**
 * A Task's attribute, once it has one — promoted into its own full-width
 * row (this file's own header comment). `forwardRef` and an optional
 * `onClick` for the identical reason `AttributePill` above carries both —
 * the Date attribute, once set, is a promoted row like this one, and needs
 * the identical ref for its own `TaskSchedulePopover` trigger.
 */
const AttributeRow = forwardRef<
  HTMLButtonElement,
  {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    /** A leading dot in this colour — Priority's own ring colour, or a Project's/Label's own swatch. Omitted for Date/Deadline, which carry no colour of their own. */
    colour?: string;
    onClick?: () => void;
  }
>(function AttributeRow({ icon, label, value, colour, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted"
    >
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      >
        {colour !== undefined ? (
          <span className="size-2.5 rounded-full" style={{ backgroundColor: colour }} />
        ) : (
          icon
        )}
      </span>
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto truncate">{value}</span>
    </button>
  );
});

/**
 * One Comment in the thread (issue #180) — rendered inline, click to
 * edit in place, mirroring the Description block's own toggle between a
 * rendered view and a raw-Markdown textarea. A hover-revealed pencil/
 * trash pair rather than a swipe or a context menu: this file has no
 * other row chrome to match, and a Comment thread is short enough that
 * two small buttons cost nothing to keep visible on hover.
 *
 * **CMT-03: explicit Cancel/Update, not save-on-blur.** Todoist's own
 * comment editor (`meologue-reference/todoist/live-audit-dom/flow5-CMT-03-
 * todoist.json`) opens with those two buttons and never commits just
 * because focus left the field — clicking away leaves the draft sitting
 * there, unresolved, and only Cancel or Update decides its fate. The
 * live audit's own meologue side (`flow5-CMT-03-meologue.json`) is what
 * this replaces: a bare textarea whose `onBlur` committed, which meant
 * an edit could never actually be abandoned once the reader looked away
 * — clicking outside to reconsider silently saved a half-finished draft.
 * Deletion is untouched — both apps already agree there
 * (`ConfirmDialog`/CMT-03's own confirm-first note on `onRequestRemove`
 * below) — and neither app marks a Comment "edited," so this still
 * writes no such marker.
 *
 * **Escape used to look safe and wasn't.** The previous handler did
 * `setDraft(comment.text); event.currentTarget.blur()` — but `setDraft`
 * doesn't apply before `.blur()` fires, and `.blur()` fires the real
 * blur event synchronously, in the same tick, calling the old `onBlur`
 * commit handler while it was still closed over *this render's* `draft`
 * — the edited text, not the just-requested reset. Escape was
 * discarding nothing; it was saving the very edit it was meant to
 * cancel (a failing test guarded this before the fix — see this
 * comment's own commit message). `cancelEditing` below sidesteps the
 * whole flush question by closing the editor directly, with no blur in
 * the loop at all.
 *
 * **Escape also used to close the whole dialog, not just this editor.**
 * `cancelEditing`'s own Escape handler lived on the textarea's `onKeyDown`
 * — a normal React (bubble-phase, root-delegated) handler — which reads
 * as though `event.stopPropagation()` there would keep the keystroke from
 * ever reaching `TaskDetailView`'s Radix `Dialog`. It doesn't: Radix's own
 * Escape handling (`DismissableLayer`, inside `@radix-ui/react-dialog`)
 * listens on `document` in the CAPTURE phase, which runs BEFORE the
 * event ever reaches this textarea at all — by the time any handler here
 * could call `stopPropagation`/`preventDefault`, Radix has already read
 * `event.defaultPrevented`, found it false, and closed the dialog. Verified
 * directly against a real `Dialog` before writing this comment: neither
 * call, made from a nested field's own `onKeyDown`, stops the close.
 * The one node that sits earlier than `document` in the capture order is
 * `window` itself — a capture-phase listener registered there intercepts
 * Escape before capture ever reaches `document`, and (per the DOM's own
 * "stopping propagation mid-capture skips the target entirely" contract)
 * also means this textarea's own `onKeyDown` never sees that keystroke —
 * which is why `cancelEditing` is invoked directly from the effect below,
 * not left for the textarea to call. The effect is scoped to `editing`
 * so a reader who isn't mid-edit still closes the dialog on Escape
 * exactly as before.
 */
// How tall either comment field may grow before it scrolls inside itself.
// Roughly ten lines at this surface's own 14px/20px type — enough that an
// ordinary long comment is read and edited in full, short enough that the
// field never pushes the Comment/Cancel buttons off a laptop screen.
//
// The cap is also exactly Todoist's, measured rather than chosen to match:
// its own composer's computed `max-height` reads 200px, growing freely
// below that and scrolling internally above it
// (`detail-modal-todoist-2026-09-14.json`'s `longCommentBehavior`).
//
// The parenthetical that used to sit here — "it is not a pinned chat input"
// — stopped being true the moment the composer was pinned beneath the
// thread, and is dropped rather than left to mislead. The reason for a cap
// survives the change: the EDIT field still sits inside the scrolling
// thread, where an unbounded field would walk its own Cancel/Update buttons
// out of view.
const COMMENT_FIELD_MAX_HEIGHT = 200;

/**
 * Copied verbatim from `project-view.tsx`'s own menu items rather than
 * extracted into a shared module: this repo has no
 * `components/ui/dropdown-menu.tsx` wrapper, and the two menus using
 * `radix-ui`'s `DropdownMenu` directly is the established pattern here
 * (`project-view.tsx`, `labels-view.tsx`, `task-command-menu.tsx`).
 */
const menuItemClassName =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

function CommentRow({
  comment,
  onEdit,
  onCopyLink,
  onRequestRemove,
}: {
  comment: Comment;
  onEdit: (text: string) => void;
  /** CMT-09: "Copy link to comment" — the caller owns the address, exactly as `onRequestRemove` below owns the confirmation. */
  onCopyLink: () => void;
  /** CMT-03: deleting a Comment confirms first — this row never removes directly; it only asks its caller (`TaskDetailBody`'s own `ConfirmDialog`) to start that confirmation. */
  onRequestRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Seeded with the existing comment, so this has to size itself the moment
  // it mounts rather than on the first keystroke — a long comment opened for
  // editing used to appear as two rows of itself.
  useAutoGrowTextarea(editRef, draft, { maxHeight: COMMENT_FIELD_MAX_HEIGHT });
  // Recomputed per render rather than memoised: it depends on "what day is it
  // now", which a long-lived open dialog can outlive, and the formatting is a
  // single `Intl` call against a cached formatter.
  const offsetMinutes = deviceUtcOffsetMinutes();
  const timestamp = formatCommentTimestamp(
    comment.createdAt,
    localDayKey(new Date()),
    offsetMinutes,
  );

  function startEditing() {
    setDraft(comment.text);
    setEditing(true);
  }

  /**
   * "Copy text" copies the Comment's own Markdown source, not its rendered
   * prose — the same text `Edit` would put in the textarea, so copying and
   * pasting a Comment round-trips it unchanged. Toast wording and the
   * failure branch match `todo-page.tsx`'s own `copyTaskLink`, which is
   * this app's only other clipboard write.
   */
  function copyText() {
    navigator.clipboard?.writeText(comment.text).then(
      () => toast("Comment copied"),
      () => toast.error("Couldn't copy the comment"),
    );
  }

  /** Escape and Cancel both land here — discard the draft, close the editor, save nothing. No blur involved (this file's own header comment above on why routing through blur was the bug). */
  function cancelEditing() {
    setDraft(comment.text);
    setEditing(false);
  }

  /** Update's only path to `onEdit` — trims first, and a blank or unchanged draft commits nothing (CMT-03's own guard, carried over unchanged from the save-on-blur version this replaces). */
  function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed === "" || trimmed === comment.text) {
      setDraft(comment.text);
      return;
    }
    onEdit(trimmed);
  }

  // The "latest callback" ref pattern this file's own `TaskDetailBody`
  // (and `task-title-editor.tsx`) already use for an imperative listener
  // that outlives a single render — `cancelEditing` closes over this
  // render's `comment.text`, and the `window` listener below is only
  // re-attached when `editing` flips, not on every keystroke.
  const cancelEditingRef = useRef(cancelEditing);
  cancelEditingRef.current = cancelEditing;

  // This file's own header comment above ("Escape also used to close the
  // whole dialog") has the full account of why this listener lives on
  // `window`, in the capture phase, rather than on this row's own
  // textarea: it is the only point in the DOM earlier than Radix's own
  // `document`-capture Escape handler. Scoped to `editing` — mounted only
  // while this row's inline editor is open, torn down the instant it
  // closes — so an Escape pressed anywhere else in the dialog still
  // reaches Radix and closes it exactly as before.
  useEffect(() => {
    if (!editing) {
      return;
    }
    function handleWindowEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      // Stops the keystroke from ever reaching `document`'s own capture
      // listener — Radix never gets a chance to read `defaultPrevented`,
      // so there is nothing to `preventDefault()` here. This also means
      // the textarea's own `onKeyDown` below never fires for this key
      // (the DOM never delivers a stopped event to its target), so
      // `cancelEditing` has to be called from here directly.
      event.stopPropagation();
      cancelEditingRef.current();
    }
    window.addEventListener("keydown", handleWindowEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleWindowEscape, { capture: true });
  }, [editing]);

  if (editing) {
    return (
      <li className="flex flex-col gap-1.5">
        <textarea
          ref={editRef}
          aria-label="Edit comment"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-transparent p-2 text-sm outline-none"
        />
        {/* Todoist's own labels (this row exists to match it) — real accessible names via visible text, no separate aria-label needed. */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={cancelEditing}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm transition hover:bg-muted"
          >
            Update
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-1 rounded-md p-1.5 text-sm transition hover:bg-muted">
      {/* `break-words` because nothing else in this chain constrains a single
          unbroken token: a long URL or hash pasted into a comment would
          otherwise set the row's intrinsic width and push the dialog's own
          layout sideways rather than wrapping. `min-w-0` alone does not do
          it — that lets the flex child shrink, but the word still refuses to
          break. */}
      <div className="min-w-0 flex-1">
        {/* Todoist prints a timestamp on every comment — driven live
            2026-09-14, rendered as `Today 7:57 PM` at 12px beside the
            author's name. meologue had none at all, which is the half of
            that row it can close today: `createdAt` is already on every
            Comment. The author name and avatar Todoist shows alongside it
            are NOT added here — this app has no user identity to print
            (no display name, no avatar, and `Comment` carries only
            `deviceId`), and inventing one would be a product decision
            wearing a parity fix's clothes. */}
        {timestamp !== null && (
          <div className="text-[length:0.75rem] text-muted-foreground leading-4">{timestamp}</div>
        )}
        <div className="break-words [&_p]:my-0 [&_ul]:my-0">
          {entryProse(comment.text, undefined, undefined, undefined, "comment")}
        </div>
      </div>
      {/* CMT-09: Todoist reveals a "Comment options" menu on hover, whose
          four visible items are Edit / Copy text / Copy link to comment /
          Delete (driven live 2026-09-14,
          `detail-modal-todoist-2026-09-14.json`'s own
          `postedCommentAnatomy.commentOptionsMenu`). meologue showed a bare
          pencil/trash pair instead, which could carry Edit and Delete but
          had nowhere to put the two Copy actions — a third and fourth icon
          on every row is exactly the "wall of chrome" the row's own doc
          comment above was avoiding when it chose two.

          Todoist's sibling "Add a reaction" control is deliberately NOT
          built: this app has no user identity at all (a `Comment` carries
          only `deviceId`), so a reaction would have nobody to belong to.
          Recorded as a divergence rather than left to be rediscovered.

          The trigger keeps the row's existing hover-reveal treatment —
          always mounted, `opacity-0` until hover or focus — rather than
          Todoist's mount-on-hover, per ROW-12's own ratified decision that
          a control a keyboard reader cannot reach is worse than one that is
          merely invisible. */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Comment options"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-50 flex w-52 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
          >
            <DropdownMenu.Item className={menuItemClassName} onSelect={startEditing}>
              <Pencil aria-hidden="true" className="size-3.5" />
              Edit
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItemClassName} onSelect={copyText}>
              <Copy aria-hidden="true" className="size-3.5" />
              Copy text
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItemClassName} onSelect={onCopyLink}>
              <Link2 aria-hidden="true" className="size-3.5" />
              Copy link to comment
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={cn(
                menuItemClassName,
                "text-destructive data-highlighted:bg-destructive/10",
              )}
              onSelect={onRequestRemove}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

/**
 * **CMT-11: the composer is collapsed at rest** — a bar reading "Comment"
 * that opens into the real field on click, as Todoist's is.
 *
 * **This reverses issue #180's own reference-behaviour note** ("the
 * always-visible composer — never hidden behind an icon"), which is why
 * that sentence is gone from this comment rather than quietly contradicted
 * by the code beneath it. The owner took that decision on 2026-09-14 after
 * Todoist's own collapsed bar was measured; the reversal is argued in this
 * change's own commit message. Nothing here is hidden behind an *icon* in
 * the end — the bar carries the word "Comment" and is keyboard-reachable,
 * which was #180's actual concern.
 *
 * Every behaviour below was driven on live Todoist and read back
 * (`comment-behaviour-todoist-2026-09-14.json`), not reasoned about:
 *
 * - **Opening**: a click on the bar, or Tab to it and Enter. Focus lands
 *   *directly* in the field on both paths — proved there by object
 *   identity, not by matching a label.
 * - **Escape is two-stage, and this is the counter-intuitive part.** With
 *   the field EMPTY, one Escape collapses the composer silently and returns
 *   focus to the bar. With TEXT in it, Escape does **not** collapse and
 *   does **not** ask anything — it only blurs. A *second* Escape, now that
 *   focus has left the field, closes the whole Task modal, because nothing
 *   inside claimed the key any more. So the listener below stays out of the
 *   way the moment focus is not in the field: that is the entire mechanism,
 *   and it falls out of the same `window`-capture trick `CommentRow` above
 *   already documents at length (Radix reads Escape on `document` in the
 *   capture phase, so `window` is the only earlier seat).
 * - **Cancel is a genuinely different path**, not a faster Escape: one
 *   click collapses immediately AND discards the text.
 * - **Submitting does not re-collapse.** The field clears and stays open
 *   for the next Comment.
 * - **An outside click does not collapse it** — Todoist has no
 *   single-open-editor rule; its description editor can be open at once.
 * - **The submit button is never disabled and never greyed**, in either
 *   state, and clicking it while empty simply does nothing.
 *
 * **CMT-01: Ctrl/Cmd+Enter or the "Comment" button submits — Enter and
 * Shift+Enter both insert a newline.** This is the deliberate *opposite*
 * of the title field's own Enter-commits convention above
 * (`lifecycle.md`'s own header comment: "Two editors, two rules — do not
 * unify them"), so this composer's own `onKeyDown` only ever intercepts
 * the Mod+Enter chord, never plain Enter.
 *
 * Two of Todoist's own details are deliberately NOT reproduced, recorded
 * here so their absence reads as a decision rather than an oversight. Its
 * collapsed bar docks a paperclip that both opens the composer and raises a
 * file chooser — meologue has no attachments. And a draft abandoned by the
 * Escape cascade *survives* reopening the Task there; meologue's dialog
 * unmounts with the draft, and persisting it would need a store this app
 * does not have.
 *
 * **`initialExpanded` (issue #306).** A Task row's comment-count badge now
 * carries `?intent=reply` (ROW-08, task-row-content.tsx), Todoist's own
 * signal to land "in the thread, ready to reply" rather than merely on the
 * Task. `TaskDetailView`'s own `openCommentComposer` prop carries that
 * intent down to here, and this is read straight into `expanded`'s own
 * `useState` initialiser — not a separate "start focused" mechanism — so
 * the very first render already shows the open form instead of the
 * collapsed bar, and the "Opening" effect just below (keyed to `expanded`,
 * and firing on mount exactly as it fires on a later click, because a
 * dependency has nothing to have "changed" from yet) lands focus in the
 * field the identical way a manual click does. Deliberately NOT "expand
 * collapsed, then separately call `.focus()`": that would be a second
 * behaviour to keep in sync with the one this component already has and
 * already tested, for an outcome — an open, focused field — this prop
 * produces for free by choosing where `expanded` starts.
 * `TaskDetailView`'s Radix `Content` also claims focus once on mount
 * (`onOpenAutoFocus`, that file's own doc comment) — this composer's own
 * effect is a plain (not layout) `useEffect`, so it commits after that
 * dialog-level focus, the same ordering that already makes a later manual
 * click override whatever else has focus.
 */
function CommentComposer({
  onSubmit,
  initialExpanded = false,
}: {
  onSubmit: (text: string) => void;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLButtonElement>(null);
  // Measured on the device before this: the field stayed 37.4px tall whether it
  // was empty, holding ~500 characters, or holding ~2000, while `scrollHeight`
  // for those same contents read 276px and 1016px. `resize: none` (this app's
  // convention for a field it lays out itself) meant it could not be dragged
  // bigger either, so a long comment was written into a one-line slot showing
  // about a twenty-seventh of itself.
  useAutoGrowTextarea(fieldRef, text, { maxHeight: COMMENT_FIELD_MAX_HEIGHT });

  // Focus lands directly in the field on BOTH opening paths (click and
  // Tab-then-Enter) — Todoist's own, proved there by object identity.
  // Keyed to `expanded` so it fires on the transition, never on a keystroke.
  useEffect(() => {
    if (expanded) {
      fieldRef.current?.focus();
    }
  }, [expanded]);

  /** Cancel's path, and Escape's when the field is empty: close the editor, keep nothing. */
  function collapse() {
    setText("");
    setExpanded(false);
  }

  // The `window` capture-phase seat, for exactly the reason `CommentRow`'s
  // own header comment above sets out in full: Radix's `DismissableLayer`
  // reads Escape on `document` in the CAPTURE phase, so by the time a
  // handler on this textarea could call `stopPropagation`, the dialog has
  // already decided to close. `window` is the one node earlier than that.
  //
  // The two-stage mechanism is the `activeElement` check. While focus is IN
  // the field this claims the key — collapsing if empty, blurring if not.
  // The moment focus is anywhere else, it returns without claiming, and the
  // keystroke reaches Radix and closes the Task modal. That is precisely
  // what live Todoist does, and it needs no second listener to express.
  // The same "latest callback" ref pattern `CommentRow` above already uses,
  // and for the identical reason: naming `collapse` in the dependency list
  // would re-attach this listener on every keystroke, because it is a fresh
  // function each render. The text goes through a ref too, so the listener
  // reads what is in the field NOW rather than what was there when it was
  // attached.
  const stateRef = useRef({ text, collapse });
  stateRef.current = { text, collapse };
  useEffect(() => {
    if (!expanded) {
      return;
    }
    function handleWindowEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || document.activeElement !== fieldRef.current) {
        return;
      }
      event.stopPropagation();
      if (stateRef.current.text === "") {
        stateRef.current.collapse();
        // Focus returns to the bar the composer just collapsed into, so a
        // keyboard reader is left where they started rather than at the
        // top of the document.
        window.requestAnimationFrame(() => barRef.current?.focus());
        return;
      }
      // Text present: blur only. No collapse, no confirmation, no discard —
      // the draft stays exactly where it was, and the NEXT Escape closes
      // the Task modal because this listener no longer claims it.
      fieldRef.current?.blur();
    }
    window.addEventListener("keydown", handleWindowEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleWindowEscape, { capture: true });
  }, [expanded]);

  function submit() {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    onSubmit(trimmed);
    // Cleared but NOT collapsed — Todoist leaves the form open and empty,
    // ready for the next Comment.
    setText("");
  }

  if (!expanded) {
    return (
      <button
        ref={barRef}
        type="button"
        aria-label="Open comment editor"
        onClick={() => setExpanded(true)}
        className="w-full rounded-md border border-border px-2 py-2 text-left text-muted-foreground text-sm transition hover:bg-muted"
      >
        Comment
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2"
    >
      <textarea
        ref={fieldRef}
        aria-label="Add a comment"
        placeholder="Add a comment"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        rows={1}
        className="min-w-0 flex-1 resize-none rounded-md border border-border bg-transparent p-2 text-sm outline-none"
      />
      {/* Todoist's own labels and order — Cancel left of the submit, both
          real accessible names from their visible text. The submit stays
          enabled and un-greyed even with an empty field, measured in both
          states; `submit()` above is what makes clicking it then a no-op,
          rather than a `disabled` attribute the reference does not have. */}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          aria-label="Close comment editor"
          onClick={collapse}
          className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm transition hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm transition hover:bg-muted"
        >
          Comment
        </button>
      </div>
    </form>
  );
}

/**
 * "Added on 26 Aug 10:37 AM" (issue #302) — the wording and shape Todoist's
 * own overflow menu was measured carrying live
 * (`meologue-reference/todoist/parity-ledger-android.md`'s ADET-02/
 * ADET-15 rows: day-then-month, no year, followed by a clock time).
 * `task.createdAt` is a real UTC instant (`task-types.ts`'s own doc
 * comment on the field), so this composes the identical two formatters
 * `formatCommentTimestamp` above already composes for a Comment's own
 * timestamp — `formatDay` (this file's own "d MMM", year-less by design)
 * off the LOCAL day the instant falls on (`localDayKey(new Date(...))`,
 * not a UTC slice of the string), plus `formatClockTime`'s identical
 * clock. Returns `null` for a value `Date` can't parse, the same
 * "say nothing rather than something wrong" `formatCommentTimestamp`
 * already follows.
 */
function formatAddedOn(createdAt: string): string | null {
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const clock = formatClockTime(createdAt);
  if (clock === null) {
    return null;
  }
  return `Added on ${formatDay(localDayKey(parsed))} ${clock}`;
}

const overflowItemClassName =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

/**
 * The detail sheet's own `⋮` overflow menu (issue #302) — Copy link,
 * Delete and (recurring Tasks only) Complete forever, plus a non-
 * interactive "Added on …" stamp. This is a second, narrower
 * `DropdownMenu.Root` alongside `TaskCommandMenu`'s (task-command-menu.tsx),
 * not that component reused wholesale: that menu's own seven items —
 * Edit, Date…, Priority, Deadline…, Labels, Move to… — either have no
 * meaning here (Edit is this whole view; there is no second "Move to…"
 * picker to keep in sync with the sidebar's own Project attribute a few
 * lines below) or would need a parallel, harder-to-follow prop surface on
 * this file just to reach three items this ticket actually asks for. The
 * three real actions below still call back into this app's existing
 * TaskStore doors — `onCopyLink`/`onDelete`/`onCompleteForever`
 * (`TaskDetailViewProps`'s own doc comments) — the identical mutations
 * `TaskCommandMenu`'s own "Copy link to task"/"Delete" items and the row's
 * dedicated Complete-forever button already call, not a parallel set
 * built for this surface.
 */
function TaskDetailOverflowMenu({
  task,
  open,
  onOpenChange,
  onCopyLink,
  onOpenActivity,
  onCompleteForever,
  onRequestDelete,
  triggerRef,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyLink: () => void;
  onOpenActivity: () => void;
  onCompleteForever: () => void;
  onRequestDelete: () => void;
  /** `TaskDetailBody`'s own `overflowTriggerRef` — where `TaskActivityDialog`'s own `onCloseAutoFocus` sends focus back to, since the `DropdownMenu.Item` that actually opened it is gone the moment this menu closes. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  // A recurring Task never actually carries `completedAt` alongside a
  // non-null `dateString` (`TaskStore.completeForever`/`advanceRecurring`'s
  // own mechanics both clear `dateString` the moment a recurring Task's
  // series ends), so this reads as belt-and-braces against
  // `task-row-content.tsx`'s identical `isRecurring && !isCompleted` gate
  // on its own dedicated button, not a case this file has actually
  // observed happening on its own.
  const isRecurring = task.dateString !== null && task.completedAt === null;
  const addedOn = formatAddedOn(task.createdAt);
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label="Task actions"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:opacity-100"
        >
          <MoreVertical aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-50 flex w-56 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
        >
          {addedOn !== null && (
            <>
              <p className="px-2 py-1.5 text-muted-foreground text-xs">{addedOn}</p>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <DropdownMenu.Item className={overflowItemClassName} onSelect={onCopyLink}>
            <Copy aria-hidden="true" className="size-3.5" />
            Copy link to task
          </DropdownMenu.Item>
          {/* Issue #288: relocated off the detail screen body (this file's
              own header comment has the full account of why) into
              Todoist's own overflow position — after "Copy link to task,"
              before "Delete task," true whether or not "Complete forever"
              is present below, since Todoist's own menu has no equivalent
              of that item to anchor against.

              Unconditional, deliberately (#337's own active bug class is an
              unexplained behaviour change, so this is recorded rather than
              left implicit): the old inline disclosure it replaces only
              rendered `renderableEvents.length > 0`, but Todoist's own
              overflow menu carries "View activity" as a static item,
              present whether or not a Task has any history yet — there is
              no live capture of Todoist hiding it at zero Events. Selecting
              it at zero Events opens `TaskActivityDialog` on
              `ActivityFeed`'s own default `emptyMessage`, "Nothing here
              yet." — a real, readable state, not a blank dialog. */}
          <DropdownMenu.Item className={overflowItemClassName} onSelect={onOpenActivity}>
            <History aria-hidden="true" className="size-3.5" />
            View activity
          </DropdownMenu.Item>
          {isRecurring && (
            <DropdownMenu.Item className={overflowItemClassName} onSelect={onCompleteForever}>
              <CheckCheck aria-hidden="true" className="size-3.5" />
              Complete forever
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className={cn(
              overflowItemClassName,
              "text-destructive data-highlighted:bg-destructive/10",
            )}
            onSelect={onRequestDelete}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            Delete task
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Issue #288's own surface — everything `ActivityFeed` used to render
 * inline (this file's own header comment has the full account) now
 * renders here instead, opened by the header's own "View activity"
 * overflow item rather than a `<details>` a reader had to notice and
 * expand a few rows below Comments.
 *
 * Built on the shared `ui/dialog.tsx` (`@/components/ui/dialog`, issue
 * #342's own focus-restore wrapper around the Radix `Dialog` primitive:
 * `Dialog`/`DialogContent` below), matching the outer `TaskDetailView`'s
 * own instance below and
 * `task-custom-repeat-dialog.tsx`'s identical choice) rather than
 * `ConfirmDialog` (`alert-dialog.tsx`) — that component's whole shape is
 * a fixed title/description/Cancel/destructive-action, with no slot for
 * arbitrary content, so reusing it here would mean stretching a
 * confirm-before-you-act modal to hold a scrolling feed it was never
 * built to.
 *
 * **The count lives here, not on the menu item.** Todoist's own "View
 * activity" item carries no count, nor does any other item in this
 * menu (`TaskDetailOverflowMenu` above) — "Copy link to task," "Delete
 * task" — so putting one on the menu item would be decoration Todoist
 * itself doesn't show. `Activity (N)` — the exact wording the old inline
 * `<summary>` used — survives as this dialog's own `DialogTitle`
 * instead, which Radix also uses as the Dialog's accessible name,
 * so a reader who opens it still sees the same count they used to see
 * collapsed, just one tap later rather than always on screen.
 *
 * **No avatar, deliberately (issue #288's own explicit carve-out).**
 * Todoist renders a round user avatar beside each comment event; this
 * app has exactly one user, so an avatar would identify nobody —
 * `ActivityFeed` never grew one, and this dialog adds no chrome of its
 * own that would need one either.
 *
 * **`onCloseAutoFocus` sends focus back to the `Task actions` trigger.**
 * Live-measured: `Task actions` -> `View activity` -> Escape left
 * `document.activeElement` on `BODY` with the detail dialog still open,
 * before this override existed — the identical Radix default the
 * discard `ConfirmDialog` above already works around (that dialog's own
 * comment has the full mechanics: a dialog with no `Dialog.Trigger` in
 * its ancestry gives Radix's own close-autofocus default nothing to
 * return to). This dialog's own trigger — the `DropdownMenu.Item` a
 * reader actually clicked — is unmounted the instant the overflow menu
 * closes, before this dialog's own open animation even starts, so the
 * one stable, still-mounted place focus can meaningfully return to is
 * `triggerRef`: the header's own `Task actions` button, which is where
 * the reader really was.
 */
function TaskActivityDialog({
  open,
  onOpenChange,
  events,
  task,
  projects,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already narrowed to renderable events by the caller (`TaskDetailBody`'s own `renderableEvents`) — this dialog trusts that count for its own Title rather than re-filtering, the identical "the caller scopes it, this view only renders" split the rest of this file already takes. */
  events: Event[];
  task: Task;
  projects: Project[];
  /** `TaskDetailBody`'s own `overflowTriggerRef` — see this component's own doc comment above for why it, not the menu item that opened this dialog, is `onCloseAutoFocus`'s target. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogContent
          open={open}
          aria-describedby={undefined}
          data-testid="task-activity-dialog"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          // `restoreFocusTo`, not the wrapper's own generic captured-
          // previously-focused-element default — this component's own
          // header comment above (`triggerRef`'s doc comment) is why: the
          // real previously-focused element (the `DropdownMenu.Item` a
          // reader clicked) is gone the instant the overflow menu closes,
          // before this dialog's open animation even starts, so the
          // generic capture would be capturing the wrong, about-to-vanish
          // thing. `DialogContent` still supplies the gone-at-close
          // fallback this hand-written handler never had, if `triggerRef`
          // itself somehow isn't there by the time this dialog closes.
          restoreFocusTo={triggerRef}
        >
          <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
            <DialogTitle className="text-sm font-medium text-foreground">
              Activity ({events.length})
            </DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close activity"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </DialogClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* `open &&`, not just Radix `Dialog`'s own Presence-gated
              unmounting of closed content — `lazy-activity-feed.ts`'s own
              header comment on why this dialog doesn't lean on the
              library alone to keep `LazyActivityFeed`'s `import()` from
              firing before a reader ever chooses "View activity". */}
            {open && (
              <Suspense
                fallback={
                  <p className="px-3 py-6 text-center text-muted-foreground text-sm">
                    Loading activity…
                  </p>
                }
              >
                <LazyActivityFeed
                  events={events}
                  // CMT-06: no `currentTaskId` — carried over verbatim from
                  // the old inline disclosure (this file's own header
                  // comment). Flow 5 read Todoist's own per-task activity and
                  // it names the task in every line ("You completed {task}",
                  // "You deleted a comment from {task}"), even though every
                  // line is about that task, so suppressing the subject here
                  // was the divergence itself. `tasks` holds this task so its
                  // subject resolves.
                  tasks={[task]}
                  projects={projects}
                />
              </Suspense>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function TaskDetailBody({
  task,
  project,
  section,
  projects,
  labels,
  prevTask,
  nextTask,
  onClose,
  onNavigate,
  onRename,
  onComplete,
  onUncomplete,
  onCopyLink,
  onDelete,
  onCompleteForever,
  onOpenSchedule,
  onSetDate,
  onSetDateString,
  datesWithTasks,
  onSetProject,
  onSetLabels,
  onSetDescription,
  comments,
  onAddComment,
  onEditComment,
  onRemoveComment,
  openCommentComposer,
  subtasks,
  onAddSubtask,
  onCompleteSubtask,
  onUncompleteSubtask,
  events,
  wide,
  contentRef,
  dismissGuardRef,
}: TaskDetailViewProps & {
  wide: boolean;
  /**
   * DET-10: the dialog Content node itself (`TaskDetailView`'s own
   * `contentRef`, which Radix already gives `tabIndex={-1}`) — the one
   * neutral focus target that matches live Todoist's own "a generic
   * click in the combined edit form focuses the dialog, neither field"
   * finding (`parity-ledger.md`'s DET-10 row, flow 5's DOM-identified
   * gap click). Threaded down rather than duplicated: `TaskDetailView`
   * already owns the ref Radix needs for `onOpenAutoFocus`, and this is
   * the same node, not a second one.
   */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /**
   * DET-15: `TaskDetailView`'s own hook into this form's dismissal claim,
   * consulted from `Content`'s composable `onEscapeKeyDown`/
   * `onPointerDownOutside` props (that file's own doc comment on the
   * prop). Called with no arguments; returns `true` when this form wants
   * the attempt (editing, whether or not there are unsaved changes — see
   * this file's assignment of it below), which is `TaskDetailView`'s own
   * signal to `preventDefault()` so Radix's `DismissableLayer` never
   * dismisses the whole view for an interaction this form claimed first.
   * A ref rather than a prop read once: `TaskDetailView` calls
   * `dismissGuardRef.current?.(source)` from a stable handler it hands to
   * Radix at mount, so this needs to stay current across every render
   * without that handler itself changing identity. `source` distinguishes
   * an outside click from Escape (DET-15 round 3's own gap): the two now
   * disagree on what Discard does afterward — outside click closes the
   * whole view, Escape does not — so this door needs to know which one
   * it's answering, not just that a dismissal was attempted.
   */
  dismissGuardRef: React.RefObject<((source: "escape" | "outside") => boolean) | null>;
}) {
  // DET-09: editing is task-wide, not field-wide — clicking either the
  // title or the description puts BOTH into edit together, sharing one
  // Cancel/Save pair (below), replacing the pre-#229 shape where each
  // field owned its own `editingTitle`/`editingDescription` flag and
  // committed independently on blur. `focusField` is DET-10's own focus
  // trap, reproduced deliberately: the description's own click target
  // (the pill, or the rendered block) is the only entry point that lands
  // focus on the description; every other entry point into this form —
  // today, only the title's own display button — lands on the title, the
  // identical hazard lifecycle.md's own "Focus trap" finding names.
  const [editing, setEditing] = useState(false);
  const [focusField, setFocusField] = useState<"title" | "description">("title");
  const [titleDraft, setTitleDraft] = useState(task.content);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? "");
  // DET-07: the identical recognition plugin `add-task-form.tsx` passes
  // its own field, attached to `task-title-editor.tsx`'s `extraPlugins`
  // seam (that file's own header comment names it) so a phrase typed
  // while renaming a Task renders the same `inline-block` span, padding
  // and `data-match-id` the composer already produces — #225 built the
  // seam, #226 built the plugin, and until now nothing in this view
  // attached it. `smartDates`/`now` are read live via a ref, matching
  // `add-task-form.tsx`'s own reasoning: `extraPlugins` is read once, at
  // the title editor's mount, while a `smartDates` toggle or a midnight
  // date rollover mid-rename should not need the editor itself torn down
  // and rebuilt to see it.
  //
  // What this file still does NOT do: `saveEditing` below still commits
  // `titleText`/`titleDraft` verbatim, unparsed, and hands that string
  // straight to its own `onRename` prop unaware anything downstream might
  // read it differently — this plugin only decorates what the reader sees
  // while typing. Issue #247 is what moved resolution into the picture at
  // all, and deliberately one layer up: todo-page.tsx's and
  // composer-page.tsx's own `commitRename` wrappers are what `onRename`
  // actually is now, each reaching `commitTaskTitle` (task-title-commit.ts)
  // to resolve the same phrase this plugin already highlighted into real
  // Date/Deadline/Priority/recurrence/Label fields before ever touching
  // the store. This view's own contract — `onRename: (content: string) =>
  // void`, a plain string in, nothing back out — is exactly why that
  // seam works: it never needed to know resolution was about to start
  // happening on the other side of it. DET-08 (the Date attribute row
  // reads `task.date`, never the title editor's own live state) is what
  // that seam makes possible — the field this view shows still comes from
  // the Task the store hands back down, not from anything this file
  // parsed itself.
  //
  // The reference is no longer silent on this either, as an earlier
  // version of this comment said: `meologue-reference/todoist/rename-capture-
  // 2026-09-11.md` drove both of Todoist's own rename surfaces directly
  // and found both resolve a recognised phrase, stripping it from the
  // stored title exactly as Quick Add does — the parity ledger's own
  // DET-07 row cites it. That capture did not exercise a phrase that
  // fails to resolve, or a rename with no phrase at all, so the guard
  // below (only ever *set* a field a phrase actually resolved, never
  // clear one the reader didn't touch) is still this app's own
  // conservative choice, not something that capture proves Todoist does
  // too.
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);
  const titleRecognitionOptionsRef = useRef({ now: localDayKey(new Date()), smartDates });
  titleRecognitionOptionsRef.current = { now: localDayKey(new Date()), smartDates };
  // QA-14's own second half, wired into the detail title: the `#`/`@`
  // autocomplete popup needs a create hook (`addProject`/`addLabel`) that
  // `TaskDetailViewProps` has no field for — `projects`/`labels` above
  // already cover the list half (the identical arrays the Project/Labels
  // attribute pickers already use). Reading `useOutletContext` directly
  // here, the same door `task-row-content.tsx`'s own identical wiring
  // uses (that file's own doc comment has the fuller account of why: this
  // view only ever renders inside `todo-page.tsx`'s or `composer-page.tsx`'s
  // own subtree, both children of `EntryStoreLayout`'s `<Outlet
  // context={...}>`, so this is the exact context `useEntryStore()` itself
  // is built on) — not a new prop on `TaskDetailViewProps`, which would
  // need `todo-page.tsx` and `composer-page.tsx` (both owned by another
  // agent mid-rebuild) to grow it. `useOutletContext` is plain
  // `React.useContext` underneath, so it's safe with no `<Outlet>`
  // ancestor at all — `task-detail-view.test.tsx`'s existing suite (no
  // Router anywhere in it) keeps working unchanged, reading `undefined`
  // here and falling through to "Create only inserts the token" exactly as
  // `QuickAddAutocompleteOptions`'s own doc comment already allows.
  const autocompleteOutlet = useOutletContext<EntryStoreOutletContext | undefined>();
  const titleAutocomplete: QuickAddAutocompleteOptions = {
    getProjects: () => projects,
    getLabels: () => labels,
    onCreateProject: autocompleteOutlet?.addProject,
    onCreateLabel: autocompleteOutlet?.addLabel,
  };
  // DET-15: whether the popup above is currently open — fed by
  // `TaskTitleEditor`'s own `onAutocompleteOpenChange` (task-title-
  // editor.tsx) below, read from `dismissGuardRef`'s own assignment
  // further down. A ref, not state: nothing here needs to re-render when
  // this flips, only to have the CURRENT answer available the instant
  // Radix's Escape handling asks for it, which happens synchronously
  // inside the same keydown Radix's own `document`-capture listener sees
  // — see that assignment's own comment for why this ref is guaranteed to
  // still read `true` at that moment even though the popup is about to
  // close.
  const autocompletePopupOpenRef = useRef(false);
  // DET-15's own real fix, discovered rather than merely reasoned about
  // (`dismissGuardRef`'s own assignment below has the proof): Radix's
  // `Dialog.Content` calls `onEscapeKeyDown` from a `document`-level,
  // capture-phase listener — strictly before this same event ever reaches
  // `TaskTitleEditor`'s own keydown handling, since a browser always runs
  // an ancestor's capture-phase listener before any listener bound
  // directly to a descendant target. Calling `event.preventDefault()`
  // there (needed to keep Radix from closing the whole Dialog) makes
  // `prosemirror-view`'s own dispatch gate refuse to run ANY of this
  // editor's key handling for that same event afterward — its own
  // autocomplete plugin included — so the popup can no longer be trusted
  // to close itself. `closeAutocompleteRef` (`task-title-editor.tsx`'s own
  // doc comment on it) is a plain `view.dispatch()` call, not a DOM event,
  // so it is never subject to that gate — this is what lets the guard
  // below close the popup for real in the same synchronous tick it also
  // calls `preventDefault()`.
  const closeAutocompleteRef = useRef<(() => void) | null>(null);
  // A literal id, not `useId()`: only one `TaskDetailView` is ever mounted
  // at a time (it's a modal over the whole app), so there is no second
  // instance for a fixed id to collide with.
  const titleHintId = "task-detail-title-hint";
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingLabels, setPickingLabels] = useState(false);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  // Issue #302: the header's own `⋮` overflow menu, and the "Delete task?"
  // confirmation its own "Delete task" item opens — a second, dedicated
  // dialog rather than reusing `todo-page.tsx`'s own `confirmingId`/
  // `ConfirmDialog` pair: that pair lives at the PAGE level (only
  // `todo-page.tsx` renders it), where `composer-page.tsx`'s own
  // `TaskDetailView` instance has never needed one before this ticket.
  // Owning it here, mirroring `confirmingCommentId`/`discardConfirmOpen`
  // just above, is what makes it work identically for both callers rather
  // than needing `composer-page.tsx` to grow page-level delete-confirm
  // machinery of its own just to match.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Issue #288: "View activity," the overflow item that replaces the old
  // inline Activity disclosure — one boolean, mirroring `deleteConfirmOpen`
  // right above, since `TaskActivityDialog` below is the identical
  // "owned here, opened by an overflow item" shape Delete's own confirm
  // already is.
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);
  // Live-measured regression (code review + a real re-drive, both on this
  // ticket): `Task actions` -> `View activity` -> Escape left
  // `document.activeElement` on `BODY` while the detail dialog was still
  // open — a keyboard/screen-reader user dropped to the top of the
  // document rather than back at the control they were just on. This is
  // the identical Radix default `discardConfirmOpen`'s own
  // `onCloseAutoFocus` below already works around (that dialog's own
  // comment cites the live capture, `flow11-R3-DET-15-both.json`, for
  // why): a dialog opened imperatively, with no `Dialog.Trigger` in its
  // ancestry, has nothing for Radix's own close-autofocus default to
  // return focus TO. `TaskActivityDialog` is exactly that shape — opened
  // from a `DropdownMenu.Item` that's already unmounted (the menu itself
  // closes first) by the time this dialog closes — so it needs the
  // identical explicit target `contentRef`/`lastFocusedEditorRef` already
  // give their own callers. The `Task actions` trigger button itself is
  // that target here: threaded down the same way `contentRef` already is
  // ("threaded down rather than duplicated" — `TaskDetailBody`'s own
  // `contentRef` prop doc comment) rather than a second ref this file
  // would have to keep in sync with it.
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  // CMT-03: deleting a Comment confirms first (ours used to delete with no
  // confirmation at all) — one dialog for the whole thread, named by which
  // Comment it's currently open for, mirroring `todo-page.tsx`'s own
  // `confirmingId`/`ConfirmDialog` pair for deleting a Task.
  const [confirmingCommentId, setConfirmingCommentId] = useState<string | null>(null);
  /**
   * CMT-09's "Copy link to comment". meologue has no per-Comment route, so
   * the address is this Task's own detail URL plus a `#comment-<id>`
   * fragment: `taskIdFromParam` (task-detail-route.ts) reads only the
   * trailing uuid of the path segment, so the fragment rides along without
   * disturbing resolution, and a reader who opens the link lands on the
   * Task holding the Comment. **The fragment is not yet a scroll target** —
   * nothing reads it on mount — so this copies a durable address, not a
   * jump-to-comment. Recorded that way rather than claiming more than it
   * does.
   *
   * Origin, toast wording and the failure branch all match
   * `todo-page.tsx`'s own `copyTaskLink`, which this is the Comment-scoped
   * sibling of.
   */
  function copyCommentLink(comment: Comment) {
    const url = `${window.location.origin}${taskDetailPath(task)}#comment-${comment.id}`;
    navigator.clipboard?.writeText(url).then(
      () => toast("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  }
  // DET-15: the shared discard-confirm dialog for the title/description
  // form — one boolean, not one per field, since DET-09 already made
  // Cancel/Save a single pair for both fields together; asking twice
  // (once per field) would be asking about a boundary this form no
  // longer has.
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // DET-15 round 3: which gesture opened the discard confirmation —
  // Todoist's own live re-drive found this actually matters for what
  // Discard does next (`flow11-R3-DET-15-both.json`'s
  // `attempt3_clickOutsideModal`). An outside click's own intent was
  // "leave the task," so confirming Discard there completes that intent
  // and closes the whole view too; Cancel and Escape carry no such
  // intent beyond "stop editing," so Discard there only ends editing,
  // matching this file's pre-existing behaviour. Read once, at the
  // moment `onConfirm` fires below — a plain ref, not state, since
  // nothing here needs a re-render when it changes.
  const cancelTriggeredByOutsideClickRef = useRef(false);
  // DET-15 round 3, gap 2: sets when Discard itself was clicked, so the
  // discard ConfirmDialog's own `onCloseAutoFocus` below can tell "this
  // close is a Discard" (editing is ending or the whole view is closing —
  // nothing to refocus) apart from "this close is a Cancel/Escape on the
  // confirmation itself" (editing continues — focus belongs back on
  // whichever editor the reader was last in).
  const discardConfirmedRef = useRef(false);
  // DET-15 round 3, gap 2: the editor element the reader was last typing
  // in, tracked via a `focusin` listener on the edit column below rather
  // than read from `document.activeElement` at confirm-dismiss time —
  // by the time the confirmation (a separate, now-closing Radix layer)
  // hands focus back, the field itself has already lost it, so there's
  // nothing left in `document.activeElement` worth reading.
  const lastFocusedEditorRef = useRef<HTMLElement | null>(null);
  const editColumnRef = useRef<HTMLDivElement>(null);
  // ActivityFeed drops old "Edited a comment" events (CMT-06), so the badge
  // counts what it will actually show rather than what the store holds.
  const renderableEvents = events.filter(isRenderableEvent);
  const uiPriority = uiPriorityOf(task.priority);
  // Issue #224: computed once, not inline in the Date row's own `value`
  // JSX below, so `text`/`colour` can't drift from calling
  // `formatTaskDate` a second time with different `options` by accident.
  const dateDisplay =
    task.date === null
      ? null
      : formatTaskDate(task.date, {
          completed: task.completedAt !== null,
          recurring: task.dateString !== null,
        });
  // Issue #256: this view's own `TaskSchedulePopover` instance for the
  // Date attribute reads `task.date` split into day/time through
  // `useTaskDateState` — the identical hook `task-row-content.tsx`'s own
  // popover instance also consumes, rather than the two files each
  // carrying their own copy of the split and combine (issue #253's
  // wiring, byte-identical between them, is what #256 closed).
  const [dateScheduleOpen, setDateScheduleOpen] = useState(false);
  const { dateDay, dateTime, setScheduleDay, setScheduleTime } = useTaskDateState(task, onSetDate);

  // DET-16: `saveEditing` below hands the raw typed title straight to its
  // `onRename` prop and gets nothing back — resolving a recognised phrase
  // into a real Date happens one layer up, in `todo-page.tsx`'s/
  // `composer-page.tsx`'s own `commitRename` wrapper (`commitTaskTitle`,
  // task-title-commit.ts), asynchronously (its Task-store write is a
  // `useMutation`, not an optimistic cache write — hooks/use-tasks.ts's
  // own `setDateMutation`). So the only way this view can tell a rename
  // just resolved a Date is by watching its own `task.date` prop for the
  // change that wrapper eventually produces, against a snapshot taken
  // the instant a title-changing Save fired. `previousDate` carries the
  // full `Task.date` string (day and time-of-day both, when present),
  // not just the day, since Undo below has to restore both.
  //
  // This is a heuristic, not a closed loop back to the specific rename
  // that triggered it — nothing in this view's own contract (`onRename`
  // returns `void`) can make it one. The risk that heuristic carries: an
  // unrelated `task.date` change arriving in this same window (a
  // completely separate edit, mid-flight for some other reason) would be
  // misread as this rename's own effect. The three sites in this file
  // that change `task.date` directly — `onPickDay`/`onSetTime`/
  // `onPickRecurrence` below, all reached through this view's own Date
  // attribute — clear this ref first, precisely so an explicit, reader-
  // driven date edit can never be mistaken for a rename's side effect.
  const pendingRenameDateRef = useRef<{ taskId: string; previousDate: string | null } | null>(null);

  // DET-16: the toast itself — same mechanism `todo-page.tsx`'s own
  // `raiseCompletionToast` uses (`toast(message, { duration, action:
  // { label: "Undo", onClick } })`), read there rather than reimplemented
  // blind, but not shared code: that function lives in a file this ticket
  // does not own, and its Undo reverses a completion, not a Date.
  //
  // Undo restores only the Date (day and time together, via `onSetDate`)
  // — not the title. `rename-capture-2026-09-11.md`, the one live capture
  // of this toast, records that it reads "Date updated to Tomorrow" with
  // an Undo/Close pair, but never drove Undo itself or read back what it
  // left the title as — so what Todoist's own Undo restores is
  // unmeasured, not merely undocumented here. Restoring only the Date is
  // this file's own conservative choice, matching the toast's own wording
  // ("Date updated," not "Rename undone") and the guard `commitTaskTitle`
  // already applies on the way in (only ever set a field a phrase
  // actually resolved) — Undo mirrors that by only ever restoring the one
  // field the toast itself names.
  function raiseDateResolvedToast(taskId: string, dayText: string, previousDate: string | null) {
    toast(`Date updated to ${dayText}`, {
      duration: RENAME_DATE_TOAST_DURATION_MS,
      action: {
        label: "Undo",
        onClick: () => onSetDate(taskId, previousDate),
      },
    });
  }

  // DET-16: fires once per rename that changed `task.date` — comparing
  // this render's own `task.date` against the snapshot `saveEditing` took
  // right before calling `onRename`. Keyed on `task.date`/`task.id`
  // specifically, not the whole `task` object, so an unrelated field
  // changing (a Comment posted, a Label added, while this modal happens
  // to still be open) can't retrigger this check once it has already run
  // for the pending rename. `dateDisplay` below is read as of THIS
  // render, the same value the Date attribute row itself is about to
  // show — DET-16's own brief: the toast must use the identical word the
  // row badge would. `dateDisplay`/`raiseDateResolvedToast` are
  // deliberately absent from the dependency list: both are recomputed
  // fresh every render from `task`/`onSetDate`, so naming them would only
  // ever re-run this effect in lockstep with `task.date` itself — the one
  // dependency that actually decides whether this effect has anything to
  // do.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above — task.date/task.id are the only real re-run triggers; dateDisplay and raiseDateResolvedToast are derived from them each render, not independent inputs.
  useEffect(() => {
    const pending = pendingRenameDateRef.current;
    if (pending === null || pending.taskId !== task.id || task.date === pending.previousDate) {
      return;
    }
    pendingRenameDateRef.current = null;
    if (dateDisplay !== null) {
      raiseDateResolvedToast(task.id, dateDisplay.text, pending.previousDate);
    }
  }, [task.date, task.id]);

  function startEditing(field: "title" | "description") {
    setTitleDraft(task.content);
    setDescriptionDraft(task.description ?? "");
    setFocusField(field);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  // DET-15: "is there anything Cancel/Escape/an outside click would
  // actually throw away" — the identical question `saveEditing` below
  // already answers per-field (would it call `onRename`/
  // `onSetDescription` at all), asked once, up front, so
  // `requestCancelEditing` never has to guess at a looser definition of
  // "changed" than the one that actually governs a write. Trims here too
  // for the identical reason `saveEditing` does: a reader who types a
  // trailing space and then backs it out again has not, by this file's
  // own convention, changed anything worth confirming.
  function hasUnsavedChanges() {
    const trimmedTitle = titleDraft.trim();
    const titleChanged = trimmedTitle !== "" && trimmedTitle !== task.content;
    const trimmedDescription = descriptionDraft.trim();
    const nextDescription = trimmedDescription === "" ? null : trimmedDescription;
    const descriptionChanged = nextDescription !== task.description;
    return titleChanged || descriptionChanged;
  }

  // DET-15: the one door Cancel, Escape and an outside click all go
  // through now, replacing the direct `cancelEditing` call each of them
  // used to make — live Todoist confirms first ("Discard unsaved
  // changes?" / "Your unsaved changes will be discarded.",
  // `parity-ledger.md`'s DET-15 row); meologue used to discard
  // immediately. A no-op edit (nothing typed, or typed and then undone)
  // still cancels straight through, matching Todoist's own behaviour —
  // the confirm is for data loss specifically, not for touching Cancel
  // at all.
  // `fromOutsideClick` defaults to `false`: the Cancel button and both
  // editors' own `onCancel` (their Escape handling — this file's own
  // header comment on `CommentRow` above has the fuller account of why
  // Escape inside an editor reaches its caller directly rather than
  // through Radix) call this with no argument, and only ever meant "stop
  // editing," never "leave the task." Only `dismissGuardRef` below ever
  // passes `true`, and only for an actual outside click.
  function requestCancelEditing(fromOutsideClick = false) {
    if (hasUnsavedChanges()) {
      cancelTriggeredByOutsideClickRef.current = fromOutsideClick;
      setDiscardConfirmOpen(true);
      return;
    }
    cancelEditing();
  }

  // DET-15 round 3, gap 2: remembers whichever editor (title or
  // description) last held focus inside this form, so the discard
  // confirmation's own `onCloseAutoFocus` below has somewhere real to
  // send focus back to when it closes without a Discard. A `focusin`
  // listener on the edit column rather than on each editor directly:
  // this form's `editing` branch mounts/unmounts either editor freely
  // (DET-09's shared Cancel/Save pair), and one listener on their common
  // ancestor outlives both remounts without needing to be re-attached
  // each time `focusField` changes. `focusin` (not `focus`, which
  // doesn't bubble) is why this can live on the column at all rather
  // than needing a ref on each editor's own host node.
  //
  // The real `TaskTitleEditor`/`TaskDescriptionEditor` are both
  // ProseMirror instances whose focusable root is `[contenteditable=
  // true]` (`task-title-editor.tsx`'s own header comment has the DOM
  // shape); this file's own test doubles for both
  // (`task-detail-view.test.tsx`'s `StubTaskTitleEditor`/
  // `StubTaskDescriptionEditor`) stand in with a plain `<input>`/
  // `<textarea>` instead, deliberately — mounting a real ProseMirror
  // `EditorView` needs a real browser, the identical reason those
  // doubles exist at all. Matching on tag name alongside the
  // `contenteditable` attribute is what lets the identical listener
  // track focus correctly against both, with no special-casing for
  // which one is mounted.
  useEffect(() => {
    const column = editColumnRef.current;
    if (column === null) {
      return;
    }
    function handleFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const isEditableSurface =
        target.getAttribute("contenteditable") === "true" ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA";
      if (isEditableSurface) {
        lastFocusedEditorRef.current = target;
      }
    }
    column.addEventListener("focusin", handleFocusIn);
    return () => column.removeEventListener("focusin", handleFocusIn);
  }, []);

  // DET-15 (reworked after review): Escape and an outside click both used
  // to reach Radix's own Dialog Escape/outside-dismiss handling and close
  // the WHOLE view — confirmed directly, before any guard existed here,
  // by asserting `onClose` and watching it fire on an Escape aimed at the
  // title editor. A first version of this guard fixed that with a
  // `window`-capture `keydown`/`pointerdown` listener (`CommentRow`'s own
  // established pattern above, for the identical reason its own header
  // comment gives). That approach doesn't compose: `window` capture runs
  // before ANY layer gets the event, so it also ate Escape meant for
  // `discardConfirmOpen`'s own `ConfirmDialog` once THAT was open (a
  // keyboard trap — Escape just re-opened the same confirm instead of
  // dismissing it), swallowed every pointerdown on that dialog's own
  // Cancel/Discard buttons (mis-read as "outside the panel"), and would
  // have done the identical thing to any other portaled layer opened
  // while editing (a popover, a menu).
  //
  // Radix already solves exactly this: `DismissableLayer` (what
  // `Dialog.Content` is built on, both here and in `ConfirmDialog`) only
  // wires its OWN `document`-capture Escape listener while it is the
  // topmost layer, and gates its own outside-pointerdown detection on the
  // same stacking — so a nested modal layer on top correctly gets first
  // (and, for Escape, exclusive) claim, with no coordination this file
  // has to write by hand. `dismissGuardRef` (a callback `TaskDetailView`
  // holds and calls from `Content`'s own composable `onEscapeKeyDown`/
  // `onPointerDownOutside` props, `TaskDetailView`'s own doc comment on
  // the prop has the rest) is what lets THIS layer's dismissal ask this
  // form first, without this file reaching past Radix's layer stack the
  // way the `window` listener did. Assigned plainly during render (the
  // identical `xRef.current = ...` pattern `titleRecognitionOptionsRef`
  // above already uses), not in an effect: the value has to be current by
  // the time an interaction fires, and a plain assignment already is.
  dismissGuardRef.current = (source) => {
    if (!editing) {
      return false;
    }
    // DET-15's own Escape gap against the `#`/`@` popup above: at the
    // instant this callback runs, `autocompletePopupOpenRef` still reads
    // whatever it was BEFORE this same keystroke would otherwise close the
    // popup — Radix's own `document`-capture Escape listener always runs
    // before this event ever reaches `TaskTitleEditor`'s own keydown
    // handling (`closeAutocompleteRef`'s own doc comment, and this ref's
    // own comment above, have the full ordering proof). Calling
    // `closeAutocompleteRef.current?.()` here — a plain function call, not
    // a DOM event — closes the popup directly, since letting this same
    // keystroke's own bubble-phase reach `TaskTitleEditor`'s normal
    // keydown handling can no longer be trusted to do it once this
    // function returns `true` below (`onEscapeKeyDown`'s own
    // `preventDefault()` call is exactly what blocks that path — proven,
    // not just reasoned about, in task-detail-view-recognition.test.tsx's
    // own "Escape closes only the popup" case). Returning `true` without
    // calling `requestCancelEditing` is what keeps this one Escape from
    // ALSO raising the discard confirmation or ending editing outright —
    // every other source/state combination stays exactly as it was.
    if (source === "escape" && autocompletePopupOpenRef.current) {
      closeAutocompleteRef.current?.();
      return true;
    }
    requestCancelEditing(source === "outside");
    return true;
  };

  // The one door both the title's own `onCommit` (Enter, or the Save
  // button below) and the description's own Save button go through —
  // DET-09's "one Cancel/Save pair" means one commit, not two. `titleText`
  // is `TaskTitleEditor`'s own just-committed value when Enter fired
  // (that component's own doc comment on why it hands the text back
  // directly rather than this view reading mirrored state); the Save
  // button below has no such value in hand, so it passes nothing and this
  // reads `titleDraft` instead — `onChange` from both editors keeps that
  // state current the whole time this form is open.
  function saveEditing(titleText?: string) {
    setEditing(false);
    const trimmedTitle = (titleText ?? titleDraft).trim();
    if (trimmedTitle !== "" && trimmedTitle !== task.content) {
      // DET-16: snapshot taken before `onRename` fires — see
      // `pendingRenameDateRef`'s own doc comment above for why this is
      // the only hook this view has into whether the rename it just sent
      // upstream turns out to resolve a Date.
      pendingRenameDateRef.current = { taskId: task.id, previousDate: task.date };
      onRename(trimmedTitle);
    }
    // Trims only — the identical "never reflows a body, only trims it"
    // convention normalizeEntryBody (entry-text.ts) already follows for an
    // Entry's own body, applied here for the identical reason: a
    // Description is Markdown text, and internal newlines are part of
    // what was typed, not incidental whitespace this view gets to
    // discard.
    const trimmedDescription = descriptionDraft.trim();
    const nextDescription = trimmedDescription === "" ? null : trimmedDescription;
    if (nextDescription !== task.description) {
      onSetDescription(nextDescription);
    }
  }

  function submitSubtask() {
    const trimmed = subtaskDraft.trim();
    if (trimmed === "") {
      return;
    }
    onAddSubtask(trimmed);
    setSubtaskDraft("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-border border-b px-3 py-2">
        {/* Breadcrumb — Project, then Section, "Inbox" for neither (issue
            #178's own acceptance criterion). Plain text, not a link: this
            ticket's own scope is the detail view itself, not a second way
            to reach a Project's screen from inside it. */}
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {project === null ? "Inbox" : project.name}
          {section !== null && ` / ${section.name}`}
        </p>
        <button
          type="button"
          aria-label="Previous Task"
          disabled={prevTask === null}
          onClick={() => prevTask !== null && onNavigate(prevTask)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Next Task"
          disabled={nextTask === null}
          onClick={() => nextTask !== null && onNavigate(nextTask)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
        {/* Issue #302: the overflow menu — reachable on touch, and not
            gated on `wide` the way Close below is, since ADET-02's own gap
            was exactly this: a narrow reader had no door onto Delete
            except closing this whole sheet and finding the row behind
            it. */}
        <TaskDetailOverflowMenu
          task={task}
          open={overflowOpen}
          onOpenChange={setOverflowOpen}
          onCopyLink={onCopyLink}
          onOpenActivity={() => setActivityDialogOpen(true)}
          onCompleteForever={onCompleteForever}
          onRequestDelete={() => setDeleteConfirmOpen(true)}
          triggerRef={overflowTriggerRef}
        />
        {wide && (
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </DialogClose>
        )}
      </header>

      {/* No longer the scroll container itself. Todoist scrolls the comment
          THREAD in its own bounded region and sizes the composer to total
          content height, sitting outside that region as a sibling — read
          live today (2026-09-16, viewport 1270x706): scrolling the
          thread's own scroll container (`clientHeight` 374) moved the last
          comment by exactly the scroll delta while "Add sub-task" and the
          composer both stayed put. The composer's own top tracked total
          content height instead — 264px with no comments, 387px with one,
          512px once the thread overflowed — never pinned to the dialog's
          fixed bottom edge (y=642 of a 64-642 modal).

          That corrects the 2026-09-14 reading this comment used to cite,
          which read the scrolled region as the WHOLE left column (title,
          description, Add sub-task and the thread together) rather than
          the thread alone — nobody had re-driven it since. meologue still
          uses one shared scroller over the whole column instead of giving
          the thread its own nested region — splitting that out is a
          restructure, left for later — but the scroller below no longer
          force-grows to the column's full height (`sm:flex-initial`
          replacing `sm:flex-1`): it now sizes to its content and only
          shrinks-and-scrolls once the column runs out of room, so a short
          thread no longer shoves the composer to the floor.

          The split is `sm:` and up only. Below that breakpoint the two
          columns stack (`sm:flex-row`), and two independently scrolling
          regions stacked on a phone is worse than one — so narrow keeps the
          single shared scroller it always had, and the composer scrolls with
          the thread there. Todoist's own reference for this is its desktop
          two-column modal; nothing in the record says what it does when the
          columns stack. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:flex-row sm:overflow-hidden">
        {/* DET-10: this container's own `gap-3` spacing is real empty
            space between the title row and the Description block below —
            belonging to neither child (live audit's own
            `flow5-DET-10-meologue.json`, `commonContainer`, named this
            exact element by className). `event.target ===
            event.currentTarget` is what tells a genuine click on that
            gap apart from a click on the title button, the Description's
            own pill/block, or either editor, all of which bubble THROUGH
            this element rather than starting on it — so this never fires
            for the two deliberate entry points those elements' own
            `onClick`s already handle. Live Todoist's own finding was
            "focuses the dialog," not "does nothing": clicking here while
            `editing` moves focus to `contentRef` (`TaskDetailView`'s own
            Content node, already `tabIndex={-1}` for Radix's identical
            `onOpenAutoFocus` reason above `TaskDetailView`), which blurs
            whichever editor still held it from whichever entry point
            opened this form — matching the reference rather than leaving
            stale focus sitting in a field the reader didn't click.

            Pointer-only, deliberately: there is no keyboard equivalent of
            "click the empty gap between two fields" for this to pair
            with (matching `entry-row.tsx`'s own identical reasoning for
            its pointer-only `onContextMenu`), and giving this div an
            interactive role would misrepresent it as a control a reader
            might mean to activate rather than the plain layout container
            it is. */}
        {/* `min-h-0 flex-1` are `sm:`-only, matching the inner scroller below.
            Unprefixed they were a real regression at narrow widths: the flex
            algorithm compressed this wrapper to ~504px while a long thread
            needed ~1300px, and because the inner child only becomes a
            scroller at `sm:`, nothing clipped the overflow — the comments
            spilled out of their own box and painted over the attribute panel
            beneath them. Found by driving a 500px-wide window, not by any
            test: jsdom lays nothing out. Below `sm:` this wrapper must size
            to its content and let the ONE shared scroller above own the
            scrolling. */}
        <div ref={editColumnRef} className="flex min-w-0 flex-col gap-2 sm:min-h-0 sm:flex-1">
          {/* `editColumnRef` stays on the element ABOVE this one so its
            `focusin` listener still sees the pinned composer below —
            moving the ref down here would stop the composer's own textarea
            from being tracked as the last focused editor. This inner
            element keeps the testid and the gap-click, because both belong
            to the `gap-3` spacing between the title row and Description. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only progressive enhancement on a plain layout container — see the comment above. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: no keyboard equivalent of clicking empty space exists to pair this with — see the comment above. */}
          <div
            data-testid="task-detail-edit-column"
            onClick={(event) => {
              if (editing && event.target === event.currentTarget) {
                contentRef.current?.focus();
              }
            }}
            className="flex flex-col gap-3 sm:min-h-0 sm:flex-initial sm:overflow-y-auto"
          >
            {/* The title (issue #225's display/edit split — `editingTitle`'s
              own doc comment above). Editable regardless of completion
              state: nothing about this view's own scope refuses a rename
              of a completed Task, and task-row.tsx's own checkbox doesn't
              either — completing something is not "locking" it. */}
            <div className="flex items-start gap-2">
              {/* Completes/un-completes this Task (issue #184's own
                gap-fix report: "not read-only" — a real toggle, not the
                `readOnly` button-shaped-like-a-checkbox task-row.tsx's
                own active-only checkbox is, since this is the one place
                in the app both states of the same checkbox render.
                Filled and struck through when done, mirroring the
                reference's own completed-row rendering. */}
              <input
                type="checkbox"
                checked={task.completedAt !== null}
                onChange={() => (task.completedAt !== null ? onUncomplete() : onComplete())}
                aria-label={
                  task.completedAt !== null
                    ? `Mark "${task.content}" not done`
                    : `Complete "${task.content}"`
                }
                className="mt-1.5 size-4 shrink-0 accent-current"
              />
              <DialogTitle asChild>
                {editing ? (
                  // `<Suspense>` is what keeps ProseMirror out of Todo's own
                  // eager chunk (`lazy-task-title-editor.ts`'s own header
                  // comment has the bundle numbers) even though this view
                  // itself is not lazy — the boundary is on the editor, not
                  // on the dialog that hosts it. The fallback repeats the
                  // plain title text rather than a spinner, matching
                  // `task-row-content.tsx`'s identical choice for its own
                  // inline rename.
                  //
                  // DET-09: BOTH the title and the description become real
                  // editors together the instant either is activated — only
                  // which one holds the caret differs, via `autoFocus`
                  // below (DET-10's own `focusField`), never whether it's
                  // editable at all.
                  <div className="w-full">
                    <Suspense
                      fallback={
                        <p
                          className={cn(
                            "font-medium text-base",
                            task.completedAt !== null && "completed-task-text",
                          )}
                        >
                          {task.content}
                        </p>
                      }
                    >
                      <LazyTaskTitleEditor
                        value={task.content}
                        onChange={setTitleDraft}
                        onCommit={saveEditing}
                        onCancel={requestCancelEditing}
                        autoFocus={focusField === "title"}
                        // DET-09: blur no longer means "done" — moving focus
                        // from the title into the description (still inside
                        // this same combined form) must not close it. Only
                        // Enter, Escape or the explicit Save/Cancel pair
                        // below end this form now.
                        commitOnBlur={false}
                        className="font-medium text-base"
                        // DET-07 (this function's own comment above on the
                        // ref this reads and what it deliberately doesn't
                        // change): the same plugin `add-task-form.tsx`
                        // attaches, so recognition renders identically here.
                        extraPlugins={[
                          quickAddRecognitionPlugin(() => titleRecognitionOptionsRef.current),
                        ]}
                        // QA-14's own second half: the identical `#`/`@`
                        // popup Quick Add and the row's rename already open,
                        // wired to this view's own `projects`/`labels` and
                        // whatever create hook the outlet context supplies
                        // (this function's own `titleAutocomplete` comment
                        // above). `onAutocompleteOpenChange` feeds
                        // `autocompletePopupOpenRef`, which
                        // `dismissGuardRef`'s own assignment above reads —
                        // DET-15's fix for the Escape gap this file's own
                        // header comment on that ref names.
                        autocomplete={titleAutocomplete}
                        onAutocompleteOpenChange={(open) => {
                          autocompletePopupOpenRef.current = open;
                        }}
                        closeAutocompleteRef={closeAutocompleteRef}
                      />
                    </Suspense>
                  </div>
                ) : (
                  // DET-02: matched to Todoist's own measured shape (live
                  // audit, flow 4 — `flow4-DET-02-03-05-14-todoist.json`),
                  // ratified by the user on 2026-09-13, reversing this
                  // file's own earlier `<button>` choice: a `DIV`, no
                  // `role`, `tabIndex={-1}` — non-editable and non-focusable
                  // by Tab, same as Todoist's `div.task_content`. That
                  // trades away "activate with just a keyboard" (Tab, then
                  // Enter/Space), which the reference never had either; the
                  // user accepted the loss rather than keep meologue's own
                  // divergence.
                  // DET-03: unlike Todoist (whose sibling hint carries no
                  // `aria-describedby` link — nothing points at it), this
                  // element keeps pointing at `titleHintId` — ratified
                  // separately, in meologue's favour, the same day.
                  // biome-ignore lint/a11y/noStaticElementInteractions: DET-02 — Todoist's title at rest is a plain, non-interactive div; matching that shape means the click handler has no button/role to live on. The click-catcher just below (`task-detail-edit-column`) already sets this file's precedent for a `biome-ignore` here rather than a synthetic role.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: DET-02 — `tabIndex={-1}` (matched to Todoist) takes this out of Tab order, so there is no keyboard event to pair the click with; the user's 2026-09-13 decision accepted losing keyboard activation of the title specifically.
                  <div
                    onClick={() => startEditing("title")}
                    aria-describedby={titleHintId}
                    tabIndex={-1}
                    data-testid="task-detail-title"
                    className={cn(
                      "w-full text-left font-medium text-base",
                      task.completedAt !== null && "completed-task-text",
                    )}
                  >
                    {/* ROW-06 (parity-ledger.md): row-and-detail.md §2's own
                      "single most consequential finding" is that this div
                      IS the row's own display component, `div.task_content`
                      — so the same live-measured markdown rendering
                      (`live-audit-dom/flow10-ROW-06-both.json`) applies here
                      at rest, through the same inline-only `inlineProse`
                      task-row-content.tsx now uses. `task.content` itself is
                      unread by anything else here — clicking still opens
                      `LazyTaskTitleEditor` on the raw, unformatted value
                      above, `data-testid`/`tabIndex`/`aria-describedby` are
                      untouched. */}
                    {inlineProse(task.content)}
                  </div>
                )}
              </DialogTitle>
            </div>
            <span id={titleHintId} className="sr-only">
              Activate to edit the task name
            </span>

            {/* Description (issue #180, DET-09 onward) — directly under the
              title, not in the sidebar (this file's own header comment).
              At rest: a pill until it has words, then a rendered,
              click-to-edit block, the identical promotion
              Project/Date/Deadline/Priority/Labels use below. While
              `editing`, this renders `TaskDescriptionEditor`
              (DET-11/DET-12) regardless of which field the reader
              activated — DET-09's own "task-wide, not field-wide" rule —
              sharing the one Cancel/Save pair below with the title. */}
            {editing ? (
              <div className="flex flex-col gap-2">
                <Suspense
                  fallback={
                    <div className="[&_p]:my-0 [&_ul]:my-0">
                      {entryProse(task.description ?? "")}
                    </div>
                  }
                >
                  <LazyTaskDescriptionEditor
                    value={task.description ?? ""}
                    onChange={setDescriptionDraft}
                    onCancel={requestCancelEditing}
                    autoFocus={focusField === "description"}
                    className="text-sm"
                  />
                </Suspense>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    // A wrapper, not `requestCancelEditing` passed
                    // directly: React hands an `onClick` handler the
                    // native (truthy) MouseEvent as its first argument,
                    // which — passed straight through as this function's
                    // now-optional `fromOutsideClick` parameter — would
                    // read as "yes, this was an outside click" on every
                    // ordinary Cancel-button press (DET-15 round 3's own
                    // regression, caught by this file's own "clicking
                    // Discard...without closing the whole view" test).
                    onClick={() => requestCancelEditing()}
                    className="rounded-md border border-border px-2.5 py-1 text-sm transition hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => saveEditing()}
                    className="rounded-md border border-border px-2.5 py-1 text-sm transition hover:bg-muted"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : task.description === null ? (
              <AttributePill label="Description" onClick={() => startEditing("description")} />
            ) : (
              <button
                type="button"
                onClick={() => startEditing("description")}
                className="w-full rounded-md p-2 text-left text-sm transition hover:bg-muted"
              >
                {/* `[&_p]:my-0` — entryProse's own `<p>` carries margin
                  meant for History's multi-Entry rhythm; a single Task's
                  Description reads as one block, not a stack of Entries,
                  so that margin is undone here the same way it would be
                  wherever else this renderer is dropped into a context
                  that isn't History. */}
                <div className="[&_p]:my-0 [&_ul]:my-0">{entryProse(task.description ?? "")}</div>
              </button>
            )}

            {/* Sub-tasks (issue #229) — the detail view had no such section
              at all before this ticket, despite `Task.parentId`,
              `listChildren` and `listDescendants` already existing in the
              store (this ticket's own brief). Create, display, complete —
              reordering/reparenting a sub-task from inside this view is
              out of scope; `task-tree.tsx`'s own drag/keyboard reorder
              already covers that from Inbox/a Project's own list.
              Completing the *parent* still completes every sub-task
              (CONTEXT.md's Sub-task entry) — already true for free, since
              `onComplete` above routes to the identical `TaskStore.complete`
              that already cascades to `listChildren` (sqlite-task-store.ts). */}
            <div className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-xs">
                Sub-tasks{subtasks.length > 0 ? ` (${subtasks.length})` : ""}
              </h2>
              {subtasks.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {subtasks.map((subtask) => (
                    <li
                      key={subtask.id}
                      className="flex items-center gap-2 rounded-md p-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={subtask.completedAt !== null}
                        onChange={() =>
                          subtask.completedAt !== null
                            ? onUncompleteSubtask(subtask.id)
                            : onCompleteSubtask(subtask.id)
                        }
                        aria-label={
                          subtask.completedAt !== null
                            ? `Mark "${subtask.content}" not done`
                            : `Complete "${subtask.content}"`
                        }
                        className="size-4 shrink-0 accent-current"
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          subtask.completedAt !== null && "completed-task-text",
                        )}
                      >
                        {subtask.content}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submitSubtask();
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  aria-label="Add sub-task"
                  placeholder="Add sub-task"
                  value={subtaskDraft}
                  onChange={(event) => setSubtaskDraft(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-border bg-transparent p-2 text-sm outline-none"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm transition hover:bg-muted"
                >
                  Add
                </button>
              </form>
            </div>

            {/* Comments (issue #180) — a thread below the description, the
              most recent Comment simply the last item in the list.

              **CMT-10: nothing renders at all when there are none.** Todoist's
              own zero state, read back from its live DOM
              (`detail-modal-todoist-2026-09-14.json`'s
              `comments.zeroCommentsState`): the word "Comments" appears
              nowhere in the left column until a Task has one, with the
              composer sitting directly under "Add sub-task". meologue used to
              print a bare "Comments" heading over an empty space — a label
              for a section that does not exist yet.

              **And it collapses.** The same native `<details>` disclosure the
              Activity section below already uses, rather than a second idiom
              for the same interaction two elements apart — but `open` by
              default, where Activity is closed: a Task's Comments are part of
              reading it, and Todoist shows its own thread expanded. The
              composer is deliberately NOT inside this element (it is the
              column's footer, below), so collapsing the thread never takes
              the way to add a Comment with it.

              No `flex` on the `<details>` itself: its children are the
              `<summary>` and the thread, and making that a flex container is
              a needless way to disturb how the disclosure marker lays out.
              The `mt-2` on the list below is the whole of the spacing this
              needs. */}
            {comments.length > 0 && (
              <details open>
                {/* `Comments 3`, bare — NOT `Comments (3)`. Read back from
                    live Todoist at one, two and three comments
                    (`comment-behaviour-todoist-2026-09-14.json`'s
                    `commentsHeader.exactRenderedText`), which also never
                    singularises: it stays "Comments 1", not "Comment 1".
                    meologue's own parenthesised convention survives
                    everywhere it has no reference to match — `Activity (5)`
                    right below keeps it, because Todoist's detail modal has
                    no Activity section at all.

                    Structurally this is a native `<details>` where Todoist
                    uses a `<button aria-expanded aria-controls>` over a
                    panel. Same behaviour on every axis that was driven —
                    toggles, starts expanded, and the state resets when the
                    Task is reopened — so this keeps the native element for
                    the same reason NAV-04 and DET-03 are ratified
                    divergences: where meologue can be the more accessible
                    side at equal behaviour, it is. Recorded, not silent.

                    meologue's own parenthesised counting convention
                    ("Activity (N)") no longer sits a few rows below this
                    one — issue #288 moved it behind the header's own
                    "View activity" overflow item, `TaskActivityDialog`
                    below — but it still has nothing here to diverge from:
                    Todoist's detail modal has no Activity section of its
                    own to have picked a convention for. */}
                <summary className="cursor-pointer select-none text-muted-foreground text-xs">
                  Comments {comments.length}
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {comments.map((comment) => (
                    <CommentRow
                      key={comment.id}
                      comment={comment}
                      onEdit={(text) => onEditComment(comment.id, text)}
                      onCopyLink={() => copyCommentLink(comment)}
                      onRequestRemove={() => setConfirmingCommentId(comment.id)}
                    />
                  ))}
                </ul>
              </details>
            )}

            {/* DET-15: Cancel/Escape/an outside click confirm first when the
              title/description form holds unsaved changes, verbatim
              wording matching live Todoist's own (`parity-ledger.md`'s
              DET-15 row) — meologue used to discard immediately. Rendered
              unconditionally (not nested inside the `editing` branch
              above) for the identical reason the Comment-delete
              `ConfirmDialog` right below is: `discardConfirmOpen` alone
              controls whether it's open, so a Discard click that flips
              `editing` back to `false` in the same tick doesn't also
              unmount this dialog out from under its own closing
              animation. */}
            <ConfirmDialog
              open={discardConfirmOpen}
              onOpenChange={setDiscardConfirmOpen}
              title="Discard unsaved changes?"
              description="Your unsaved changes will be discarded."
              confirmLabel="Discard"
              // DET-15 round 3: matches live Todoist's own
              // `attempt3_clickOutsideModal` finding
              // (`flow11-R3-DET-15-both.json`) — Discard after an
              // outside-click trigger completes that click's own original
              // intent (leave the task) by closing the whole view too, on
              // top of ending the edit every trigger already ends. Cancel
              // and Escape leave `cancelTriggeredByOutsideClickRef` `false`
              // (its own default, and `requestCancelEditing`'s), so Discard
              // there stays exactly what it already was: end editing, keep
              // the view open.
              onConfirm={() => {
                discardConfirmedRef.current = true;
                cancelEditing();
                if (cancelTriggeredByOutsideClickRef.current) {
                  onClose();
                }
              }}
              // DET-15 round 3, gap 2: only reached when this confirmation
              // closes WITHOUT Discard (Escape, or its own Cancel button —
              // `discardConfirmedRef` is what tells the two apart, set only
              // by `onConfirm` just above). Radix's own default here would
              // restore focus to whatever triggered this dialog's open —
              // nothing, since `requestCancelEditing` opens it
              // programmatically — which is why live meologue previously
              // dropped focus to `document.body`
              // (`flow11-R3-DET-15-both.json`'s `escapeInsideConfirmation`).
              // `preventDefault()` takes that default away in favour of the
              // one place a reader dismissing this without discarding
              // actually came from: whichever editor `lastFocusedEditorRef`
              // last saw. A Discard close skips this entirely — editing is
              // ending (or the whole view is), so there is no editor left
              // to send focus back to.
              // Radix defers this dispatch a tick (`FocusScope`'s own
              // cleanup effect wraps it in `setTimeout(..., 0)`, so the
              // container is fully gone from the DOM before anything tries
              // to focus relative to it) — a caller (this file's own tests
              // included) needs to let that tick pass before checking where
              // focus landed, the identical `setTimeout(resolve, 0)` wait
              // this file's own `clickOutside` test helper already uses for
              // Radix's own outside-pointerdown listener, for the identical
              // reason: a real async gap inside Radix, not a jsdom quirk to
              // work around.
              onCloseAutoFocus={(event) => {
                if (discardConfirmedRef.current) {
                  discardConfirmedRef.current = false;
                  return;
                }
                event.preventDefault();
                lastFocusedEditorRef.current?.focus();
              }}
            />

            {/* CMT-03: deleting a Comment confirms first, verbatim wording
              matching Todoist's own (`lifecycle.md` §2). */}
            <ConfirmDialog
              open={confirmingCommentId !== null}
              onOpenChange={(open) => {
                if (!open) {
                  setConfirmingCommentId(null);
                }
              }}
              title="Delete comment?"
              description="This comment will be permanently deleted."
              confirmLabel="Delete"
              onConfirm={() => {
                if (confirmingCommentId !== null) {
                  onRemoveComment(confirmingCommentId);
                }
              }}
            />

            {/* Issue #302: deleting a Task from the overflow menu confirms
              first — verbatim wording matching `todo-page.tsx`'s own
              `ConfirmDialog` for the row menu's identical "Delete" item
              (that file's own ROW-06 comment has the reasoning for why
              only the interpolated title gets `inlineProse`, not the
              surrounding sentence). `onDelete` is the real mutation; this
              view calls no `onClose` of its own afterward — `task-detail-
              view.tsx`'s own `onDelete` doc comment has the reason. */}
            <ConfirmDialog
              open={deleteConfirmOpen}
              onOpenChange={setDeleteConfirmOpen}
              title="Delete task?"
              description={<>The {inlineProse(task.content)} task will be permanently deleted.</>}
              confirmLabel="Delete"
              onConfirm={onDelete}
            />

            {/* Issue #288: the "View activity" overflow item's own surface
              — this file's own header comment has the full account of why
              it lives here now rather than as an inline disclosure. */}
            <TaskActivityDialog
              open={activityDialogOpen}
              onOpenChange={setActivityDialogOpen}
              events={renderableEvents}
              task={task}
              projects={projects}
              triggerRef={overflowTriggerRef}
            />
          </div>

          {/* Sits beneath the scrolling region rather than inside it, as a
            sibling — it stays put while the thread scrolls, matching
            Todoist's measured behaviour (this file's own header comment
            above the row container has today's 2026-09-16 readings).
            Todoist's composer is not pinned to its modal's bottom edge
            either, though: it follows total content height and only ends
            up near the floor once a thread is long enough to fill the
            space. The scroller above sizes to its content the same way
            now (`sm:flex-initial`), so this composer sits directly under
            short content instead of being shoved down to a fixed edge.

            It sits below Activity in source order because it is the
            column's footer, not a member of the Comments block; Todoist
            has no Activity section here, so nothing in the record says
            where it would fall relative to one. */}
          <CommentComposer onSubmit={onAddComment} initialExpanded={openCommentComposer} />
        </div>

        {/* The attribute sidebar — Project, Date, Deadline, Priority,
            Labels, pill-or-row per this file's own `AttributePill`/
            `AttributeRow` doc comments. `sm:w-56` only takes effect
            alongside the `sm:flex-row` above, so a narrow sheet still
            stacks this beneath the title instead of squeezing both into
            one row. */}
        <div className="flex shrink-0 flex-col gap-1 sm:min-h-0 sm:w-56 sm:overflow-y-auto">
          {/*
            Project — the one attribute that's never truly "unset" the way
            Date/Deadline/Priority/Labels can be (CONTEXT.md's Inbox
            entry: Inbox is the absence of a Project, not a lesser value
            of one), so this always renders as a promoted row, never a
            pill — there is no "nothing chosen yet" state to promote out
            of.
          */}
          <AttributeRow
            icon={null}
            label="Project"
            value={project === null ? "Inbox" : project.name}
            colour={project?.colour}
            onClick={() => setPickingProject((open) => !open)}
          />
          {pickingProject && (
            <select
              aria-label="Move to Project"
              value={project?.id ?? ""}
              onChange={(event) => {
                onSetProject(event.target.value === "" ? null : event.target.value);
                setPickingProject(false);
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="">Inbox</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {/*
            Issue #253: Date is the one attribute here that no longer
            opens `onOpenSchedule`'s shared sheet — it anchors this view's
            own `TaskSchedulePopover` instance directly under the pill/row
            below instead, the identical per-site instance
            `task-row-content.tsx`'s own hover Date button opens. Both
            `AttributePill` and `AttributeRow` forward refs (their own doc
            comments above) specifically so this works as a Radix `asChild`
            trigger.
          */}
          <TaskSchedulePopover
            open={dateScheduleOpen}
            onOpenChange={setDateScheduleOpen}
            dateDay={dateDay}
            dateTime={dateTime}
            // DET-16: each of these three is a reader-driven, explicit
            // Date edit — clearing `pendingRenameDateRef` first means a
            // rename that didn't itself touch the Date can never have a
            // LATER, unrelated edit here misread as its own effect (that
            // ref's own doc comment above has the full reasoning).
            onSetTime={(time) => {
              pendingRenameDateRef.current = null;
              setScheduleTime(time);
            }}
            dateString={task.dateString}
            datesWithTasks={datesWithTasks}
            onPickDay={(day) => {
              pendingRenameDateRef.current = null;
              setScheduleDay(day);
              // SCHED-15: picking a DAY postpones this occurrence and leaves
              // the Recurrence alone. This used to clear `dateString` on
              // every pick, so rescheduling a repeating Task silently ended
              // the series — `Today ↻ every day` became a plain `21 Sep`,
              // with no warning and no way back short of retyping the
              // phrase.
              //
              // Driven on live Todoist 2026-09-15
              // (`recurrence-reschedule-todoist-2026-09-14.json`): both a
              // calendar click and a quick option leave the rule untouched,
              // and completing afterwards computes `max(current due, today)
              // + one interval`, so the postponed date IS the anchor.
              // meologue's engine already agrees — `recurrence.ts`'s own
              // "skipping missed occurrences" rule returns only a date
              // strictly after `now`, stepping a whole interval at a time.
              // It simply never got to run, because the Task stopped being
              // recurring before it could.
              //
              // `null` — "No Date" — still ends the Recurrence: a rule
              // counts from a date, and there is nothing left to count
              // from. Todoist reaches that end through a separate "Clear
              // recurrence" control instead, and what its own "No Date"
              // does to a recurring Task was NOT established — so this is
              // meologue's reasoned default, not a matched behaviour.
              //
              // `localDayKey(new Date())`, not `new Date().toISOString()` —
              // issue #296. `TaskStore.setDateString`'s own `today`
              // parameter has always meant a floating local day, never an
              // instant; passing the instant relied on ../recurrence/'s
              // engine silently slicing its first ten characters, which
              // names the UTC calendar day rather than this Device's own —
              // see TaskStore.setDateString's own doc comment
              // (packages/core) for the full account, and issue #290 for
              // the identical fix applied to advanceRecurring/postpone.
              if (day === null && task.dateString !== null) {
                onSetDateString(task.id, null, localDayKey(new Date()));
              }
            }}
            onPickRecurrence={(dateString) => {
              pendingRenameDateRef.current = null;
              onSetDateString(task.id, dateString, localDayKey(new Date()));
            }}
            trigger={
              task.date === null || dateDisplay === null ? (
                <AttributePill label="Date" />
              ) : (
                <AttributeRow
                  icon={null}
                  label="Date"
                  // Issue #224: the identical tone `task-row.tsx`'s own badge
                  // reads through `formatTaskDate` — `completed`/`recurring`
                  // passed the same way, so a Task overdue in the row is
                  // never merely upcoming in its own detail view.
                  value={<span style={{ color: dateDisplay.colour }}>{dateDisplay.text}</span>}
                />
              )
            }
          />
          {task.deadline === null ? (
            <AttributePill label="Deadline" onClick={onOpenSchedule} />
          ) : (
            <AttributeRow
              icon={null}
              label="Deadline"
              value={formatDay(task.deadline)}
              onClick={onOpenSchedule}
            />
          )}
          {task.priority === 1 ? (
            <AttributePill label="Priority" onClick={onOpenSchedule} />
          ) : (
            <AttributeRow
              icon={null}
              label="Priority"
              value={`P${uiPriority}`}
              colour={priorityColour(uiPriority)}
              onClick={onOpenSchedule}
            />
          )}
          {task.labelIds.length === 0 ? (
            <AttributePill label="Labels" onClick={() => setPickingLabels(true)} />
          ) : (
            <AttributeRow
              icon={null}
              label="Labels"
              value={task.labelIds
                .map((id) => labels.find((label) => label.id === id)?.name ?? "")
                .filter((name) => name !== "")
                .join(", ")}
              onClick={() => setPickingLabels(true)}
            />
          )}
          {pickingLabels && (
            <div className="flex flex-col gap-0.5 rounded-md border border-border p-1.5">
              {labels.length === 0 ? (
                <p className="px-1 py-1 text-muted-foreground text-xs">No Labels yet.</p>
              ) : (
                labels.map((label) => {
                  const checked = task.labelIds.includes(label.id);
                  return (
                    <label key={label.id} className="flex items-center gap-2 px-1 py-1 text-xs">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          onSetLabels(
                            checked
                              ? task.labelIds.filter((id) => id !== label.id)
                              : [...task.labelIds, label.id],
                          )
                        }
                      />
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: label.colour }}
                      />
                      {label.name}
                    </label>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The responsive shell — `useWideLayout()` (todo-nav.tsx's own hook)
 * decides between a centered modal and a bottom sheet, both built on the
 * identical Radix `Dialog.Root`/`Content` primitives rather than two
 * unrelated component trees: only the `Content`'s own className and
 * whether the close button/drag handle render differ between the two.
 */
export function TaskDetailView(props: TaskDetailViewProps) {
  const wide = useWideLayout();
  // A ref rather than the handler's own `event.currentTarget`: Radix types
  // `onOpenAutoFocus` as taking a bare DOM `Event`, whose `currentTarget` is
  // `EventTarget | null` and carries no `focus()` at all — reaching the
  // element through it needs a cast, and a cast here would be asserting the
  // one fact this file can simply hold instead.
  const contentRef = useRef<HTMLDivElement>(null);
  // DET-15: `TaskDetailBody`'s own dismissal claim — assigned there, on
  // every render, to a closure that opens the discard-confirm (or cancels
  // outright, for a no-op edit) and returns `true` whenever the shared
  // title/description form is open. `null` is a real, meaningful default
  // (nothing has claimed a dismissal yet, e.g. before `TaskDetailBody`'s
  // own first render, or once `editing` there is `false`), not a stand-in
  // for "not wired up" — `onEscapeKeyDown`/`onPointerDownOutside` below
  // both treat a missing or false-returning guard identically: let Radix
  // dismiss as it always has.
  const dismissGuardRef = useRef<((source: "escape" | "outside") => boolean) | null>(null);

  function handleOpenChange(open: boolean) {
    if (!open) {
      props.onClose();
    }
  }

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogContent
          open={true}
          aria-describedby={undefined}
          // DET-05: Todoist's own measured `data-testid` (keyboard.md
          // §1) — `history.tsx`/`task-schedule-popover.tsx`/etc. already
          // carry ids of their own for the identical reason, an e2e
          // selector that doesn't depend on visible text or a11y wiring.
          data-testid="task-details-modal"
          // Opening a Task is usually "look at this," not "rename it" —
          // on a phone, focusing the title textarea pops the soft
          // keyboard the instant the row is tapped, and the bottom sheet
          // then jumps as the visual viewport shrinks to make room for
          // it. Radix's own default `onOpenAutoFocus` would focus the
          // first tabbable descendant of `Content` anyway — the
          // completion checkbox (issue #184 put it just ahead of the
          // title in the DOM) — which is worse than the title, not
          // better, so `preventDefault()` has to stay regardless of
          // where focus ends up. Prior to this, that default was
          // overridden by naming the title textarea explicitly, restoring
          // Radix's pre-#184 behaviour (issue #184's own history — the
          // reason this handler exists at all rather than never having
          // one). That citation named the "Enter commits the title" test
          // below as relying on the title already being focused, and it
          // was right by accident, for a reason it did not give. The
          // dispatch is not what needs focus: `fireEvent.change`/
          // `fireEvent.keyDown` fire straight at the node regardless of
          // `document.activeElement`. The COMMIT is — the Enter branch
          // just below calls `event.currentTarget.blur()`, and a `blur()`
          // against an element that was never the active element is a
          // no-op (in jsdom and in a real browser alike), so `onBlur=
          // {commitTitle}` never runs and the rename is silently lost.
          // Nothing about that is a regression here: a reader who is
          // typing in the title has, by definition, already focused it.
          // The test now focuses the field itself, which is what a real
          // tap does. Landing focus on `Content` itself (Radix
          // gives it `tabIndex={-1}`) rather than doing nothing keeps Esc,
          // the focus trap and focus-restore-on-close all working — a
          // bare `preventDefault()` with no follow-up would leave focus
          // on the row `<button>` outside the dialog instead. The title
          // is one tap away for a reader who actually wants to rename it.
          ref={contentRef}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          // DET-15: gives `TaskDetailBody`'s own edit form first claim on
          // Escape and an outside click, ahead of this Dialog's own
          // default (close the whole view). Composable, unlike Radix's
          // own `AlertDialog.Content` (this file's sibling
          // `alert-dialog.tsx` has the full contrast) — `preventDefault()`
          // here is read by the identical `DismissableLayer` that would
          // otherwise call `onDismiss`, so returning `true` from the ref
          // genuinely stops the close rather than merely reacting after
          // the fact. Both consult the SAME guard: whatever counts as
          // "this form wants to handle it" is one decision, not two that
          // could disagree.
          //
          // This is layer-stack-aware for free, which a `window`-level
          // listener (this file's own first attempt, reverted) was not:
          // `DismissableLayer` only wires its `document`-capture Escape
          // listener while a layer is the topmost one, so once
          // `TaskDetailBody`'s own `ConfirmDialog` (itself a
          // `DismissableLayer`) opens on top, THIS Content's own listener
          // goes quiet and stops calling `onEscapeKeyDown` at all — the
          // confirm dialog gets Escape, not this guard, with nothing
          // written here to make that true. The identical stacking is
          // what keeps a pointerdown on the confirm's own Cancel/Discard
          // buttons from ever reaching this Content's outside-pointerdown
          // detection as "outside" while it's open.
          onEscapeKeyDown={(event) => {
            if (dismissGuardRef.current?.("escape")) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (dismissGuardRef.current?.("outside")) {
              event.preventDefault();
            }
          }}
          className={cn(
            // No border, and Todoist's own measured shadow rather than
            // shadow-lg (DET-14): the modal was measured directly at
            // `border: none` with `rgba(0,0,0,.16) 0 2px 8px`. A 1px border
            // against a background identical to the page behind it reads as
            // a seam rather than an edge, which is presumably why Todoist
            // leans on the shadow alone to lift it.
            "fixed z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground shadow-[var(--td-modal-shadow)] outline-hidden duration-150",
            wide
              ? // DET-14: measured directly against the live Todoist modal —
                // radius 10px, not Tailwind's own 14px `rounded-xl` this
                // used to carry.
                // 54rem wide is Todoist's own measured 864px at desktop
                // width (DET-14), against the 40rem this carried before —
                // a third narrower, which is what made the two columns
                // feel cramped where Todoist's breathe. Width stays
                // clamped so a smaller window still gets a modal that
                // fits inside it.
                //
                // Height is `100vh - 8rem` (128px), not a flat fraction of
                // the viewport: re-measured live at the same 1470×836
                // viewport (flow 5, parity-ledger.md's DET-14 row),
                // Todoist read 864×708 twice with no animation running,
                // against this file's own `min(48.25rem,85vh)`, which
                // resolved to 710.594 there once meologue's own opening
                // animation was driven to its resting frame
                // (`Animation.finish()`) rather than read mid-transform.
                // 836 − 128 = 708 is an exact match; 85vh never was. The
                // 48.25rem (772px) cap is `100vh − 128px` at a 900px-tall
                // viewport, matching the corpus's older 864×772 reading
                // (flow 4) — but nobody has actually measured a live
                // Todoist modal at a viewport taller than 900px, so this
                // formula holding as the cap above that height is this
                // file's own assumption, consistent with both readings
                // rather than a third one.
                "top-1/2 left-1/2 h-[min(48.25rem,calc(100vh-8rem))] w-[min(54rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
              : "inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom",
          )}
          style={wide ? undefined : { paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          {!wide && (
            // The drag handle — a bottom sheet's own visual signature
            // (this ticket's own reference behaviour). Decorative only:
            // Esc, the header's own back-to-list chevron behaviour and a
            // tap outside all already close this sheet, so a real
            // drag-to-dismiss gesture would duplicate an affordance this
            // view already has rather than add one it's missing.
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30"
            />
          )}
          <TaskDetailBody
            {...props}
            wide={wide}
            contentRef={contentRef}
            dismissGuardRef={dismissGuardRef}
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
