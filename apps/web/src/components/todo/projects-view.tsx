/**
 * Every Project, flat with nesting shown by indentation — issue #171's
 * "Projects exist with a name, a colour, a favourite flag and an archived
 * state, and can nest" acceptance criterion. Reached from `TodoNav`'s own
 * third row (`todo-nav.tsx`), the same "one more row" extension ADR 0049
 * already predicted for Today.
 *
 * Deliberately no drag-to-reorder here, unlike Tasks: nothing in issue
 * #171's acceptance criteria asks Projects to reorder by drag, only that
 * they nest and carry a colour/favourite/archived state, and
 * `ProjectStore.reorderProject` exists for a future ticket to reach for
 * without this one inventing UI for it ahead of being asked.
 */
import type { Project } from "@meologue/core";
import { LABEL_COLOURS } from "@meologue/core";
import { Star } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ProjectsViewProps {
  projects: Project[];
  /**
   * Issue #297 — `parentId` is `null` for "No parent" (top-level), or an
   * existing Project's own id when the reader picked one from this form's
   * new parent chooser. Every existing Project is offered here: unlike
   * `ProjectEditDialog`'s own chooser, a *new* Project has no id yet, so
   * there is no self/descendant option to exclude (`ProjectStore.
   * setProjectParent`'s own guard has nothing to refuse on a Project that
   * doesn't exist until this call returns).
   */
  onAdd: (name: string, colour: string, parentId: string | null) => void;
  onToggleFavourite: (id: string, favourite: boolean) => void;
  onToggleArchived: (id: string, archived: boolean) => void;
}

/**
 * How many `parentId` hops separate `project` from a top-level Project —
 * the same "walk the ancestor chain" shape ProjectStore.setProjectParent's
 * own cycle guard uses, bounded by `projects.length` rather than trusted
 * to terminate on its own (a cycle should never reach the UI, but this is
 * a display concern, not a place to also re-derive that store-side
 * guarantee).
 *
 * Exported for `todo-sidebar.tsx` (issue #223) to reuse for its own
 * Projects tree's indentation — the identical nesting-depth question this
 * file already answers, not a second implementation of it.
 */
export function depthOf(project: Project, byId: Map<string, Project>): number {
  let depth = 0;
  let cursor: Project | undefined = project;
  const seen = new Set<string>();
  while (cursor?.parentId !== null && cursor?.parentId !== undefined) {
    if (seen.has(cursor.parentId)) break;
    seen.add(cursor.parentId);
    const parent = byId.get(cursor.parentId);
    if (parent === undefined) break;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

export function ProjectsView({
  projects,
  onAdd,
  onToggleFavourite,
  onToggleArchived,
}: ProjectsViewProps) {
  const [name, setName] = useState("");
  const [colour, setColour] = useState(LABEL_COLOURS[0]?.hex ?? "#808080");
  // Issue #297 — `""` means "No parent" (top-level), mirroring the create
  // form's own `colour` state above: a native `<select>` value is always a
  // string, so `null` (the real `parentId` this becomes on submit) has to
  // be represented some other way while it lives in this form.
  const [parentId, setParentId] = useState("");
  const byId = new Map(projects.map((project) => [project.id, project] as const));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "") return;
    onAdd(name, colour, parentId === "" ? null : parentId);
    setName("");
    setParentId("");
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <select
          aria-label="New Project's colour"
          value={colour}
          onChange={(event) => setColour(event.target.value)}
          className="shrink-0 rounded-md border border-border bg-background px-1.5 text-xs"
        >
          {LABEL_COLOURS.map((option) => (
            <option key={option.hex} value={option.hex}>
              {option.name.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <Input
          type="text"
          placeholder="New Project"
          aria-label="New Project's name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="flex-1"
        />
        {/* Issue #297 — the create-time half of making `parentId` reachable:
            `ProjectStore.setProjectParent` already existed for reparenting
            an existing Project (below, and `ProjectEditDialog`), but there
            was no way to choose a parent at creation either. "No parent"
            first, mirroring `depthOf`'s own top-level reading (`parentId
            === null`). */}
        <select
          aria-label="New Project's parent"
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          className="shrink-0 rounded-md border border-border bg-background px-1.5 text-xs"
        >
          <option value="">No parent</option>
          {projects.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={name.trim() === ""}>
          Add
        </Button>
      </form>

      {projects.length === 0 ? (
        <p className="px-1 text-center text-muted-foreground text-sm">
          No Projects yet. Add one above to move Tasks out of Inbox.
        </p>
      ) : (
        <ul className="flex flex-col">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex items-center gap-2 border-border border-b py-2 last:border-b-0"
              style={{ paddingLeft: `${depthOf(project, byId) * 20}px` }}
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: project.colour }}
              />
              <Link
                to={`/todo/projects/${project.id}`}
                className={cn(
                  "min-w-0 flex-1 truncate text-sm hover:underline",
                  project.archived && "text-muted-foreground line-through",
                )}
              >
                {project.name}
              </Link>
              <button
                type="button"
                aria-label={
                  project.favourite
                    ? `Remove "${project.name}" from favourites`
                    : `Add "${project.name}" to favourites`
                }
                aria-pressed={project.favourite}
                onClick={() => onToggleFavourite(project.id, !project.favourite)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Star
                  aria-hidden="true"
                  className={cn("size-4", project.favourite && "fill-current text-foreground")}
                />
              </button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onToggleArchived(project.id, !project.archived)}
              >
                {project.archived ? "Unarchive" : "Archive"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
