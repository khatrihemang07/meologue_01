import type * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface QuickAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel: string;
  testId?: string;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  contentRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
  /**
   * Stamps this sheet's `DialogContent` with `data-add-task-field`, the
   * same marker `add-task-form.tsx` puts on its own collapsed row and
   * expanded card (`add-task-form.tsx:108,158`). `todo-keymap.ts` and
   * the e2e `addTask` helper (`apps/e2e/tests/todo.spec.ts:35`) both
   * locate the composer by that attribute; without it here, the touch
   * sheet would be invisible to both.
   */
  markAddTaskField?: boolean;
}

// The Dialog overlay is the full-screen touch catcher. The visible sheet
// is the measured Android card: about 8dp from either edge, 32dp corner
// radius, and pinned directly to the resized viewport's bottom (the top
// of the IME while the keyboard is open). Keeping those as separate
// nodes matters: making the content itself `inset-0` turns the measured
// floating card into an opaque full-screen panel.
const SHEET_CLASSES =
  "fixed inset-x-2 bottom-0 z-50 flex flex-col gap-2 rounded-[32px] bg-[color:var(--td-quick-add-background)] px-4 py-3 text-foreground outline-hidden";

/**
 * Touch's own shell (issue #374/D4/D16) — Todoist Android's full-screen
 * touch catcher and scrim hold a floating composer card with ~8dp side
 * margins and ~32dp corners (`android/02-anatomy.md`), pinned directly
 * above the soft keyboard with no gap. `env(safe-area-
 * inset-bottom)` keeps the footer clear of a gesture bar/home indicator,
 * the identical concern `ui/sheet.tsx`'s own `SheetContent` already
 * documents for its bottom-anchored shape.
 */
export function QuickAddSheet({
  open,
  onOpenChange,
  ariaLabel,
  testId,
  onEscapeKeyDown,
  contentRef,
  children,
  markAddTaskField = false,
}: QuickAddSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-50 bg-[color:var(--td-quick-add-sheet-scrim)] duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogContent
          open={open}
          ref={contentRef}
          aria-label={ariaLabel}
          data-testid={testId}
          data-add-task-field={markAddTaskField ? "" : undefined}
          className={SHEET_CLASSES}
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          onEscapeKeyDown={onEscapeKeyDown}
        >
          <DialogTitle className="sr-only">{ariaLabel}</DialogTitle>
          {children}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
