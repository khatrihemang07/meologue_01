import type { Label } from "@meologue/core";
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

export const LABEL_NAME_MAX = 60;

export interface LabelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` renders "Add label"; a Label renders "Edit label", prefilled with its name and colour. */
  label: Label | null;
  onAdd: (name: string, colour: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColour: (id: string, colour: string) => void;
  /**
   * Issue #342 — `DialogContent`'s own `restoreFocusTo`. Only meaningful
   * for the Edit path: that opener is a per-row `DropdownMenu.Item`
   * ("Edit," `labels-view.tsx`'s own header comment) which unmounts the
   * instant its menu closes, before this dialog's `FocusScope` would
   * otherwise capture anything meaningful — the identical shape
   * `task-detail-view.tsx`'s `TaskActivityDialog` already documents. The
   * Add path (`label === null`) needs nothing here: its own opener, the
   * "Add label" button, stays mounted the whole time, so the generic
   * capture already restores to it correctly.
   */
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
}

export function LabelDialog({
  open,
  onOpenChange,
  label,
  onAdd,
  onRename,
  onSetColour,
  restoreFocusTo,
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
          <DialogTitle className="text-sm font-medium text-foreground">
            {label ? "Edit label" : "Add label"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Set the label's name and colour.
          </DialogDescription>
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
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm" disabled={name.trim() === ""}>
                {label ? "Save" : "Add"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
