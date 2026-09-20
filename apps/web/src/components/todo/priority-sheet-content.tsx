import { Button } from "@/components/ui/button";
import { priorityPickerColour } from "@/lib/task-priority-colors";

export interface PrioritySheetContentProps {
  /** The current UI priority (1 most urgent, 4 = "no priority") — already inverted via `uiPriorityOf`, the same value `task-schedule-sheet.tsx` used to compute inline before this was extracted. */
  uiPriority: number;
  /** Fired with the UI priority (1-4) the reader picked — never the stored value; inverting it (`storedPriorityOf`) stays each caller's own job, unchanged from before this was extracted. */
  onSelect: (uiPriority: number) => void;
}

/**
 * The four P1-P4 buttons `task-schedule-sheet.tsx`'s own Priority section
 * used to render inline, extracted (issue #372's Step 4) so a
 * draft-coupled sibling (`draft-priority-sheet.tsx`) can render the
 * identical picker without importing anything `Task`-shaped. Task
 * coupling stays one level up, in whichever caller supplies
 * `uiPriority`/`onSelect` — this component itself commits nothing and
 * knows nothing about where its value is going.
 */
export function PrioritySheetContent({ uiPriority, onSelect }: PrioritySheetContentProps) {
  return (
    <section className="flex flex-col gap-2 px-1 pb-1">
      <h3 className="text-muted-foreground text-xs">Priority</h3>
      <div className="flex gap-2">
        {[1, 2, 3, 4].map((ui) => (
          <Button
            key={ui}
            type="button"
            size="sm"
            variant={ui === uiPriority ? "default" : "outline"}
            aria-pressed={ui === uiPriority}
            onClick={() => onSelect(ui)}
          >
            {/* The same colour swatch `task-command-menu.tsx`'s own
                priority submenu already renders, from the identical
                `priorityPickerColour` — Todoist colours its priority
                options everywhere it offers them (red/orange/blue, P4
                unfilled). */}
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: priorityPickerColour(ui) }}
            />
            {`P${ui}`}
          </Button>
        ))}
      </div>
    </section>
  );
}
