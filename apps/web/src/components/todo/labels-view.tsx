import type { Label } from "@meologue/core";
import { MoreHorizontal } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef, useState } from "react";
import { LabelDialog } from "@/components/todo/label-dialog";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export interface LabelsViewProps {
  labels: Label[];
  onAdd: (name: string, colour: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColour: (id: string, colour: string) => void;
  onRemove: (id: string) => void;
}

const menuItemClassName =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-highlighted:text-foreground";

export function LabelsView({ labels, onAdd, onRename, onSetColour, onRemove }: LabelsViewProps) {
  // `undefined` — dialog closed. `null` — "Add label". A `Label` — "Edit
  // label", prefilled. Mirrors `label` being the one thing `LabelDialog`
  // needs to tell Add and Edit apart (that file's own doc comment).
  const [dialogTarget, setDialogTarget] = useState<Label | null | undefined>(undefined);
  // The Label a pending delete confirmation targets — `null` means
  // closed, mirroring project-view.tsx's own `confirmingDelete` shape for
  // Section delete (that component's own doc comment on why the target
  // is captured, not just a boolean).
  const [confirmingDelete, setConfirmingDelete] = useState<Label | null>(null);
  // Issue #342 — `LabelDialog`'s own `restoreFocusTo`, for the Edit path
  // only. Each row's own "…" trigger is kept here, keyed by Label id
  // (rows re-render/reorder independently, so a single ref would go
  // stale the moment any other row's own DropdownMenu mounted a new
  // button) — set once, right when "Edit" is chosen, into
  // `editRestoreFocusRef` below: the one row whose dialog is actually
  // about to open.
  const optionsTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const editRestoreFocusRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => setDialogTarget(null)}>
          Add label
        </Button>
      </div>

      {labels.length === 0 ? (
        <p className="px-1 text-center text-muted-foreground text-sm">
          No Labels yet. Add one above, or type "@name" while adding a Task.
        </p>
      ) : (
        <ul className="flex flex-col">
          {labels.map((label) => (
            <li
              key={label.id}
              className="flex items-center gap-2 border-border border-b py-2 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: label.colour }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{label.name}</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    ref={(el) => {
                      if (el) optionsTriggerRefs.current.set(label.id, el);
                      else optionsTriggerRefs.current.delete(label.id);
                    }}
                    type="button"
                    aria-label="Label options menu"
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
                    <DropdownMenu.Item
                      className={menuItemClassName}
                      onSelect={() => {
                        editRestoreFocusRef.current =
                          optionsTriggerRefs.current.get(label.id) ?? null;
                        setDialogTarget(label);
                      }}
                    >
                      Edit
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={menuItemClassName}
                      onSelect={() => setConfirmingDelete(label)}
                    >
                      Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </li>
          ))}
        </ul>
      )}

      <LabelDialog
        key={dialogTarget === undefined ? "closed" : (dialogTarget?.id ?? "add")}
        open={dialogTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDialogTarget(undefined);
        }}
        label={dialogTarget ?? null}
        onAdd={onAdd}
        onRename={onRename}
        onSetColour={onSetColour}
        // Only for Edit — the Add path's own opener ("Add label" above)
        // stays mounted, so it needs no explicit anchor (this file's own
        // `editRestoreFocusRef` doc comment, and `LabelDialogProps.
        // restoreFocusTo`'s own doc comment). Guarding on `dialogTarget`
        // rather than always passing the ref is what keeps a stale value
        // from a PREVIOUS Edit from leaking into a fresh Add.
        restoreFocusTo={dialogTarget ? editRestoreFocusRef : undefined}
      />

      {/* Verbatim (quick-add.md § "Destructive confirmation wording"):
          "Delete label? The <name> label will be permanently deleted."
          Buttons Cancel/Delete — ConfirmDialog's own fixed pair. */}
      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(null);
        }}
        title="Delete label?"
        description={
          confirmingDelete && <>The {confirmingDelete.name} label will be permanently deleted.</>
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmingDelete) {
            onRemove(confirmingDelete.id);
          }
        }}
      />
    </div>
  );
}
