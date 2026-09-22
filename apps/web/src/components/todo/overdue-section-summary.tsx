import type { LocalDayKey, Task } from "@meologue/core";
import { ChevronDown } from "lucide-react";
import { OverdueRescheduleAction } from "@/components/todo/overdue-reschedule-action";

export interface OverdueSectionSummaryProps {
  /** `today()`'s own `overdue` bucket, unfiltered — passed straight through to `OverdueRescheduleAction`. */
  overdue: Task[];
  onSetDate: (id: string, date: string | null) => void;
  /** Passed straight through to `OverdueRescheduleAction` — see that file's own doc comment. */
  onSetDateString: (id: string, dateString: string | null, today: LocalDayKey) => void;
  /** Passed straight through to `OverdueRescheduleAction` — see that file's own doc comment. */
  datesWithTasks: ReadonlyMap<string, number>;
}

export function OverdueSectionSummary({
  overdue,
  onSetDate,
  onSetDateString,
  datesWithTasks,
}: OverdueSectionSummaryProps) {
  return (
    // Issue #437: sticky at the scroll region's own top edge — `top-0` on
    // touch-only (no top bar above it), `pointer-fine:top-14` shifting the
    // stuck offset down 56px on a mouse device to clear Shell's own scroll
    // top bar (shell.tsx's `TODO_MINI_TITLE_THRESHOLD_PX` neighbour, the
    // identical `hidden pointer-fine:flex`-style device gate this reuses).
    // No JS "activate at 84px of scroll" logic anywhere: `position:
    // sticky` already engages the instant this element's own natural,
    // unstuck position scrolls past its `top` offset — which, given where
    // the title/subtitle/heading row put it, happens to be ~84px, exactly
    // Todoist's own measurement, without this needing to hard-code that
    // number and risk it drifting out of sync with the real layout.
    // `bg-background` is load-bearing once stuck, not decorative: without
    // an opaque background the Tasks scrolling underneath show through.
    // `z-10`, one below the top bar's own `z-20` (shell.tsx), so the top
    // bar always wins the boundary where the two sticky elements meet.
    <summary className="sticky top-0 z-10 flex cursor-pointer select-none items-center justify-between bg-background px-3 py-2 text-sm pointer-fine:top-14">
      <span className="font-bold">Overdue</span>
      <div className="flex items-center gap-2">
        <OverdueRescheduleAction
          overdue={overdue}
          onSetDate={onSetDate}
          onSetDateString={onSetDateString}
          datesWithTasks={datesWithTasks}
        />
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </div>
    </summary>
  );
}
