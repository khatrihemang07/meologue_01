import type { Task } from "@meologue/core";
import { storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { PrioritySheetContent } from "./priority-sheet-content";

export interface TaskScheduleSheetProps {
  /** The Task being scheduled, looked up fresh by id on every render of the caller — never a snapshot taken when the sheet opened, so a picker's own effect is visible the moment the next render lands. */
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetPriority: (id: string, priority: number) => void;
}

export function TaskScheduleSheet({
  task,
  open,
  onOpenChange,
  onSetPriority,
}: TaskScheduleSheetProps) {
  const uiPriority = uiPriorityOf(task.priority);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-4">
        <SheetTitle className="truncate px-1 pt-1 text-sm font-medium">
          Schedule "{task.content}"
        </SheetTitle>

        {/* Extracted to `priority-sheet-content.tsx` (issue #372's Step
            4) so a draft-coupled sibling can render the identical
            picker with no `Task` import at all — this wrapper is the
            only place that still knows `task.id`/`storedPriorityOf`.
            Deadline's own section sat above this one until issue #376
            removed it along with the rest of Deadline's UI — Priority
            is this sheet's only content now. */}
        <PrioritySheetContent
          uiPriority={uiPriority}
          onSelect={(ui) => onSetPriority(task.id, storedPriorityOf(ui))}
        />
      </SheetContent>
    </Sheet>
  );
}
