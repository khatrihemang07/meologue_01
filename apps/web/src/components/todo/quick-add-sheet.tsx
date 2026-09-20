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
  /** `quick-add-inline-card.tsx`'s own `markAddTaskField` doc comment — the identical reason, for `add-task-form.tsx`'s touch path. */
  markAddTaskField?: boolean;
}

// Full-screen, not the bottom-anchored shape `ui/sheet.tsx`'s own
// `SheetContent` implements (that file's own header comment: "only the
// anchored-to-bottom shape is implemented," deliberately, for its one
// existing caller) — Todoist Android's own quick-add sheet is a distinct
// enough shape (edge-to-edge, pinned above the keyboard, its own scrim)
// that forcing it through the bottom-sheet primitive via className
// overrides would fight tailwind-merge more than it would save.
const SHEET_CLASSES =
  "fixed inset-0 z-50 flex flex-col gap-2 bg-[color:var(--td-quick-add-background)] p-3 text-foreground outline-hidden";

/**
 * Touch's own shell (issue #374/D4/D16) — Todoist Android's full-screen
 * quick-add sheet: edge-to-edge, a scrim over the dimmed list behind it
 * (`android/02-anatomy.md`'s own colour sampling confirms one is present),
 * pinned directly above the soft keyboard with no gap. `env(safe-area-
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
