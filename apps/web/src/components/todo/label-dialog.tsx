/**
 * STR-04 (meologue-reference/todoist/parity-ledger.md) — Todoist creates,
 * renames and recolours a Label through a modal dialog
 * (`live-audit-dom/flow9-STR-04-todoist.json`): `button[aria-label="Add
 * new label"]` opens a `role=dialog` named "Add label" holding a Name
 * textbox with a live `n/60` counter, a Color combobox, and Cancel/Add;
 * the label's own options menu -> Edit opens the identically-shaped "Edit
 * label" dialog, prefilled, with Cancel/Save
 * (`flow9-STR-04-todoist.json`'s own `dialogTextBeforeSave`:
 * "...Color⁠Blue⁠Add to favorites⁠Cancel⁠Save"). meologue had done all
 * three inline on the row (`labels-view.tsx`'s previous shape); this is
 * the one dialog both flows now share, one component keyed on whether
 * `label` is `null` (Add) or a real Label (Edit, prefilled).
 *
 * The counter and `maxLength` are defect 32's own fix
 * (`live-audit-dom/flow11-R2-STR-03-defect32-both.json`), moved here
 * unchanged from the old inline field.
 *
 * No "Add to favorites" checkbox: `label-types.ts` carries no favourite
 * field for a Label (`labels-view.tsx`'s own header comment already made
 * this call for the inline shape; it still holds for the modal shape).
 * Recorded as unmeasured-and-inapplicable, not skipped by oversight.
 *
 * Built directly on the Radix `Dialog` primitive `alert-dialog.tsx`
 * already uses (`Dialog as DialogPrimitive` from `"radix-ui"`), not on
 * that file's own `ConfirmDialog`: `ConfirmDialog` hardcodes
 * `role="alertdialog"` and a Cancel/destructive-action pair for exactly
 * one shape (a confirm-before-you-act interruption) that this dialog is
 * not — Add/Edit label is an ordinary form, so it keeps Radix's own
 * default `role="dialog"`, matching Todoist's recorded role.
 */
import type { Label } from "@meologue/core";
import { LABEL_COLOURS } from "@meologue/core";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Defect 32 (meologue-reference/todoist/live-audit-2026-09-11.md): Todoist's
// Add/Edit label dialogs cap the Name field at 60 characters and show a
// live `n/60` counter.
export const LABEL_NAME_MAX = 60;

export interface LabelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` renders "Add label"; a Label renders "Edit label", prefilled with its name and colour. */
  label: Label | null;
  onAdd: (name: string, colour: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColour: (id: string, colour: string) => void;
}

export function LabelDialog({
  open,
  onOpenChange,
  label,
  onAdd,
  onRename,
  onSetColour,
}: LabelDialogProps) {
  const [name, setName] = useState(label?.name ?? "");
  const [colour, setColour] = useState(label?.colour ?? LABEL_COLOURS[0]?.hex ?? "#808080");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (label) {
      if (trimmed !== label.name) onRename(label.id, trimmed);
      if (colour !== label.colour) onSetColour(label.id, colour);
    } else {
      onAdd(trimmed, colour);
    }
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
            {label ? "Edit label" : "Add label"}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Set the label's name and colour.
          </DialogPrimitive.Description>
          <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">Name</span>
                <span className="text-muted-foreground text-xs">
                  {`${name.length}/${LABEL_NAME_MAX}`}
                </span>
              </div>
              <Input
                type="text"
                aria-label="Label name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={LABEL_NAME_MAX}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Colour</span>
              <select
                aria-label="Label colour"
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
            <div className="mt-2 flex justify-end gap-2">
              <DialogPrimitive.Close asChild>
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </DialogPrimitive.Close>
              <Button type="submit" size="sm" disabled={name.trim() === ""}>
                {label ? "Save" : "Add"}
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
