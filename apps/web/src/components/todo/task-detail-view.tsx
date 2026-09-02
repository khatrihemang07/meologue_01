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
 * **Out of scope, deliberately** (issue #178's own report names these
 * rather than leaving them to look like oversights): description and
 * comments (issue #180 — the placeholder row below says so in the running
 * app, not only in this comment), the composer chip that would open this
 * route directly from a Sent checkbox (issue #181), the activity log
 * (issue #184), and duration — `Task.duration` is being removed in a
 * concurrent ticket (issue #179) and nothing here reads or renders it.
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
import type { Label, Project, Section, Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useState } from "react";
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
  /** Opens the shared `TaskScheduleSheet` — this file's own header comment on why Date/Deadline/Priority all funnel through the one door rather than each growing a picker of its own. */
  onOpenSchedule: () => void;
  onSetProject: (projectId: string | null) => void;
  onSetLabels: (labelIds: string[]) => void;
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
  onOpenSchedule,
  onSetProject,
  onSetLabels,
  wide,
}: Omit<TaskDetailViewProps, "onClose"> & { wide: boolean }) {
  const [title, setTitle] = useState(task.content);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingLabels, setPickingLabels] = useState(false);
  const uiPriority = uiPriorityOf(task.priority);

  function commitTitle() {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === task.content) {
      setTitle(task.content);
      return;
    }
    onRename(trimmed);
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
              own name field. */}
          <DialogPrimitive.Title asChild>
            <textarea
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
              className="w-full resize-none border-none bg-transparent p-0 font-medium text-base outline-none"
            />
          </DialogPrimitive.Title>

          {/* Description and comments are issue #180's own scope — see
              this file's own header comment. A plain, muted line rather
              than silence: a reader who scrolls this far should see that
              nothing is missing by accident. */}
          <p className="text-muted-foreground text-xs italic">
            Description and comments aren't built yet.
          </p>
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
          <TaskDetailBody {...props} wide={wide} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
