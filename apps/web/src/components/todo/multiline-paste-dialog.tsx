import { useEffect, useId, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

export interface MultiLinePasteDialogProps {
  /**
   * Non-`null` exactly while this dialog should be open — the pasted
   * lines, verbatim, one per Task a "split" confirm will create.
   * `use-quick-add-composer.ts`'s own `pendingPasteLines` feeds this
   * directly.
   */
  lines: readonly string[] | null;
  /** "Add N tasks" (the default): one Task per line. */
  onConfirmSplit: () => void;
  /** "Merge to single task" checked: one Task, every line joined. */
  onConfirmMerge: () => void;
  /** Cancel, Escape, or an outside click — creates nothing. */
  onCancel: () => void;
}

/**
 * Todoist's own "Add N tasks?" confirmation (issue #373) — pasting more
 * than one line into the add field never silently splits into several
 * Tasks, and never silently merges them into one either; this is the one
 * control that decides which, every time.
 *
 * Copy is verbatim from `.scratch/todoist-add-todo/web/04-interaction.md`'s
 * own captured modal (`data-testid="confirmation-modal"`):
 * > **Add 3 tasks?**
 * > Each line from your pasted text will be added as a separate task.
 * > ☐ Merge to single task    [Cancel]  [Add 3 tasks]
 *
 * Deliberately NOT reproduced: Todoist's own "scan text for tasks" link
 * sitting between the description and the checkbox — an AI upsell feature
 * this app has nothing behind. Per D11 (`.scratch/todoist-add-todo/
 * DECISIONS.md`), a control that looks acted-upon and isn't is worse than
 * its plain absence, so it's omitted rather than stubbed.
 *
 * Built on the same Radix `Dialog` primitives `alert-dialog.tsx`'s
 * `ConfirmDialog` and `task-time-dialog.tsx` already use, not a new
 * primitive of its own — `ConfirmDialog` itself isn't reusable here
 * (fixed single `confirmLabel`, no room for a checkbox that changes which
 * action the primary button takes), the same "not reusable, write a new
 * one" shape this ticket's own link-mark input rule is in.
 */
export function MultiLinePasteDialog({
  lines,
  onConfirmSplit,
  onConfirmMerge,
  onCancel,
}: MultiLinePasteDialogProps) {
  const open = lines !== null;
  const count = lines?.length ?? 0;
  const [merge, setMerge] = useState(false);
  const checkboxId = useId();
  // Mirrors quick-add-dialog.tsx's own `discardConfirmedRef`: both Cancel
  // and the primary action close this dialog through `DialogClose` (so
  // Escape, an outside click, Cancel, and a successful confirm all
  // converge on the identical "closed" state), but only a genuine
  // dismissal should call `onCancel` — never a successful confirm that
  // happens to close the dialog the same way.
  const confirmedRef = useRef(false);

  // Re-seed only on the open transition (`task-time-dialog.tsx`'s own
  // precedent) — never carry a checked "Merge" through to the NEXT paste.
  useEffect(() => {
    if (open) {
      setMerge(false);
      confirmedRef.current = false;
    }
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (next) {
      return;
    }
    if (confirmedRef.current) {
      confirmedRef.current = false;
      return;
    }
    onCancel();
  }

  function handleConfirm() {
    confirmedRef.current = true;
    if (merge) {
      onConfirmMerge();
    } else {
      onConfirmSplit();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogContent
          open={open}
          data-testid="multiline-paste-dialog"
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex w-[360px] max-w-[calc(100%-2rem)] flex-col gap-3 rounded-lg border border-border bg-background p-4 text-foreground text-sm shadow-lg outline-hidden"
        >
          <DialogTitle className="font-medium text-base">Add {count} tasks?</DialogTitle>
          <DialogDescription>
            Each line from your pasted text will be added as a separate task.
          </DialogDescription>

          <label className="flex items-center gap-2" htmlFor={checkboxId}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={merge}
              onChange={(event) => setMerge(event.target.checked)}
            />
            Merge to single task
          </label>

          <div className="mt-1 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button type="button" size="sm" onClick={handleConfirm}>
                {merge ? "Add task" : `Add ${count} tasks`}
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
