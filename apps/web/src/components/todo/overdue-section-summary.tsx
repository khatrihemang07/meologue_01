import type { Task } from "@meologue/core";
import { ChevronDown } from "lucide-react";
import { OverdueRescheduleAction } from "@/components/todo/overdue-reschedule-action";

export interface OverdueSectionSummaryProps {
  /** `today()`'s own `overdue` bucket, unfiltered — passed straight through to `OverdueRescheduleAction`. */
  overdue: Task[];
  onSetDate: (id: string, date: string | null) => void;
}

export function OverdueSectionSummary({ overdue, onSetDate }: OverdueSectionSummaryProps) {
  return (
    <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-sm">
      <span className="font-bold">Overdue</span>
      <div className="flex items-center gap-2">
        <OverdueRescheduleAction overdue={overdue} onSetDate={onSetDate} />
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </div>
    </summary>
  );
}
