/**
 * One Project's own screen — its header (name, colour, favourite,
 * archived, description), its Sections (issue #171's own acceptance
 * criteria: flat, manually ordered, capped at twenty, an optional
 * description, and a delete that "names the count and says it cannot be
 * undone"), and its own Tasks via `TaskList` (task-list.tsx) — "opening a
 * Project lists its Tasks, reusing the list Inbox already uses."
 *
 * Section reordering is a pair of up/down buttons, not drag: nothing in
 * issue #171's acceptance criteria asks a Section's own order to be
 * drag-reorderable (only "ordered manually" — Tasks are the one thing
 * this ticket names drag/keyboard for by name), and at most twenty
 * Sections is small enough that two buttons cost a reader nothing a drag
 * gesture would have saved them.
 */
import type { Project, Section, Task } from "@meologue/core";
import { orderKeyBetween } from "@meologue/core";
import { ChevronDown, ChevronUp, History, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { TaskList } from "@/components/todo/task-list";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ProjectViewProps {
  project: Project;
  sections: Section[];
  tasks: Task[];
  /** Forwarded straight through to `TaskList` — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  onRename: (name: string) => void;
  onSetDescription: (description: string | null) => void;
  onToggleFavourite: (favourite: boolean) => void;
  onToggleArchived: (archived: boolean) => void;
  /** Rejects — legibly, per this ticket's own brief — on the twenty-Section cap or an empty name (ProjectStore.addSection's own doc comment). */
  onAddSection: (name: string) => Promise<void>;
  onRenameSection: (id: string, name: string) => void;
  onReorderSection: (id: string, orderKey: string) => void;
  onArchiveSection: (id: string) => void;
  onUnarchiveSection: (id: string) => void;
  onDeleteSection: (id: string) => void;
  /** The true number of Tasks a Section's own delete would destroy, walked the same way ProjectStore.deleteSection itself walks it — this component's own `handleRequestDeleteSection` awaits this before it ever opens the confirmation, so the count on screen and the count about to be destroyed can never disagree. */
  countSectionDestruction: (sectionId: string) => Promise<number>;
  onComplete: (task: Task) => void;
  onCompleteForever: (task: Task) => void;
  onRequestDelete: (task: Task) => void;
  onOpenSchedule: (task: Task) => void;
  onMoveToSection: (taskId: string, sectionId: string | null) => void;
  reorderTask: (id: string, orderKey: string) => void;
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
}

/** The identical fractional-insert arithmetic lib/task-reorder.ts's `reorderedTaskOrderKey` uses, generalised to any `{id, orderKey}` row — kept local rather than imported from that Task-specific module, since Section reordering here is two buttons, not a drag recogniser, and pulling in a Task-shaped helper for a Section-shaped move would read as borrowing the wrong module's vocabulary for what it does. */
function reorderedKey(
  items: { id: string; orderKey: string }[],
  id: string,
  dropIndex: number,
): string {
  const withoutMoved = items.filter((item) => item.id !== id);
  const clamped = Math.max(0, Math.min(dropIndex, withoutMoved.length));
  const before = withoutMoved[clamped - 1]?.orderKey ?? null;
  const after = withoutMoved[clamped]?.orderKey ?? null;
  return orderKeyBetween(before, after);
}

export function ProjectView({
  project,
  sections,
  tasks,
  detailActions,
  onRename,
  onSetDescription,
  onToggleFavourite,
  onToggleArchived,
  onAddSection,
  onRenameSection,
  onReorderSection,
  onArchiveSection,
  onUnarchiveSection,
  onDeleteSection,
  countSectionDestruction,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onMoveToSection,
  reorderTask,
  setTaskParent,
  listTaskChildren,
  listTasksInProject,
}: ProjectViewProps) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [newSectionName, setNewSectionName] = useState("");
  const [sectionError, setSectionError] = useState<string | null>(null);
  // The Section this dialog would delete, and the true count it's about
  // to destroy — `null` means closed. Populated together, by
  // `handleRequestDeleteSection` below, so the dialog never renders with
  // a stale or placeholder count (this component's own doc comment on
  // `countSectionDestruction`).
  const [confirmingDelete, setConfirmingDelete] = useState<{
    section: Section;
    count: number;
  } | null>(null);

  function commitRename() {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === project.name) return;
    onRename(trimmed);
  }

  function handleDescriptionBlur() {
    const trimmed = description.trim();
    onSetDescription(trimmed === "" ? null : trimmed);
  }

  async function handleAddSection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSectionError(null);
    try {
      await onAddSection(newSectionName);
      setNewSectionName("");
    } catch (error) {
      // A Section that fails to add is refused legibly, not a throw into
      // a void (this ticket's own brief) — most reachably the twenty-cap
      // (ProjectStore.addSection's own doc comment), shown right where
      // the reader was trying to add one rather than as a toast that's
      // already gone by the time they look up.
      setSectionError(error instanceof Error ? error.message : "Couldn't add this Section.");
    }
  }

  async function handleRequestDeleteSection(section: Section) {
    const count = await countSectionDestruction(section.id);
    setConfirmingDelete({ section, count });
  }

  const sortedSections = [...sections].sort((a, b) =>
    a.orderKey === b.orderKey ? a.id.localeCompare(b.id) : a.orderKey < b.orderKey ? -1 : 1,
  );

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: project.colour }}
          />
          <Input
            type="text"
            aria-label="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            className="flex-1 font-medium"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={project.favourite}
            onClick={() => onToggleFavourite(!project.favourite)}
          >
            {project.favourite ? "Favourited" : "Favourite"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onToggleArchived(!project.archived)}
          >
            {project.archived ? "Unarchive" : "Archive"}
          </Button>
          {/* Issue #184 / ADR 0056: this Project's own history — the same
              `/todo/activity` route the global view uses, opened with
              `?projectId=` (todo-page.tsx's own `activityProjectId`),
              never a second view rendering the identical log. */}
          <Button type="button" size="sm" variant="outline" asChild>
            <Link
              to={`/todo/activity?projectId=${project.id}`}
              aria-label="View this Project's activity"
            >
              <History aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </div>
        <textarea
          aria-label="Project description"
          placeholder="Description (optional)"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={handleDescriptionBlur}
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">Sections ({sections.length}/20)</h2>
        <ul className="flex flex-col">
          {sortedSections.map((section, index) => (
            <li
              key={section.id}
              className="flex items-center gap-2 border-border border-b py-1.5 last:border-b-0"
            >
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  aria-label={`Move "${section.name}" earlier`}
                  disabled={index === 0}
                  onClick={() =>
                    onReorderSection(
                      section.id,
                      reorderedKey(sortedSections, section.id, index - 1),
                    )
                  }
                  className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ChevronUp aria-hidden="true" className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move "${section.name}" later`}
                  disabled={index === sortedSections.length - 1}
                  onClick={() =>
                    onReorderSection(
                      section.id,
                      reorderedKey(sortedSections, section.id, index + 1),
                    )
                  }
                  className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </button>
              </div>
              <input
                type="text"
                aria-label={`Section name`}
                defaultValue={section.name}
                onBlur={(event) => {
                  const trimmed = event.target.value.trim();
                  if (trimmed !== "" && trimmed !== section.name) {
                    onRenameSection(section.id, trimmed);
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-border focus:border-border"
              />
              {section.archived && (
                <span className="shrink-0 text-muted-foreground text-xs">Archived</span>
              )}
              {/*
                Archive and Delete sit side by side with wildly different
                blast radius (issue #171's own brief) — Archive completes
                every Task in the Section and keeps them; Delete destroys
                them, unrecoverably. Archive is a plain outline Button,
                Delete is destructive-styled and behind ConfirmDialog, so
                the two read as different weights of action even before a
                reader reads either label.
              */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={
                  section.archived
                    ? `Unarchive Section "${section.name}"`
                    : `Archive Section "${section.name}"`
                }
                onClick={() =>
                  section.archived ? onUnarchiveSection(section.id) : onArchiveSection(section.id)
                }
              >
                {section.archived ? "Unarchive" : "Archive"}
              </Button>
              <button
                type="button"
                aria-label={`Delete Section "${section.name}"`}
                onClick={() => handleRequestDeleteSection(section)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        {sections.length >= 20 ? (
          <p className="text-muted-foreground text-xs">
            This Project already holds twenty Sections — its own cap.
          </p>
        ) : (
          <form onSubmit={handleAddSection} className="flex gap-2">
            <Input
              type="text"
              placeholder="New Section"
              aria-label="New Section's name"
              value={newSectionName}
              onChange={(event) => setNewSectionName(event.target.value)}
              className="flex-1"
            />
            {/* "Add Section," not the bare "Add" this page's own
                AddTaskForm button already uses (todo-page.tsx renders both
                on this same screen) — a reader tabbing between the two, or
                a screen reader announcing either by name alone, needs them
                to read as two different actions. */}
            <Button type="submit" size="sm" disabled={newSectionName.trim() === ""}>
              Add Section
            </Button>
          </form>
        )}
        {sectionError !== null && (
          <p role="alert" className="text-destructive text-xs">
            {sectionError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">Tasks</h2>
        <TaskList
          tasks={tasks}
          sections={sections.filter((section) => !section.archived)}
          projectId={project.id}
          emptyMessage="Nothing in this Project yet. Add a Task above to get started."
          detailActions={detailActions}
          onComplete={onComplete}
          onCompleteForever={onCompleteForever}
          onRequestDelete={onRequestDelete}
          onOpenSchedule={onOpenSchedule}
          onMoveToSection={onMoveToSection}
          reorderTask={reorderTask}
          setTaskParent={setTaskParent}
          listTaskChildren={listTaskChildren}
          listTasksInProject={listTasksInProject}
        />
      </div>

      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(null);
        }}
        title={confirmingDelete ? `Delete "${confirmingDelete.section.name}"?` : ""}
        description={
          confirmingDelete && (
            <>
              This destroys {confirmingDelete.count}{" "}
              {confirmingDelete.count === 1 ? "Task" : "Tasks"} in this Section, completed ones
              included. This cannot be undone — unlike Archive, which keeps every Task, just
              completed. The only way back is whenever you last ran an Export by hand.
            </>
          )
        }
        confirmLabel="Delete Section"
        onConfirm={() => {
          if (confirmingDelete) {
            onDeleteSection(confirmingDelete.section.id);
          }
        }}
      />
    </div>
  );
}
