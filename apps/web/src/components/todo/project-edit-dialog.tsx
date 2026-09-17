/**
 * STR-02 (meologue-reference/todoist/parity-ledger.md) — Todoist edits a
 * Project through a modal dialog, not inline
 * (`live-audit-dom/flow9-STR-02-both.json`): Project options menu -> Edit
 * opens a `role=dialog` carrying a Name field with an `8/120` counter,
 * Description, a Color combobox, Parent project, Access and Layout
 * comboboxes, an "Add to favorites" checkbox and a "Move project" button.
 *
 * Issue #297 gave this dialog a fourth field, Parent project: `Project.
 * parentId` was already persisted, synced and rendered (`depthOf()`
 * indents `projects-view.tsx`/`todo-sidebar.tsx`, issue #223) and
 * `ProjectStore.setProjectParent` already existed, but no UI anywhere
 * ever called it — this dialog is that UI. meologue still has no concept
 * of Access levels or a List/Board/Calendar Layout from this screen, so
 * those two stay unmeasured-and-inapplicable, not skipped by oversight;
 * this dialog builds only the fields meologue's own `Project` type and
 * `use-projects.ts` actually support: Name (with the `n/120` counter the
 * ledger's own artifact recorded), Colour, Description and now Parent
 * project.
 *
 * **The Parent chooser never offers this Project itself or any of its own
 * descendants.** `ProjectStore.setProjectParent` already refuses both —
 * self-parenting and a cycle — as its own guard
 * (`packages/core/src/test-support/project-store-contract.ts`), so this
 * dialog does not re-implement that check; it only narrows the `<select>`
 * `projects` prop by the same shape (walk `parentId` down from this
 * Project) so a reader is never offered an option certain to bounce. If
 * the store still refuses a choice — a race with another device's own
 * reparent, say — `onSetParent`'s rejection is shown inline rather than
 * swallowed, and the dialog stays open exactly as `onAddSection`'s own
 * cap refusal does in `project-view.tsx`.
 *
 * Favourite and Archive stay as `project-view.tsx`'s own standalone
 * buttons, outside this dialog: Todoist's own Archive is not one of the
 * fields this artifact recorded inside its Edit dialog at all, and moving
 * Favourite in on top of that speculation would be inventing a shape the
 * ledger never measured.
 *
 * Built on the shared `ui/dialog.tsx` (`@/components/ui/dialog`, issue
 * #342's own focus-restore wrapper around the Radix `Dialog` primitive),
 * the same choice `label-dialog.tsx` makes and for the identical reason:
 * this is an ordinary form, not a destructive confirmation, so it keeps
 * Radix's own default `role="dialog"` rather than `ConfirmDialog`'s
 * `role="alertdialog"`.
 */
import type { Project } from "@meologue/core";
import { LABEL_COLOURS } from "@meologue/core";
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

// Todoist's own Edit Project dialog reads `8/120` for its Name field
// (parity-ledger.md's STR-02; `live-audit-dom/flow9-STR-02-both.json`).
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
