/**
 * A centered confirm-before-you-act modal (issue #82), the destructive-
 * confirm counterpart to `sheet.tsx`'s bottom sheet.
 *
 * Built on Radix `Dialog`, the same primitive `sheet.tsx` uses — not on
 * Radix's own `AlertDialog`, despite that being the primitive named
 * specifically for this ("an action that needs a deliberate, interruptive
 * confirmation"). `AlertDialogContent` hardcodes
 * `onPointerDownOutside`/`onInteractOutside` to `event.preventDefault()`
 * with no compose-with-caller-handler escape hatch (unlike its
 * `onOpenAutoFocus`, which it does compose) — Radix's own deliberate
 * choice, so an AlertDialog never closes on an outside click, only on
 * Escape or one of its own actions. Issue #82's own acceptance criteria
 * requires the opposite — "closes on Escape and on dismissing outside it"
 * — so this file gets there by setting `role="alertdialog"` on a plain
 * `Dialog.Content` by hand instead, which keeps Escape-to-close and
 * outside-click-to-close both working the ordinary Dialog way `sheet.tsx`
 * already relies on, while still announcing to assistive tech as an
 * alert dialog rather than an ordinary one.
 *
 * `Dialog.Close` stands in for what `AlertDialog.Cancel`/`Action` would
 * otherwise be (they're both literally `Dialog.Close` under Radix's own
 * hood, so this loses nothing): both Cancel and the destructive action
 * close the dialog when clicked, which is what makes Escape, an outside
 * click, Cancel, and a successful confirm all converge on the same
 * "closed" state without this file tracking that itself. The one thing
 * `AlertDialogContent` would have given for free — auto-focusing Cancel
 * (the *safe* action) rather than the Content itself when the dialog
 * opens — is reproduced by hand below with `cancelRef`, since it's a
 * genuinely good default for a destructive confirm (an accidental Enter
 * keypress should never land on Delete) and costs only a few lines to
 * keep.
 *
 * One assembled component, not a set of pieces the caller assembles
 * (contrast `sheet.tsx`, which exports `Sheet`/`SheetContent`/etc. and
 * leaves entry-actions.tsx to compose them into `EntryActionsSheet`).
 * That split existed there because the sheet's two callers want visibly
 * different *content* (Edit+Delete rows vs. nothing else this repo has
 * built yet). This dialog's two callers (entry-actions.tsx,
 * sessions-page.tsx) want the identical shape every time — a title, a
 * description, a Cancel, and one destructive action — varying only in
 * the words themselves. Exposing `title`/`description`/`confirmLabel` as
 * plain props is what issue #82 asks for directly ("the description must
 * be a per-use slot, not fixed copy, because the two callers say
 * materially different things"), and there is nothing left over for a
 * caller to assemble once those three strings and `onConfirm` are
 * supplied.
 */
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /**
   * A slot, not a string prop with a default: entry-actions.tsx's Entry
   * copy and sessions-page.tsx's Session copy (the latter naming the
   * Server-side, every-Device reach of a Session delete, which an Entry's
   * copy must not) differ enough in structure — not just word choice —
   * that a plain string wouldn't comfortably fit both without one caller
   * fighting the other's phrasing.
   */
  description: React.ReactNode;
  confirmLabel: string;
  /**
   * Fires when the destructive action is chosen. Not wired to also close
   * the dialog — the confirm button is itself a `Dialog.Close` (see this
   * file's own top comment), so a caller's `onConfirm` only ever needs to
   * run the delete itself.
   */
  onConfirm: () => void;
}

/**
 * The one confirm-before-you-act modal this app has (issue #82) — Entry
 * delete (entry-actions.tsx) and Session delete (sessions-page.tsx) both
 * render this directly, differing only in the four props above.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ConfirmDialogProps) {
  // See this file's top comment: reproduces AlertDialogContent's own
  // "focus Cancel, not the Content, on open" default by hand, since this
  // dialog is built on plain Dialog rather than AlertDialog.
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="alert-dialog-overlay"
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          data-slot="alert-dialog-content"
          // Not `role="dialog"` (Radix's own Content default): this is
          // specifically an interruption over a destructive choice, and
          // `alertdialog` is the ARIA role built for that — see this
          // file's top comment for why that comes from a plain
          // Dialog.Content set by hand rather than Radix's AlertDialog.
          role="alertdialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus({ preventScroll: true });
          }}
          className={cn(
            // Centered and fixed-width, unlike sheet.tsx's edge-anchored
            // SheetContent: this dialog is a single, short interruption
            // with nothing below it worth reaching for by swipe, so there
            // is no "anchored to an edge" affordance to give it.
            "fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title
            data-slot="alert-dialog-title"
            className="text-sm font-medium text-foreground"
          >
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description
            data-slot="alert-dialog-description"
            className="mt-1.5 text-sm text-muted-foreground"
          >
            {description}
          </DialogPrimitive.Description>
          <div className="mt-4 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button ref={cancelRef} type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogPrimitive.Close>
            {/* `destructive`, the one Button variant reserved for exactly this
                (see button.tsx and sessions-page.tsx's own precedent) — so the
                two actions read as unmistakably different weights, not just
                different words. */}
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
