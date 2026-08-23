/**
 * A bottom sheet on Radix Dialog (issue #78), replacing the per-row
 * ContextMenu that used to sit under `entry-row.tsx`. Dialog is the right
 * primitive to build this on for the same reason it replaced ContextMenu
 * at the call site: a Dialog has exactly one Root regardless of how many
 * things on the page can open it, where ContextMenu needed a Trigger (and
 * the document-level listener that comes with it — see entry-actions.tsx's
 * own comment) on every single row.
 *
 * Only the "anchored to the bottom, slides up" shape is implemented — this
 * repo has exactly one caller (`entry-actions.tsx`'s `EntryActionsSheet`)
 * and it only ever wants a bottom sheet, so a `side` prop generalising to
 * top/left/right would be speculative, unused generality.
 */
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          // `env(safe-area-inset-bottom)` keeps the last row clear of an
          // Android/iOS gesture bar or home indicator — the same concern
          // `index.html`'s own viewport-fit setup exists for elsewhere in
          // this app, just applied to a sheet pinned to the bottom edge
          // instead of the page itself.
          "fixed inset-x-0 bottom-0 z-50 flex flex-col gap-1 rounded-t-xl border-t border-border bg-popover p-2 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom",
          className,
        )}
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

function SheetTitle({ ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" {...props} />;
}

export { Sheet, SheetContent, SheetOverlay, SheetPortal, SheetTitle };
