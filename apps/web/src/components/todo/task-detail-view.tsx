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
 * **Activity** (issue #184, ADR 0056) sits below Comments, a `<details>`
 * disclosure, collapsed by default and open on request — a secondary,
 * occasional thing to check, not something worth the vertical space open
 * by default the way Comments are. `events` is already narrowed to this
 * one Task by the caller
 * (`listEventsByTask`, entry-store-layout.tsx), the identical "the
 * caller scopes it, this view only renders" split `comments` above
 * already takes.
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
import type { Comment, Event, Label, Project, Section, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import { ChevronLeft, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { forwardRef, Suspense, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { toast } from "sonner";
import { entryProse } from "@/components/entry-prose";
import { inlineProse } from "@/components/inline-prose";
import { ActivityFeed } from "@/components/todo/activity-feed";
import { LazyTaskDescriptionEditor } from "@/components/todo/lazy-task-description-editor";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { TaskSchedulePopover } from "@/components/todo/task-schedule-popover";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { useAutoGrowTextarea } from "@/hooks/use-auto-grow-textarea";
import { useTaskDateState } from "@/hooks/use-task-date-state";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { deviceUtcOffsetMinutes, formatCommentTimestamp } from "@/lib/entry-day";
import { isRenderableEvent } from "@/lib/format-event";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { localDayKey } from "@/lib/local-day-key";
import type { QuickAddAutocompleteOptions } from "@/lib/quick-add-autocomplete";
import { useSettingsStore } from "@/lib/settings";
import { priorityColour } from "@/lib/task-priority-colors";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";
import { cn } from "@/lib/utils";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";

/**
 * DET-16 (parity-ledger.md): live Todoist's own "Date updated to Tomorrow"
 * toast, with Undo, was present through 9,609ms and gone by 10,119ms after
 * Save (`rename-capture-2026-09-11.md`; flow 4, polled every ~500ms). 10s,
 * not `todo-page.tsx`'s own 11s `COMPLETION_TOAST_DURATION_MS` — that
 * row's own note is explicit that the two toasts' lifetimes should not be
 * assumed to share a duration, and this is a separate measurement, not a
 * reused one.
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
  /** Opens the shared `TaskScheduleSheet` — this file's own header comment on why Deadline/Priority funnel through the one door rather than each growing a picker of its own. Date no longer does (issue #253) — see `onSetDate`/`onSetDateString`/`datesWithTasks` below. */
  onOpenSchedule: () => void;
  /** Sets or clears the Task's `date` (issue #253) — reaches this view's own `TaskSchedulePopover` instance for the Date attribute, mirroring `task-row-content.tsx`'s identical wiring. */
  onSetDate: (id: string, date: string | null) => void;
  /** Sets or clears the Task's Recurrence phrase (issue #253) — `TaskStore.setDateString`'s own doc comment (task-schedule-sheet.tsx) has the reasoning for why `date` is recomputed by the store rather than trusted from a caller. */
  onSetDateString: (id: string, dateString: string | null, now: string) => void;
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
 * comment editor (`meologue-parity-docs/todoist/live-audit-dom/flow5-CMT-03-
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
// field never pushes the Comment/Cancel buttons off a laptop screen. A cap
// rather than unbounded growth because this composer sits inside the detail
// dialog's single shared scroll container (it is not a pinned chat input), so
// an unbounded field would walk its own submit buttons out of view.
const COMMENT_FIELD_MAX_HEIGHT = 200;

function CommentRow({
  comment,
  onEdit,
  onRequestRemove,
}: {
  comment: Comment;
  onEdit: (text: string) => void;
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
      <button
        type="button"
        aria-label="Edit comment"
        onClick={startEditing}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Pencil aria-hidden="true" className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Delete comment"
        onClick={onRequestRemove}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}

/**
 * The always-visible "Add a comment" composer (issue #180's own
 * reference-behaviour note — never hidden behind an icon).
 *
 * **CMT-01: Ctrl/Cmd+Enter or the "Comment" button submits — Enter and
 * Shift+Enter both insert a newline.** This is the deliberate *opposite*
 * of the title field's own Enter-commits convention above
 * (`lifecycle.md`'s own header comment: "Two editors, two rules — do not
 * unify them"), so this composer's own `onKeyDown` only ever intercepts
 * the Mod+Enter chord, never plain Enter. Submitting clears the field for
 * the next Comment rather than leaving what was just sent sitting in the
 * box.
 */
function CommentComposer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Measured on the device before this: the field stayed 37.4px tall whether it
  // was empty, holding ~500 characters, or holding ~2000, while `scrollHeight`
  // for those same contents read 276px and 1016px. `resize: none` (this app's
  // convention for a field it lays out itself) meant it could not be dragged
  // bigger either, so a long comment was written into a one-line slot showing
  // about a twenty-seventh of itself.
  useAutoGrowTextarea(fieldRef, text, { maxHeight: COMMENT_FIELD_MAX_HEIGHT });

  function submit() {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    onSubmit(trimmed);
    setText("");
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex items-end gap-2"
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
      <button
        type="submit"
        className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm transition hover:bg-muted"
      >
        Comment
      </button>
    </form>
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
  // version of this comment said: `meologue-parity-docs/todoist/rename-capture-
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
  // CMT-03: deleting a Comment confirms first (ours used to delete with no
  // confirmation at all) — one dialog for the whole thread, named by which
  // Comment it's currently open for, mirroring `todo-page.tsx`'s own
  // `confirmingId`/`ConfirmDialog` pair for deleting a Task.
  const [confirmingCommentId, setConfirmingCommentId] = useState<string | null>(null);
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
        {wide && (
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </DialogPrimitive.Close>
        )}
      </header>

      {/* No longer the scroll container itself. Todoist scrolls its LEFT
          COLUMN and pins the comment composer beneath it as a sibling
          outside that region — driven live 2026-09-14
          (`detail-modal-todoist-2026-09-14.json`, `comments.scrollBehavior`):
          setting the container's `scrollTop` to 300 moved a posted comment
          by exactly 300px while the composer's form stayed at y=522. Here,
          one shared scroller over both columns meant the composer scrolled
          away the moment a thread got long — precisely when it is wanted.

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
            className="flex flex-col gap-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto"
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
              <DialogPrimitive.Title asChild>
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
              </DialogPrimitive.Title>
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

            {/* Comments (issue #180) — a thread below the description, an
              always-visible composer, the most recent Comment simply the
              last item in the list rather than hidden behind an icon
              (this ticket's own reference-behaviour note). */}
            <div className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-xs">
                Comments{comments.length > 0 ? ` (${comments.length})` : ""}
              </h2>
              {comments.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {comments.map((comment) => (
                    <CommentRow
                      key={comment.id}
                      comment={comment}
                      onEdit={(text) => onEditComment(comment.id, text)}
                      onRequestRemove={() => setConfirmingCommentId(comment.id)}
                    />
                  ))}
                </ul>
              )}
            </div>

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

            {/* Activity (issue #184, ADR 0056) — collapsed by default, open
              on request (this file's own header comment). Renders
              nothing when there's nothing to show yet, rather than an
              always-visible disclosure with nothing inside it. */}
            {renderableEvents.length > 0 && (
              <details className="rounded-lg border border-border">
                <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground text-sm">
                  Activity ({renderableEvents.length})
                </summary>
                <div className="border-t border-border">
                  <ActivityFeed
                    events={renderableEvents}
                    // CMT-06: no `currentTaskId`. Flow 5 read Todoist's own
                    // per-task activity and it names the task in every line
                    // ("You completed {task}", "You deleted a comment from
                    // {task}"), even though every line is about that task, so
                    // suppressing the subject here was the divergence itself.
                    // `tasks` holds this task so its subject resolves.
                    tasks={[task]}
                    projects={projects}
                  />
                </div>
              </details>
            )}
          </div>

          {/* Pinned beneath the scrolling region rather than inside it, as
            Todoist's is — it stays put while the thread scrolls. It sits
            below Activity in source order because it is the column's
            footer, not a member of the Comments block; Todoist has no
            Activity section here, so nothing in the record says where it
            would fall relative to one. */}
          <CommentComposer onSubmit={onAddComment} />
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
              if (task.dateString !== null) {
                onSetDateString(task.id, null, new Date().toISOString());
              }
            }}
            onPickRecurrence={(dateString) => {
              pendingRenameDateRef.current = null;
              onSetDateString(task.id, dateString, new Date().toISOString());
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
    <DialogPrimitive.Root open={true} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
