import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Type `confirmWord` to confirm" — the one form of confirmation Restore
 * ever asks for, on this Device (issue #197) or on the Server (issue
 * #198): CONTEXT.md's Restore entry calls it out by name ("it asks before
 * it acts, because this is the one operation that destroys History on
 * purpose"), and a typed word is deliberately heavier than a click —
 * `components/ui/alert-dialog.tsx`'s `ConfirmDialog` already covers every
 * ordinary "are you sure" (Entry delete, Session delete) with one click
 * each, and Restore is not that: it is the one place in this app a click
 * alone has never been enough.
 *
 * Not built on `ConfirmDialog` itself: that component's fixed shape (a
 * title, a description, one destructive button) has no room for the
 * things Restore needs beyond it — a typed gate before the destructive
 * button even enables, an `extra` slot for context specific to *which*
 * Restore this is (Device Restore's own Server-URL accept-or-keep choice,
 * `data-section.tsx`), and a `progress` line shown while the write is
 * actually in flight. Built directly on the same Radix `Dialog` primitive
 * `alert-dialog.tsx` itself is built on, with the identical
 * `role="alertdialog"` reasoning that file's own header comment gives
 * (Escape and an outside click both still dismiss it, matching this app's
 * own resolution of that point against Radix's more restrictive
 * `AlertDialog` primitive) — except the confirm button here is a plain
 * `onClick`, not a `Dialog.Close`: this dialog stays open, showing
 * `progress`, for the whole time `busy` is true, rather than closing the
 * instant the button is pressed the way `ConfirmDialog`'s always does.
 *
 * One component, two callers (`data-section.tsx`'s Device Restore,
 * `server-data-group.tsx`'s Server Restore) — issue #198's own brief asks
 * to "reuse the same destructive confirmation," not invent a second one
 * that merely looks similar.
 */
export interface DestructiveConfirmDialogProps {
  open: boolean;
  /**
   * Ignored while `busy` is true — closing the dialog mid-write would hide
   * the one place its `progress` is shown, not stop the write itself,
   * which is already running. The caller's own `onOpenChange` need not
   * re-check `busy`; this component does it once, here.
   */
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Extra content between `description` and the typed-confirmation field — Device Restore's own Server-URL accept-or-keep switch is the one caller of this today. */
  extra?: ReactNode;
  confirmWord: string;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  busy: boolean;
  /** Shown, `aria-live="polite"`, only while `busy` — empty string renders nothing. */
  progress: string;
  onConfirm: () => void;
}

export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  extra,
  confirmWord,
  confirmText,
  onConfirmTextChange,
  busy,
  progress,
  onConfirm,
}: DestructiveConfirmDialogProps) {
  // Reproduces alert-dialog.tsx's own "focus Cancel, not the Content, on
  // open" default by hand, for the identical reason that file's top
  // comment gives: a genuinely good default for a destructive confirm (an
  // accidental Enter keypress should never land on the destructive
  // button), reproduced here because this dialog is built on plain
  // Dialog, not Radix's own AlertDialog.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = "destructive-confirm-word";
  const canConfirm = confirmText === confirmWord && !busy;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          role="alertdialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus({ preventScroll: true });
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="font-medium text-foreground text-sm">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1.5 text-muted-foreground text-sm">
            {description}
          </DialogPrimitive.Description>

          {extra && <div className="mt-3">{extra}</div>}

          <label className="mt-3 block text-sm" htmlFor={inputId}>
            Type {confirmWord} to confirm
          </label>
          <Input
            id={inputId}
            value={confirmText}
            onChange={(event) => onConfirmTextChange(event.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />

          {busy && (
            <p aria-live="polite" className="mt-3 text-muted-foreground text-sm">
              {progress}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button ref={cancelRef} type="button" variant="outline" size="sm" disabled={busy}>
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              Restore
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
