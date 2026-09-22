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
import { LazyTaskSchedulePopover } from "@/components/todo/lazy-task-schedule-popover";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { taskTitleText } from "@/components/todo/task-title-text";
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
import { localDateTimeKey, localDayKey } from "@/lib/local-day-key";
import type { QuickAddAutocompleteOptions } from "@/lib/quick-add-autocomplete";
import { useSettingsStore } from "@/lib/settings";
import { taskDetailPath } from "@/lib/task-detail-route";
import { priorityColour } from "@/lib/task-priority-colors";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";
import { cn } from "@/lib/utils";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";

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
  /** Opens the shared `TaskScheduleSheet` — Priority's own picker, since issue #376 removed Deadline's half of it. Date has never gone through it (issue #253) — see `onSetDate`/`onSetDateString`/`datesWithTasks` below. */
  onOpenSchedule: () => void;
  /** Sets or clears the Task's `date` (issue #253) — reaches this view's own `TaskSchedulePopover` instance for the Date attribute, mirroring `task-row-content.tsx`'s identical wiring. */
  onSetDate: (id: string, date: string | null) => void;
  /** Sets or clears the Task's Recurrence phrase (issue #253) — `TaskStore.setDateString`'s own doc comment (task-schedule-sheet.tsx) has the reasoning for why `date` is recomputed by the store rather than trusted from a caller. `today` (not an instant — issue #296, `lib/local-day-key.ts`'s `localDayKey`) is what this view threads through below. */
  onSetDateString: (id: string, dateString: string | null, today: LocalDayKey) => void;
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
 * trigger click is what opens its popover — where Project/Priority/Labels
 * below still pass one to toggle their own local picker.
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
    /** A leading dot in this colour — Priority's own ring colour, or a Project's/Label's own swatch. Omitted for Date, which carries no colour of its own. */
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
  onCopyLink: () => void;
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
        {timestamp !== null && (
          <div className="text-[length:0.75rem] text-muted-foreground leading-4">{timestamp}</div>
        )}
        <div className="break-words [&_p]:my-0 [&_ul]:my-0">
          {entryProse(comment.text, undefined, undefined, undefined, "comment")}
        </div>
      </div>
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
 * not that component reused wholesale: that menu's own items —
 * Edit, Date…, Priority, Labels, Move to… — either have no
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
                <LazyActivityFeed events={events} tasks={[task]} projects={projects} />
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
  contentRef: React.RefObject<HTMLDivElement | null>;
  dismissGuardRef: React.RefObject<((source: "escape" | "outside") => boolean) | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [focusField, setFocusField] = useState<"title" | "description">("title");
  const [titleDraft, setTitleDraft] = useState(task.content);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? "");
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);
  const titleRecognitionOptionsRef = useRef({ now: localDateTimeKey(new Date()), smartDates });
  titleRecognitionOptionsRef.current = { now: localDateTimeKey(new Date()), smartDates };
  const autocompleteOutlet = useOutletContext<EntryStoreOutletContext | undefined>();
  const titleAutocomplete: QuickAddAutocompleteOptions = {
    getProjects: () => projects,
    getLabels: () => labels,
    onCreateProject: autocompleteOutlet?.addProject,
    onCreateLabel: autocompleteOutlet?.addLabel,
  };
  const autocompletePopupOpenRef = useRef(false);
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
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const [confirmingCommentId, setConfirmingCommentId] = useState<string | null>(null);
  function copyCommentLink(comment: Comment) {
    const url = `${window.location.origin}${taskDetailPath(task)}#comment-${comment.id}`;
    navigator.clipboard?.writeText(url).then(
      () => toast("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  }
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const cancelTriggeredByOutsideClickRef = useRef(false);
  const discardConfirmedRef = useRef(false);
  const lastFocusedEditorRef = useRef<HTMLElement | null>(null);
  const editColumnRef = useRef<HTMLDivElement>(null);
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

  const pendingRenameDateRef = useRef<{ taskId: string; previousDate: string | null } | null>(null);

  function raiseDateResolvedToast(taskId: string, dayText: string, previousDate: string | null) {
    toast(`Date updated to ${dayText}`, {
      duration: RENAME_DATE_TOAST_DURATION_MS,
      action: {
        label: "Undo",
        onClick: () => onSetDate(taskId, previousDate),
      },
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: task.date/task.id are the only real re-run triggers; dateDisplay and raiseDateResolvedToast are derived from them each render, not independent inputs.
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

  function hasUnsavedChanges() {
    const trimmedTitle = titleDraft.trim();
    const titleChanged = trimmedTitle !== "" && trimmedTitle !== task.content;
    const trimmedDescription = descriptionDraft.trim();
    const nextDescription = trimmedDescription === "" ? null : trimmedDescription;
    const descriptionChanged = nextDescription !== task.description;
    return titleChanged || descriptionChanged;
  }

  function requestCancelEditing(fromOutsideClick = false) {
    if (hasUnsavedChanges()) {
      cancelTriggeredByOutsideClickRef.current = fromOutsideClick;
      setDiscardConfirmOpen(true);
      return;
    }
    cancelEditing();
  }

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

  dismissGuardRef.current = (source) => {
    if (!editing) {
      return false;
    }
    if (source === "escape" && autocompletePopupOpenRef.current) {
      closeAutocompleteRef.current?.();
      return true;
    }
    requestCancelEditing(source === "outside");
    return true;
  };

  function saveEditing(titleText?: string) {
    setEditing(false);
    const trimmedTitle = (titleText ?? titleDraft).trim();
    if (trimmedTitle !== "" && trimmedTitle !== task.content) {
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
                        commitOnBlur={false}
                        className="font-medium text-base"
                        extraPlugins={[
                          quickAddRecognitionPlugin(() => titleRecognitionOptionsRef.current),
                        ]}
                        autocomplete={titleAutocomplete}
                        onAutocompleteOpenChange={(open) => {
                          autocompletePopupOpenRef.current = open;
                        }}
                        closeAutocompleteRef={closeAutocompleteRef}
                      />
                    </Suspense>
                  </div>
                ) : (
                  // biome-ignore lint/a11y/noStaticElementInteractions: the title at rest is a plain, non-interactive div, so the click handler has no button/role to live on — the click-catcher just below (`task-detail-edit-column`) already sets this file's precedent for a `biome-ignore` here rather than a synthetic role.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: `tabIndex={-1}` takes this out of Tab order, so there is no keyboard event to pair the click with; keyboard activation of the title at rest is intentionally not supported.
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
                    {taskTitleText(task.content)}
                  </div>
                )}
              </DialogTitle>
            </div>
            <span id={titleHintId} className="sr-only">
              Activate to edit the task name
            </span>

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

            {comments.length > 0 && (
              <details open>
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

            <ConfirmDialog
              open={discardConfirmOpen}
              onOpenChange={setDiscardConfirmOpen}
              title="Discard unsaved changes?"
              description="Your unsaved changes will be discarded."
              confirmLabel="Discard"
              onConfirm={() => {
                discardConfirmedRef.current = true;
                cancelEditing();
                if (cancelTriggeredByOutsideClickRef.current) {
                  onClose();
                }
              }}
              onCloseAutoFocus={(event) => {
                if (discardConfirmedRef.current) {
                  discardConfirmedRef.current = false;
                  return;
                }
                event.preventDefault();
                lastFocusedEditorRef.current?.focus();
              }}
            />

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

        {/* The attribute sidebar — Project, Date, Priority,
            Labels, pill-or-row per this file's own `AttributePill`/
            `AttributeRow` doc comments. `sm:w-56` only takes effect
            alongside the `sm:flex-row` above, so a narrow sheet still
            stacks this beneath the title instead of squeezing both into
            one row. */}
        <div className="flex shrink-0 flex-col gap-1 sm:min-h-0 sm:w-56 sm:overflow-y-auto">
          {/*
            Project — the one attribute that's never truly "unset" the way
            Date/Priority/Labels can be (CONTEXT.md's Inbox
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

            Issue #439's own bundle-size follow-up: this used to import
            `TaskSchedulePopover` straight from `task-schedule-popover.tsx`
            (a STATIC import), which made every byte that file statically
            pulls in — `date-fns`, Radix `Popover`, and, since #439's own
            endless month list, `@tanstack/react-virtual` and
            `lib/month-list.ts` too — count against THIS view's own
            `check-bundle-size.mjs` budget, even though nothing here needs
            any of it until a reader actually opens the Date picker.
            `task-row-content.tsx`'s hover Date button and
            `quick-add-content.tsx`'s date chip already went through
            `LazyTaskSchedulePopover` (`lazy-task-schedule-popover.ts`'s
            own header comment — issue #416's identical fix, for the
            identical reason) for exactly this; this view's own instance
            had simply never been switched over, and #439's own new weight
            is what finally pushed its total over budget (78,760 measured
            gzip bytes against a 73,000 ceiling) rather than growing the
            chunk quietly forever. `<Suspense>`'s own fallback below
            renders the IDENTICAL trigger markup, inertly (no `onClick` —
            nothing can open before the chunk has loaded anyway), so there
            is no visible flash while `import()` resolves.
          */}
          <Suspense
            fallback={
              task.date === null || dateDisplay === null ? (
                <AttributePill label="Date" />
              ) : (
                <AttributeRow
                  icon={null}
                  label="Date"
                  value={<span style={{ color: dateDisplay.colour }}>{dateDisplay.text}</span>}
                />
              )
            }
          >
            <LazyTaskSchedulePopover
              open={dateScheduleOpen}
              onOpenChange={setDateScheduleOpen}
              dateDay={dateDay}
              dateTime={dateTime}
              onSetTime={(time) => {
                pendingRenameDateRef.current = null;
                setScheduleTime(time);
              }}
              dateString={task.dateString}
              datesWithTasks={datesWithTasks}
              onPickDay={(day) => {
                pendingRenameDateRef.current = null;
                setScheduleDay(day);
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
          </Suspense>
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
  const dismissGuardRef = useRef<((source: "escape" | "outside") => boolean) | null>(null);

  function handleOpenChange(open: boolean) {
    if (!open) {
      props.onClose();
    }
  }

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogPortal>
        {/* The scrim fades only on the bottom sheet. This branch is an
            interpretation, not a decision that was handed down: the owner
            asked for the wide modal to pop and for the narrow sheet to keep
            its slide, and said nothing about the overlay, which until now
            was unconditional. Read literally, "drop it from the overlay too"
            would have stopped the scrim fading on the sheet as well — so the
            sheet would have slid up behind a scrim that was already at full
            strength. Keeping the fade tied to the branch that still animates
            is the reading that preserves what the owner did ask for on each
            side. Flagged here rather than presented as settled, because it
            was nobody's stated choice; if the scrim should pop on both, this
            is the line to change. */}
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50",
            !wide &&
              "duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogContent
          open={true}
          aria-describedby={undefined}
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
            "fixed z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground shadow-[var(--td-modal-shadow)] outline-hidden duration-150",
            // The wide modal has no entrance at all: it renders at its
            // final geometry, like Todoist's own, measured with an 8ms
            // sampler — `transform: none`, `opacity: 1`, and
            // `document.getAnimations()` empty at every sample including
            // the first frame the dialog existed. The bottom sheet keeps
            // its slide: a sheet rising from the screen edge is a
            // different affordance from a centred dialog, and Todoist was
            // only ever measured at 1260px, so popping it here would be
            // extrapolating past the evidence. Note `useWideLayout()` is
            // `(min-width: 900px)` and the Tauri window opens at 800px, so
            // the desktop app shows the sheet branch by default.
            wide
              ? "top-1/2 left-1/2 h-[min(48.25rem,calc(100vh-8rem))] w-[min(54rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg"
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
