import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { PrioritySheetContent } from "./priority-sheet-content";

export interface DraftPrioritySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The draft's own current UI priority — a caller derives this from whatever `p[1-4]` token (if any) the draft's title text already carries, the same "the text is the truth" read `use-draft-date-state.ts` gives Date/Time. */
  uiPriority: number;
  /** Fired with the picked UI priority; writing it into the draft as literal `p1`-`p4` text (`../../lib/draft-chip-text.ts`'s `literalPriorityText`) is the caller's own job, mirroring `PrioritySheetContentProps.onSelect`'s own contract unchanged. */
  onSelect: (uiPriority: number) => void;
}

/**
 * `TaskScheduleSheet`'s Priority section, alone, in a sheet of its own —
 * the draft-coupled sibling issue #372's Step 4 asks for. Carries no
 * Deadline section for the identical reason `task-schedule-chips.tsx`'s
 * own header comment gives for its own omission ("never something typed
 * into an Entry" — Deadline was a Task-only concept even while
 * `TaskScheduleSheet` still held a picker for it, above) — and issue
 * #376 removed that picker from `TaskScheduleSheet` entirely besides, so
 * there is nothing left in either sheet to be Task-coupled about.
 *
 * Fully prop-driven — no `Task` import anywhere in this file, the same
 * "no coupling" contract `TaskSchedulePopover`/`TaskTimeDialog` already
 * hold (this ticket's own plan), extended to the Priority picker. A
 * future composer (issue #374) is expected to derive `uiPriority` from
 * the draft's own parsed tokens and turn `onSelect` into a text rewrite,
 * neither of which this component needs to know anything about.
 */
export function DraftPrioritySheet({
  open,
  onOpenChange,
  uiPriority,
  onSelect,
}: DraftPrioritySheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-4">
        <SheetTitle className="px-1 pt-1 text-sm font-medium">Priority</SheetTitle>
        <PrioritySheetContent uiPriority={uiPriority} onSelect={onSelect} />
      </SheetContent>
    </Sheet>
  );
}
