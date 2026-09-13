/**
 * One Project's own screen — its header (name, colour, favourite,
 * archived, description), its Sections (issue #171's own acceptance
 * criteria: flat, manually ordered, capped at twenty, an optional
 * description, and a delete that "names the count and says it cannot be
 * undone"), and its own Tasks via `TaskList` (task-list.tsx) — "opening a
 * Project lists its Tasks, reusing the list Inbox already uses."
 *
 * **STR-02 (meologue-parity-docs/todoist/parity-ledger.md).** Name, colour and
 * description used to be inline controls in this header — a
 * rename-on-blur `Input`, a colour `<select>`, a description `<textarea>`
 * committing on blur. The 2026-09-13 live audit
 * (`live-audit-dom/flow9-STR-02-both.json`) recorded Todoist editing all
 * three (plus fields this app has no concept of — Parent project, Access,
 * Layout) through a modal reached from the project's own options menu,
 * with a `n/120` name counter. The user decided on 2026-09-13 to match
 * that shape: `project-edit-dialog.tsx`'s own `ProjectEditDialog` now
 * owns Name/Colour/Description, opened from the "Project options menu"
 * built here with a single "Edit" item (this screen had no options menu
 * of its own before). Favourite, Archive, the activity link and Delete
 * stay exactly where they were — Todoist's own recorded Edit dialog
 * fields don't include Archive at all, and moving Favourite in on top of
 * that would be inventing a shape the ledger never measured.
 *
 * **STR-07 (meologue-parity-docs/todoist/parity-ledger.md).** A Section's own
 * Edit/Move/Archive/Delete used to be four always-visible row controls —
 * an always-on inline rename field, explicit `Move "x" earlier` /
 * `Move "x" later` buttons, and standalone Archive/Delete buttons. The
 * 2026-09-13 live audit (`live-audit-dom/flow9-STR-07-both.json`)
 * recorded Todoist's own section header carrying a hover "More actions"
 * menu instead — Edit · Move to… · Duplicate · Copy link to section ·
 * Archive · Delete — with Edit and rename both already inline on *both*
 * sides ("Sections are the one structural object where the two apps
 * agree on surface as well as capability," that artifact's own verdict).
 * The user decided on 2026-09-13 to match the menu shape too, reusing
 * the "Project options menu" / "Label options menu" `DropdownMenu`
 * pattern (`39dd5b9`) rather than inventing a third. This file now
 * builds Edit, Move to…, Archive/Unarchive and Delete — the four
 * operations that artifact's own affordance-set verdict actually
 * measured as present on both sides.
 *
 * **Duplicate and Copy link to section are omitted, not overlooked.**
 * There is no per-Section duplicate operation anywhere in
 * `ProjectStore`, and no per-Section route for a link to point at — the
 * identical reasoning `labels-view.tsx`'s own header comment gives for
 * dropping "Add to favorites"/"Move to shared labels"/"Copy link to
 * label" from that menu.
 *
 * **Move to… reorders within the Project, it does not move a Section to
 * a different one.** `Section.projectId` (`packages/core/src/
 * project-types.ts`) is documented "always a real Project… Sections
 * never nest and never move between Projects; there is no
 * `setSectionProject`" — there is no store operation this menu item
 * could call to reassign a Section's Project even if Todoist's own
 * "Move to…" literally does that. This item keeps meologue's existing
 * earlier/later reorder (unchanged arithmetic, `reorderedKey` below;
 * unchanged pair of up/down moves), only relocated from two always-
 * visible buttons into a `DropdownMenu.Sub` under "Move to…" so a
 * reader used to Todoist's label finds the same capability meologue has
 * always had. Still keyboard-reachable: a `Sub` opens on Enter/ArrowRight
 * exactly as the existing Priority submenu (`task-command-menu.tsx`)
 * already does, and each reorder item disables itself at the same
 * first/last-Section boundary the old buttons did.
 *
 * **Delete's own confirmation wording is untouched.** Todoist's own
 * section-delete wording was read, not clicked (the live audit
 * deliberately avoided a destructive click), so there is nothing
 * verbatim to switch this dialog's existing "This destroys N Tasks…"
 * copy to — it stays exactly as it was before this menu existed.
 */
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
  /** ROW-14 (parity-ledger.md): every completed Task anywhere — forwarded straight through to `TaskList`, which does its own scoping down to this Project's own top-level rows (that component's own doc comment). Defaults to empty. */
  completedTasks?: Task[];
  /** Un-completes a Task from `completedTasks` above — forwarded straight through to `TaskList`. */
  onUncomplete?: (task: Task) => void;
  /** Forwarded straight through to `TaskList` — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  onRename: (name: string) => void;
  /** Issue #229 — reaches ProjectStore.setProjectColour, previously wired to no UI at all (the static colour dot had no control beside it). */
  onSetColour: (colour: string) => void;
  onSetDescription: (description: string | null) => void;
  onToggleFavourite: (favourite: boolean) => void;
  onToggleArchived: (archived: boolean) => void;
  /**
   * Issue #229 — Tombstone, never a hard delete (ProjectStore.removeProject's
   * own doc comment). The confirmation lives in this component
   * (`confirmingDeleteProject` below), mirroring Section delete's own
   * "capture, then confirm" shape just below it, with Todoist's own
   * verbatim wording (meologue-parity-docs/todoist/quick-add.md § "Destructive
   * confirmation wording").
   */
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
  // STR-02 (this file's own header comment) — the "Edit project" dialog's
  // own open state. A plain boolean, unlike Labels' own `dialogTarget`
  // (labels-view.tsx): this screen is always about exactly one Project
  // (`project` above), so there is no "which one" to also capture.
  const [editing, setEditing] = useState(false);
  // STR-07 (this file's own header comment) — which Section's row is
  // showing its inline rename field, or `null` for none. Mirrors
  // `editing` above for the identical reason: Todoist's own "Edit
  // section" reveals a prefilled inline field rather than always
  // rendering one, so this file now tracks "which one is open" instead
  // of every row carrying a permanently-editable input.
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  // STR-07's own version of issue #255's fight (task-schedule-popover.tsx's
  // identical "Custom…"/`focusInputAfterRepeatCloseRef` precedent): Edit's
  // `onSelect` above sets `editingSectionId`, which mounts the rename
  // field, but Radix's own menu-close focus management runs afterward and
  // — left alone — returns focus to the "Section options menu" trigger,
  // blurring the just-mounted field before a reader ever sees it (its own
  // `onBlur` then closes it right back, since the value is unchanged). The
  // field carries no `autoFocus` of its own; this ref/handler pair focuses
  // it manually, once, from the owning `DropdownMenu.Content`'s own
  // `onCloseAutoFocus` — the one signal that fires after the field has
  // actually mounted, not merely been told to — with that default
  // trigger-refocus suppressed so it never fights this.
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
          {/* STR-02 (this file's own header comment) — the one item this
              menu carries today is "Edit," opening `ProjectEditDialog`
              below. Favourite/Archive/Activity/Delete stay as their own
              standalone controls, unchanged. */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
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
        onRename={onRename}
        onSetColour={onSetColour}
        onSetDescription={onSetDescription}
      />

      <div className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">Sections ({sections.length}/20)</h2>
        <ul className="flex flex-col">
          {sortedSections.map((section, index) => (
            <li
              key={section.id}
              className="flex items-center gap-2 border-border border-b py-1.5 last:border-b-0"
            >
              {/* STR-07 (this file's own header comment) — Edit reveals
                  this exact field rather than it always being here;
                  Todoist's own recorded shape ("INLINE, prefilled…not a
                  modal"). */}
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
              {/* STR-07 (this file's own header comment) — Edit · Move
                  to… · Archive/Unarchive · Delete, Todoist's own DOM order
                  with Duplicate and Copy link to section left out. */}
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
