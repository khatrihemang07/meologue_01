/**
 * Every Label — issue #229's own gap: `use-labels.ts`'s own pre-#229
 * header comment states it plainly, "`rename`/`setColour`/`remove` exist
 * in core and are wired to no UI at all," and there was no `/todo/labels`
 * route for one to live behind.
 *
 * **STR-04 and STR-05 (docs/reference/todoist/parity-ledger.md).** This
 * screen used to do create/rename/recolour inline on the row, following
 * `projects-view.tsx`'s own shape. The 2026-09-13 live audit
 * (`live-audit-dom/flow9-STR-04-todoist.json`,
 * `flow9-STR-05-todoist.json`) recorded Todoist doing all three through a
 * modal (`label-dialog.tsx`'s own `LabelDialog`, "Add label" / "Edit
 * label") reached from an "Add new label" button and a per-row options
 * menu — Edit · Add to favorites · Move to shared labels · Copy link to
 * label · Delete, in that DOM order. The user decided on 2026-09-13 to
 * match that shape. This file now builds the menu with only the two
 * items that apply: Edit (opens `LabelDialog`) and Delete (opens the
 * `ConfirmDialog` below, unchanged). "Add to favorites", "Move to shared
 * labels" and "Copy link to label" have nothing to be built against —
 * `label-types.ts` carries no favourite or shared-Label field, and there
 * is no per-Label route for a link to point at — exactly as this file's
 * own pre-2026-09-13 header comment already argued for the inline shape;
 * that argument still holds for the menu shape.
 *
 * **Flat, unlike Projects.** A Label carries no `parentId` (../../../
 * packages/core/src/label-types.ts) — there is nothing here for
 * `depthOf` (projects-view.tsx) to compute, and no favourite/archived
 * flag either (that type's own doc comment never grew either field,
 * unlike Project's), so this view offers exactly what the type supports:
 * a name, a colour, and a delete.
 */
import type { Label } from "@meologue/core";
import { MoreHorizontal } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
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
                      onSelect={() => setDialogTarget(label)}
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
