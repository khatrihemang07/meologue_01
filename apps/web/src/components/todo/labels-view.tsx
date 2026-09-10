/**
 * Every Label — issue #229's own gap: `use-labels.ts`'s own pre-#229
 * header comment states it plainly, "`rename`/`setColour`/`remove` exist
 * in core and are wired to no UI at all," and there was no `/todo/labels`
 * route for one to live behind. The Label-shaped sibling of
 * `projects-view.tsx`, following its exact shape (a colour-plus-name
 * inline "Add" form, then a flat list) for the identical reason —
 * `LABEL_COLOURS` (label-colors.ts) is the one palette Projects, Labels
 * and Filters all share, so a reader who has already added a Project
 * recognises this screen immediately.
 *
 * **Flat, unlike Projects.** A Label carries no `parentId` (../../../
 * packages/core/src/label-types.ts) — there is nothing here for
 * `depthOf` (projects-view.tsx) to compute, and no favourite/archived
 * flag either (that type's own doc comment never grew either field,
 * unlike Project's), so this view offers exactly what the type supports:
 * a name, a colour, and a delete — the same restraint CLAUDE.md's brief
 * asks for, applied to a screen this time rather than a store.
 *
 * **Reproducing Todoist's label menu, minus what doesn't apply.**
 * `docs/reference/todoist/quick-add.md`'s own "Menus seen in passing"
 * names Todoist's real menu: Edit · Add to favorites · Move to shared
 * labels · Copy link to label · Delete. This app has no Label favourite,
 * no shared Labels (a solo task list — CONTEXT.md's own admission for
 * why "Project" stays "Project" applies here too), and no per-Label
 * route for a link to point at, so only Edit and Delete survive: Edit is
 * this row's own inline name field (`onBlur` commits, mirroring
 * project-view.tsx's identical rename-on-blur), and Delete is the trash
 * icon below, behind `ConfirmDialog` with Todoist's own verbatim wording
 * (quick-add.md § "Destructive confirmation wording").
 */
import type { Label } from "@meologue/core";
import { LABEL_COLOURS } from "@meologue/core";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface LabelsViewProps {
  labels: Label[];
  onAdd: (name: string, colour: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColour: (id: string, colour: string) => void;
  onRemove: (id: string) => void;
}

export function LabelsView({ labels, onAdd, onRename, onSetColour, onRemove }: LabelsViewProps) {
  const [name, setName] = useState("");
  const [colour, setColour] = useState(LABEL_COLOURS[0]?.hex ?? "#808080");
  // The Label a pending delete confirmation targets — `null` means
  // closed, mirroring project-view.tsx's own `confirmingDelete` shape for
  // Section delete (that component's own doc comment on why the target
  // is captured, not just a boolean).
  const [confirmingDelete, setConfirmingDelete] = useState<Label | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "") return;
    onAdd(name, colour);
    setName("");
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <select
          aria-label="New Label's colour"
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
          placeholder="New Label"
          aria-label="New Label's name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="flex-1"
        />
        <Button type="submit" disabled={name.trim() === ""}>
          Add
        </Button>
      </form>

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
              <select
                aria-label={`"${label.name}"'s colour`}
                value={label.colour}
                onChange={(event) => onSetColour(label.id, event.target.value)}
                className="shrink-0 rounded-md border border-border bg-background px-1.5 text-xs"
              >
                {LABEL_COLOURS.map((option) => (
                  <option key={option.hex} value={option.hex}>
                    {option.name.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <input
                type="text"
                aria-label="Label name"
                defaultValue={label.name}
                onBlur={(event) => {
                  const trimmed = event.target.value.trim();
                  if (trimmed !== "" && trimmed !== label.name) {
                    onRename(label.id, trimmed);
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-border focus:border-border"
              />
              <button
                type="button"
                aria-label={`Delete Label "${label.name}"`}
                onClick={() => setConfirmingDelete(label)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

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
          confirmingDelete && <>The "{confirmingDelete.name}" label will be permanently deleted.</>
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
