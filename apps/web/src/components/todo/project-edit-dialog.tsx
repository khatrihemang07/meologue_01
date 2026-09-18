import type { Project } from "@meologue/core";
import { LABEL_COLOURS } from "@meologue/core";
import type * as React from "react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const PROJECT_NAME_MAX = 120;

export interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  /** Every Project — the candidate pool the Parent chooser narrows down (this file's own header comment). Always includes `project` itself, since the chooser's own exclusion logic finds and removes it (and its descendants) from this list rather than expecting a caller to have pre-filtered it. */
  projects: Project[];
  onRename: (name: string) => void;
  onSetColour: (colour: string) => void;
  onSetDescription: (description: string | null) => void;
  /**
   * Issue #297 — reaches `ProjectStore.setProjectParent`.
   *
   * Optional so that a caller with no write path gets no Parent field at
   * all, rather than a control with nothing behind it (mirrors
   * `ProjectViewProps.onUncomplete`'s own optional-hides-the-affordance
   * shape). That is a property of this component, not a description of
   * any current caller: `project-view.tsx` forwards this from
   * `todo-page.tsx` unconditionally today, so in the running app the
   * field is always present. The `undefined` branch exists for direct
   * renders in tests, and to keep "can this Project be reparented" a
   * question the caller answers rather than one this dialog assumes.
   */
  onSetParent?: (parentId: string | null) => Promise<void>;
  /**
   * Issue #342 — `DialogContent`'s own `restoreFocusTo`. This dialog's
   * real opener is a `DropdownMenu.Item` ("Edit," in the Project options
   * menu — `project-view.tsx`'s own header comment on that menu) which
   * unmounts the instant the menu closes, before this dialog's `FocusScope`
   * would otherwise capture anything meaningful — the identical shape
   * `task-detail-view.tsx`'s `TaskActivityDialog` already documents. The
   * caller names the stable "Project options menu" trigger button here
   * instead, the one still-mounted place a keyboard user actually was.
   */
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
}

/**
 * Every id nested under `projectId`, transitively — the same "walk
 * `parentId`" shape `projects-view.tsx`'s own `depthOf` climbs, just
 * downward: `ProjectStore.setProjectParent`'s own cycle guard forbids
 * `projectId` from being reparented under any of these (or itself), so
 * the Parent chooser excludes them rather than offering an option
 * certain to be refused.
 */
function descendantIdsOf(projectId: string, projects: Project[]): Set<string> {
  const childrenByParentId = new Map<string, Project[]>();
  for (const candidate of projects) {
    if (candidate.parentId === null) continue;
    const siblings = childrenByParentId.get(candidate.parentId) ?? [];
    siblings.push(candidate);
    childrenByParentId.set(candidate.parentId, siblings);
  }
  const descendants = new Set<string>();
  const toVisit = [projectId];
  while (toVisit.length > 0) {
    const current = toVisit.pop();
    if (current === undefined) continue;
    for (const child of childrenByParentId.get(current) ?? []) {
      if (!descendants.has(child.id)) {
        descendants.add(child.id);
        toVisit.push(child.id);
      }
    }
  }
  return descendants;
}

export function ProjectEditDialog({
  open,
  onOpenChange,
  project,
  projects,
  onRename,
  onSetColour,
  onSetDescription,
  onSetParent,
  restoreFocusTo,
}: ProjectEditDialogProps) {
  const [name, setName] = useState(project.name);
  const [colour, setColour] = useState(project.colour);
  const [description, setDescription] = useState(project.description ?? "");
  // "" means "No parent" (top-level) — mirrors `projects-view.tsx`'s own
  // create-form `parentId` state for the identical reason: a native
  // `<select>` value is always a string.
  const [parentId, setParentId] = useState(project.parentId ?? "");
  // `ProjectStore.setProjectParent`'s own rejection (self-parent, a cycle,
  // or a race with another device), surfaced rather than swallowed — this
  // dialog's own header comment. `null` closed/no error, mirroring
  // `project-view.tsx`'s own `sectionError`.
  const [parentError, setParentError] = useState<string | null>(null);

  const excludedParentIds = descendantIdsOf(project.id, projects);
  const parentOptions = projects.filter(
    (candidate) => candidate.id !== project.id && !excludedParentIds.has(candidate.id),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "") return;
    if (trimmedName !== project.name) onRename(trimmedName);
    if (colour !== project.colour) onSetColour(colour);
    const trimmedDescription = description.trim();
    const nextDescription = trimmedDescription === "" ? null : trimmedDescription;
    if (nextDescription !== (project.description ?? null)) onSetDescription(nextDescription);

    const nextParentId = parentId === "" ? null : parentId;
    const currentParentId = project.parentId ?? null;
    if (onSetParent && nextParentId !== currentParentId) {
      try {
        await onSetParent(nextParentId);
      } catch (error) {
        // Refused (self-parent, a cycle, or a store-side race) — stays
        // open with the reason shown rather than closing as though the
        // move succeeded (this file's own header comment).
        setParentError(error instanceof Error ? error.message : "Couldn't move this Project.");
        return;
      }
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogContent
          open={open}
          restoreFocusTo={restoreFocusTo}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <DialogTitle className="text-sm font-medium text-foreground">Edit project</DialogTitle>
          <DialogDescription className="sr-only">
            Set the project's name, colour, description and parent project.
          </DialogDescription>
          <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">Name</span>
                <span className="text-muted-foreground text-xs">
                  {`${name.length}/${PROJECT_NAME_MAX}`}
                </span>
              </div>
              <Input
                type="text"
                aria-label="Project name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={PROJECT_NAME_MAX}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Colour</span>
              <select
                aria-label="Project colour"
                value={colour}
                onChange={(event) => setColour(event.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-sm"
              >
                {LABEL_COLOURS.map((option) => (
                  <option key={option.hex} value={option.hex}>
                    {option.name.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Description</span>
              <textarea
                aria-label="Project description"
                placeholder="Description (optional)"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            {/* Issue #297 — omitted entirely (not just disabled) when
                `onSetParent` isn't wired: this dialog's own header
                comment/`ProjectEditDialogProps.onSetParent` doc comment. */}
            {onSetParent && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">Parent project</span>
                <select
                  aria-label="Project parent"
                  value={parentId}
                  onChange={(event) => {
                    setParentId(event.target.value);
                    setParentError(null);
                  }}
                  className="rounded-md border border-border bg-background px-1.5 py-1 text-sm"
                >
                  <option value="">No parent</option>
                  {parentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                {parentError !== null && (
                  <p role="alert" className="text-destructive text-xs">
                    {parentError}
                  </p>
                )}
              </div>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm" disabled={name.trim() === ""}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
