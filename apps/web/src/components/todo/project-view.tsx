import type { Project, Section, Task } from "@meologue/core";
import { orderKeyBetween } from "@meologue/core";
import { History, MoreHorizontal, Trash2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type FormEvent, useRef, useState } from "react";
import { Link } from "react-router";
import { ProjectEditDialog } from "@/components/todo/project-edit-dialog";
import { TaskList } from "@/components/todo/task-list";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const menuItemClassName =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

export interface ProjectViewProps {
  project: Project;
  sections: Section[];
  tasks: Task[];
  completedTasks?: Task[];
  /** Un-completes a Task from `completedTasks` above — forwarded straight through to `TaskList`. */
  onUncomplete?: (task: Task) => void;
  /** Forwarded straight through to `TaskList` — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  onRename: (name: string) => void;
  /** Issue #229 — reaches ProjectStore.setProjectColour, previously wired to no UI at all (the static colour dot had no control beside it). */
  onSetColour: (colour: string) => void;
  onSetDescription: (description: string | null) => void;
  /**
   * Issue #297 — every Project, forwarded straight through to
   * `ProjectEditDialog`'s own `projects` prop so its Parent chooser has a
   * pool to narrow down (that component's own doc comment).
   *
   * Optional, and the reason is the test harness rather than production:
   * `todo-page.tsx` — the only production caller — passes the full list
   * unconditionally, so at runtime this is always supplied. What optional
   * buys is that `project-view.test.tsx` can render this component
   * directly without assembling a Project pool for cases that have
   * nothing to do with parenting. Omitted, it falls back to `[project]`
   * alone: the chooser then offers only "No parent", which is honest for
   * a caller that could not say what else exists.
   */
  projects?: Project[];
  /**
   * Issue #297 — reaches `ProjectStore.setProjectParent`, forwarded
   * straight through to `ProjectEditDialog`. Optional, mirroring that
   * component's own `onSetParent` doc comment: `undefined` hides the
   * Parent field there entirely rather than rendering one with nothing
   * behind it.
   */
  onSetParent?: (parentId: string | null) => Promise<void>;
  onToggleFavourite: (favourite: boolean) => void;
  onToggleArchived: (archived: boolean) => void;
  onDeleteProject: () => void;
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
  /** Issue #298 — see TaskTree's own prop doc. */
  countTaskChildren: (parentId: string) => Promise<{ done: number; total: number }>;
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
  completedTasks = [],
  onUncomplete,
  detailActions,
  onRename,
  onSetColour,
  onSetDescription,
  projects,
  onSetParent,
  onToggleFavourite,
  onToggleArchived,
  onDeleteProject,
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
  countTaskChildren,
  listTasksInProject,
}: ProjectViewProps) {
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
  // Issue #229's own Project delete — `boolean`, not a captured target
  // the way `confirmingDelete` above needs one: unlike a Section's own
  // destruction count (awaited fresh before the dialog opens), Todoist's
  // own wording for a Project delete names nothing but the Project this
  // whole screen is already about, so there is nothing to look up first.
  const [confirmingDeleteProject, setConfirmingDeleteProject] = useState(false);
  const [editing, setEditing] = useState(false);
  // Issue #342 — `ProjectEditDialog`'s own `restoreFocusTo`: the "Project
  // options menu" trigger below, the one still-mounted place a keyboard
  // user actually was once its `DropdownMenu.Item` ("Edit") unmounts with
  // the menu, before `ProjectEditDialog` even opens.
  const projectOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const focusSectionInputAfterCloseRef = useRef(false);
  const sectionNameInputRef = useRef<HTMLInputElement>(null);

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
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: project.colour }}
          />
          {/* Plain text, not a heading: todo-page.tsx already renders the
              column's heading with this name (#254), and two headings would
              announce the project twice. */}
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{project.name}</span>
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
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                ref={projectOptionsTriggerRef}
                type="button"
                aria-label="Project options menu"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                className="z-50 flex w-40 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
              >
                <DropdownMenu.Item className={menuItemClassName} onSelect={() => setEditing(true)}>
                  Edit
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            type="button"
            aria-label={`Delete Project "${project.name}"`}
            onClick={() => setConfirmingDeleteProject(true)}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        </div>
        {project.description !== null && project.description !== "" && (
          <p className="whitespace-pre-wrap text-muted-foreground text-sm">{project.description}</p>
        )}
      </div>

      {/* Keyed on `editing` itself (mirrors labels-view.tsx's own
          `dialogTarget`-keyed `LabelDialog`) — `ProjectEditDialog` seeds
          its form fields from `project` once, in `useState`'s initial
          value, not on every render, so it has to remount on each open
          to pick up the Project's current name/colour/description rather
          than whatever a previous open (edited, then cancelled) left
          sitting in its own state. */}
      <ProjectEditDialog
        key={editing ? "open" : "closed"}
        open={editing}
        onOpenChange={setEditing}
        project={project}
        projects={projects ?? [project]}
        onRename={onRename}
        onSetColour={onSetColour}
        onSetDescription={onSetDescription}
        onSetParent={onSetParent}
        restoreFocusTo={projectOptionsTriggerRef}
      />

      <div className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">Sections ({sections.length}/20)</h2>
        <ul className="flex flex-col">
          {sortedSections.map((section, index) => (
            <li
              key={section.id}
              className="flex items-center gap-2 border-border border-b py-1.5 last:border-b-0"
            >
              {editingSectionId === section.id ? (
                <input
                  ref={sectionNameInputRef}
                  type="text"
                  aria-label="Section name"
                  defaultValue={section.name}
                  onBlur={(event) => {
                    const trimmed = event.target.value.trim();
                    if (trimmed !== "" && trimmed !== section.name) {
                      onRenameSection(section.id, trimmed);
                    }
                    setEditingSectionId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 py-1 text-sm"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm">{section.name}</span>
              )}
              {section.archived && (
                <span className="shrink-0 text-muted-foreground text-xs">Archived</span>
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Section options menu"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    className="z-50 flex w-40 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
                    // See `focusSectionInputAfterCloseRef`'s own comment
                    // above — not preventDefault()-ed except in the Edit
                    // case, so every other item keeps Radix's ordinary
                    // "return focus to the trigger" behaviour.
                    onCloseAutoFocus={(event) => {
                      if (!focusSectionInputAfterCloseRef.current) {
                        return;
                      }
                      focusSectionInputAfterCloseRef.current = false;
                      event.preventDefault();
                      sectionNameInputRef.current?.focus();
                    }}
                  >
                    <DropdownMenu.Item
                      className={menuItemClassName}
                      onSelect={() => {
                        focusSectionInputAfterCloseRef.current = true;
                        setEditingSectionId(section.id);
                      }}
                    >
                      Edit
                    </DropdownMenu.Item>
                    {/* Reorders within this Project — meologue has no
                        cross-Project Section move (this file's own header
                        comment). Still a `Sub`, still keyboard-reachable,
                        mirroring the Priority submenu (task-command-
                        menu.tsx). */}
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className={menuItemClassName}>
                        Move to…
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent className="z-50 flex w-40 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                          <DropdownMenu.Item
                            className={menuItemClassName}
                            disabled={index === 0}
                            onSelect={() =>
                              onReorderSection(
                                section.id,
                                reorderedKey(sortedSections, section.id, index - 1),
                              )
                            }
                          >
                            Move earlier
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={menuItemClassName}
                            disabled={index === sortedSections.length - 1}
                            onSelect={() =>
                              onReorderSection(
                                section.id,
                                reorderedKey(sortedSections, section.id, index + 1),
                              )
                            }
                          >
                            Move later
                          </DropdownMenu.Item>
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                    {/* Archive completes every Task in the Section and
                        keeps them; Delete (below) destroys them,
                        unrecoverably — issue #171's own "make the
                        difference in blast radius visible," now a
                        non-destructive menu item beside a destructive
                        one rather than two adjacent buttons. */}
                    <DropdownMenu.Item
                      className={menuItemClassName}
                      onSelect={() =>
                        section.archived
                          ? onUnarchiveSection(section.id)
                          : onArchiveSection(section.id)
                      }
                    >
                      {section.archived ? "Unarchive" : "Archive"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={menuItemClassName}
                      onSelect={() => handleRequestDeleteSection(section)}
                    >
                      Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
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
          completedTasks={completedTasks}
          onUncomplete={onUncomplete}
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
          countTaskChildren={countTaskChildren}
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

      {/* Verbatim (quick-add.md § "Destructive confirmation wording"):
          "Delete project? The <name> project and all its tasks will be
          permanently deleted. This action cannot be undone." Buttons
          Cancel/Delete — ConfirmDialog's own fixed pair. */}
      <ConfirmDialog
        open={confirmingDeleteProject}
        onOpenChange={setConfirmingDeleteProject}
        title="Delete project?"
        description={
          <>
            The {project.name} project and all its tasks will be permanently deleted. This action
            cannot be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={onDeleteProject}
      />
    </div>
  );
}
