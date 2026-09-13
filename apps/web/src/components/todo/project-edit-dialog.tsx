/**
 * STR-02 (meologue-parity-docs/todoist/parity-ledger.md) — Todoist edits a
 * Project through a modal dialog, not inline
 * (`live-audit-dom/flow9-STR-02-both.json`): Project options menu -> Edit
 * opens a `role=dialog` carrying a Name field with an `8/120` counter,
 * Description, a Color combobox, Parent project, Access and Layout
 * comboboxes, an "Add to favorites" checkbox and a "Move project" button.
 *
 * meologue has no concept of Parent-project reassignment, Access levels
 * or a List/Board/Calendar Layout from this screen, so this dialog builds
 * only the fields meologue's own `Project` type and `use-projects.ts`
 * already support and that this screen already let a reader edit inline:
 * Name (now with the `n/120` counter the ledger's own artifact recorded),
 * Description and Colour. Recorded as unmeasured-and-inapplicable for the
 * three fields with nothing in this app to back them, not skipped by
 * oversight.
 *
 * Favourite and Archive stay as `project-view.tsx`'s own standalone
 * buttons, outside this dialog: Todoist's own Archive is not one of the
 * fields this artifact recorded inside its Edit dialog at all, and moving
 * Favourite in on top of that speculation would be inventing a shape the
 * ledger never measured.
 *
 * Built directly on the Radix `Dialog` primitive `alert-dialog.tsx`
 * already uses (`Dialog as DialogPrimitive` from `"radix-ui"`), the same
 * choice `label-dialog.tsx` makes and for the identical reason: this is
 * an ordinary form, not a destructive confirmation, so it keeps Radix's
 * own default `role="dialog"` rather than `ConfirmDialog`'s
 * `role="alertdialog"`.
 */
import type { Project } from "@meologue/core";
import { LABEL_COLOURS } from "@meologue/core";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Todoist's own Edit Project dialog reads `8/120` for its Name field
// (parity-ledger.md's STR-02; `live-audit-dom/flow9-STR-02-both.json`).
export const PROJECT_NAME_MAX = 120;

export interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onRename: (name: string) => void;
  onSetColour: (colour: string) => void;
  onSetDescription: (description: string | null) => void;
}

export function ProjectEditDialog({
  open,
  onOpenChange,
  project,
  onRename,
  onSetColour,
  onSetDescription,
}: ProjectEditDialogProps) {
  const [name, setName] = useState(project.name);
  const [colour, setColour] = useState(project.colour);
  const [description, setDescription] = useState(project.description ?? "");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "") return;
    if (trimmedName !== project.name) onRename(trimmedName);
    if (colour !== project.colour) onSetColour(colour);
    const trimmedDescription = description.trim();
    const nextDescription = trimmedDescription === "" ? null : trimmedDescription;
    if (nextDescription !== (project.description ?? null)) onSetDescription(nextDescription);
    onOpenChange(false);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="text-sm font-medium text-foreground">
            Edit project
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Set the project's name, colour and description.
          </DialogPrimitive.Description>
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
            <div className="mt-2 flex justify-end gap-2">
              <DialogPrimitive.Close asChild>
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </DialogPrimitive.Close>
              <Button type="submit" size="sm" disabled={name.trim() === ""}>
                Save
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
