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
 * disclosure mirroring `CompletedTasks`'s own "collapsed by default, open
 * on request" shape — a secondary, occasional thing to check, not
 * something worth the vertical space open by default the way Comments
 * are. `events` is already narrowed to this one Task by the caller
 * (`listEventsByTask`, entry-store-layout.tsx), the identical "the
 * caller scopes it, this view only renders" split `comments` above
 * already takes.
 *
 * **Date, Deadline and Priority all open the identical `TaskScheduleSheet`
 * every row's own "Date" hover action already opens** (`onOpenSchedule`
 * below) — the brief's own "Reuse what exists" instruction, applied
 * literally: this view has no second Date/Deadline/Priority picker of its
 * own to keep in sync with the row's. Project and Labels have no existing
 * picker to reuse (neither TaskScheduleSheet nor anything else in this
 * app edits either), so this file builds the one inline control each
 * needs.
 */
import type { Comment, Event, Label, Project, Section, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import { ChevronLeft, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useRef, useState } from "react";
import { entryProse } from "@/components/entry-prose";
import { ActivityFeed } from "@/components/todo/activity-feed";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { priorityColour } from "@/lib/task-priority-colors";
import { cn } from "@/lib/utils";

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
  /** Opens the shared `TaskScheduleSheet` — this file's own header comment on why Date/Deadline/Priority all funnel through the one door rather than each growing a picker of its own. */
  onOpenSchedule: () => void;
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
   * This Task's own history (issue #184), newest first — already scoped
   * to this Task by the caller (`listEventsByTask`), the identical split
   * `comments` above already takes. `projects` above (this file's own
   * "Move to…" picker) doubles as `ActivityFeed`'s own "moved to
   * <Project>" name resolution — no second list needed for it.
   */
  events: Event[];
}

/** A Task's attribute, before it has one — a small, tappable pill rather than an empty row (this file's own header comment: "the view grows with the Task instead of showing empty fields"). */
function AttributePill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-fit rounded-full border border-border px-2.5 py-1 text-muted-foreground text-xs transition hover:border-foreground/30 hover:text-foreground"
    >
      {label}
    </button>
  );
}

/** A Task's attribute, once it has one — promoted into its own full-width row (this file's own header comment). */
function AttributeRow({
  icon,
  label,
  value,
  colour,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  /** A leading dot in this colour — Priority's own ring colour, or a Project's/Label's own swatch. Omitted for Date/Deadline, which carry no colour of their own. */
  colour?: string;
  onClick: () => void;
}) {
  return (
    <button
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
}

/**
 * One Comment in the thread (issue #180) — rendered inline, click to
 * edit in place, mirroring the Description block's own toggle between a
 * rendered view and a raw-Markdown textarea. A hover-revealed pencil/
 * trash pair rather than a swipe or a context menu: this file has no
 * other row chrome to match, and a Comment thread is short enough that
 * two small buttons cost nothing to keep visible on hover.
 */
function CommentRow({
  comment,
  onEdit,
  onRemove,
}: {
  comment: Comment;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);

  function startEditing() {
    setDraft(comment.text);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === comment.text) {
      setDraft(comment.text);
      return;
    }
    onEdit(trimmed);
  }

  if (editing) {
    return (
      <li>
        <textarea
          aria-label="Edit comment"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(comment.text);
              event.currentTarget.blur();
            }
          }}
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-transparent p-2 text-sm outline-none"
        />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-1 rounded-md p-1.5 text-sm transition hover:bg-muted">
      <div className="min-w-0 flex-1 [&_p]:my-0 [&_ul]:my-0">{entryProse(comment.text)}</div>
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
        onClick={onRemove}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}

/**
 * The always-visible "Add a comment" composer (issue #180's own
 * reference-behaviour note — never hidden behind an icon). Enter submits,
 * Shift+Enter inserts a newline, mirroring the title field's identical
 * Enter-commits convention above; submitting clears the field for the
 * next Comment rather than leaving what was just sent sitting in the box.
 */
function CommentComposer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");

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
        aria-label="Add a comment"
        placeholder="Add a comment"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
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
  onNavigate,
  onRename,
  onComplete,
  onUncomplete,
  onOpenSchedule,
  onSetProject,
  onSetLabels,
  onSetDescription,
  comments,
  onAddComment,
  onEditComment,
  onRemoveComment,
  events,
  wide,
  titleRef,
}: Omit<TaskDetailViewProps, "onClose"> & {
  wide: boolean;
  /** The outer `TaskDetailView`'s own ref (its header comment explains why) — attached to the title textarea below so Radix's `onOpenAutoFocus` can name it explicitly. */
  titleRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [title, setTitle] = useState(task.content);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingLabels, setPickingLabels] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? "");
  const uiPriority = uiPriorityOf(task.priority);

  function commitTitle() {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === task.content) {
      setTitle(task.content);
      return;
    }
    onRename(trimmed);
  }

  function openDescriptionEditor() {
    setDescriptionDraft(task.description ?? "");
    setEditingDescription(true);
  }

  // Trims only — the identical "never reflows a body, only trims it"
  // convention normalizeEntryBody (entry-text.ts) already follows for an
  // Entry's own body, applied here for the identical reason: a
  // Description is Markdown text, and internal newlines are part of what
  // was typed, not incidental whitespace this view gets to discard.
  function commitDescription() {
    setEditingDescription(false);
    const trimmed = descriptionDraft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next !== task.description) {
      onSetDescription(next);
    }
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

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* The title, editable in place (issue #178's own acceptance
              criterion) — commits on blur or Enter, mirroring
              project-view.tsx's identical `commitRename` shape for its
              own name field. Editable regardless of completion state:
              nothing about this view's own scope refuses a rename of a
              completed Task, and task-row.tsx's own checkbox doesn't
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
              <textarea
                ref={titleRef}
                aria-label="Task title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setTitle(task.content);
                  }
                }}
                rows={1}
                className={cn(
                  "w-full resize-none border-none bg-transparent p-0 font-medium text-base outline-none",
                  task.completedAt !== null && "text-muted-foreground line-through",
                )}
              />
            </DialogPrimitive.Title>
          </div>

          {/* Description (issue #180) — directly under the title, not in
              the sidebar (this file's own header comment). Pill until it
              has words, then a rendered, click-to-edit block — the
              identical promotion Project/Date/Deadline/Priority/Labels
              use below, extended to cover this attribute too. */}
          {task.description === null && !editingDescription ? (
            <AttributePill label="Description" onClick={openDescriptionEditor} />
          ) : editingDescription ? (
            <textarea
              aria-label="Task description"
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              onBlur={commitDescription}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDescriptionDraft(task.description ?? "");
                  event.currentTarget.blur();
                }
              }}
              placeholder="Add a description…"
              rows={4}
              className="w-full resize-none rounded-md border border-border bg-transparent p-2 text-sm outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={openDescriptionEditor}
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
                    onRemove={() => onRemoveComment(comment.id)}
                  />
                ))}
              </ul>
            )}
            <CommentComposer onSubmit={onAddComment} />
          </div>

          {/* Activity (issue #184, ADR 0056) — collapsed by default,
              mirroring CompletedTasks' own disclosure shape (this file's
              own header comment). Renders nothing when there's nothing
              to show yet, the same "don't show a section with nothing in
              it" restraint CompletedTasks itself takes. */}
          {events.length > 0 && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground text-sm">
                Activity ({events.length})
              </summary>
              <div className="border-t border-border">
                <ActivityFeed
                  events={events}
                  // Every Event this view reads is already scoped to
                  // `task.id` (`listEventsByTask`, entry-store-layout.tsx),
                  // so its own subject is always suppressed below and
                  // `resolveTaskSubject` never actually runs against this
                  // list — see `format-event.ts`'s own `describeEventLine`.
                  tasks={[]}
                  projects={projects}
                  currentTaskId={task.id}
                />
              </div>
            </details>
          )}
        </div>

        {/* The attribute sidebar — Project, Date, Deadline, Priority,
            Labels, pill-or-row per this file's own `AttributePill`/
            `AttributeRow` doc comments. `sm:w-56` only takes effect
            alongside the `sm:flex-row` above, so a narrow sheet still
            stacks this beneath the title instead of squeezing both into
            one row. */}
        <div className="flex shrink-0 flex-col gap-1 sm:w-56">
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
          {task.date === null ? (
            <AttributePill label="Date" onClick={onOpenSchedule} />
          ) : (
            <AttributeRow
              icon={null}
              label="Date"
              value={formatTaskDate(task.date)}
              onClick={onOpenSchedule}
            />
          )}
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
  // Radix Dialog's own default `onOpenAutoFocus` focuses the first
  // tabbable descendant of `Content` — the title textarea, before issue
  // #184's own completion checkbox landed just ahead of it in the DOM.
  // Adding that checkbox silently moved initial focus onto it instead
  // (caught by a pre-existing test, "Enter commits the title," which
  // relies on the title already being focused when Enter is pressed —
  // the identical assumption a reader opening a Task to edit its title
  // makes). Naming the title explicitly here restores that regardless of
  // which element happens to sit first in tab order, rather than this
  // view's own initial focus depending on an incidental ordering.
  const titleRef = useRef<HTMLTextAreaElement>(null);

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
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleRef.current?.focus();
          }}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-lg outline-hidden duration-150",
            wide
              ? "top-1/2 left-1/2 h-[min(32rem,80vh)] w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
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
          <TaskDetailBody {...props} wide={wide} titleRef={titleRef} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
