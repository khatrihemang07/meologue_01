import { addDays, format, isToday, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";

/**
 * Previous / Today / next, over calendar dates rather than instants.
 *
 * Stepping a date, not adding 24 hours: on a daylight-saving day those are
 * different, and the Server's own boundaries are calendar ones.
 */
export function DayNavigator({ day, onChange }: { day: string; onChange: (day: string) => void }) {
  const parsed = parseISO(`${day}T00:00:00`);
  const today = format(new Date(), "yyyy-MM-dd");
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="touch"
        variant="outline"
        aria-label="Previous day"
        onClick={() => onChange(format(addDays(parsed, -1), "yyyy-MM-dd"))}
      >
        ‹
      </Button>
      <h2 id="time-day-heading" className="min-w-0 flex-1 truncate font-semibold text-sm">
        {isToday(parsed) ? "Today" : format(parsed, "EEEE d MMMM yyyy")}
      </h2>
      <Button
        type="button"
        size="touch"
        variant="outline"
        disabled={day === today}
        onClick={() => onChange(today)}
      >
        Today
      </Button>
      <Button
        type="button"
        size="touch"
        variant="outline"
        aria-label="Next day"
        onClick={() => onChange(format(addDays(parsed, 1), "yyyy-MM-dd"))}
      >
        ›
      </Button>
    </div>
  );
}
