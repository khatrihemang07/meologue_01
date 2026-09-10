/**
 * A month-grid date picker in a bottom Sheet (issue #146), built in
 * isolation ahead of the day separator that will open it — a later change
 * wires this to History; nothing here knows History exists.
 *
 * Tap-then-confirm, not tap-to-commit: choosing a day only highlights it,
 * and the explicit Confirm action is what calls `onConfirm`. That split is
 * deliberate — a mis-tap on a small screen would otherwise cost History a
 * long scroll back with no way to undo it, where here it costs nothing
 * because nothing happened yet.
 *
 * Every date in the grid is selectable, including a day with no Entries —
 * the grid is calendar arithmetic (via `react-day-picker`) and deliberately
 * does not know where the journal is dense. There is no `disabled` matcher
 * anywhere in this file; if you're tempted to add one, don't — see the
 * issue's own acceptance criteria.
 *
 * Modeled on `EntryActionsSheet` (`entry-actions.tsx`): one `Sheet`, driven
 * by open/closed state its caller owns, with a `SheetTitle` for Dialog's
 * required accessible name.
 *
 * `localDayKey`/`parseDayKey` — the local-day rule this file's grid and
 * Confirm button rely on — used to live here, but moved to
 * `lib/local-day-key.ts` so callers that only need a day-key string don't
 * also pay for this file's `react-day-picker`/`date-fns` imports. See that
 * module's own header comment for the full "why a Device-local `Date`
 * field read, not a UTC conversion" reasoning and the bundle-budget numbers
 * behind the move.
 */
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { localDayKey, parseDayKey } from "@/lib/local-day-key";

export interface DatePickerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** YYYY-MM-DD day key to seed the grid's selected day and visible month with. */
  initialDate?: string;
  /** Fires once, only from the explicit Confirm action — never from tapping a day alone. */
  onConfirm: (dayKey: string) => void;
}

export function DatePickerSheet({
  open,
  onOpenChange,
  initialDate,
  onConfirm,
}: DatePickerSheetProps) {
  const [selected, setSelected] = useState<Date | undefined>(() => parseDayKey(initialDate));
  const [month, setMonth] = useState<Date>(() => parseDayKey(initialDate) ?? new Date());

  // Re-seed every time the sheet opens, rather than carrying over whatever
  // was left highlighted from a previous open-then-dismiss: a dismiss (see
  // `onOpenChange` below) never reaches `onConfirm`, so the grid shouldn't
  // look like it committed to anything the next time it opens either.
  useEffect(() => {
    if (open) {
      const seeded = parseDayKey(initialDate);
      setSelected(seeded);
      setMonth(seeded ?? new Date());
    }
  }, [open, initialDate]);

  function handleConfirm() {
    if (selected === undefined) {
      return;
    }
    onConfirm(localDayKey(selected));
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle className="px-1 pt-1 text-sm font-medium">Choose a date</SheetTitle>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={setSelected}
          month={month}
          onMonthChange={setMonth}
          // Every date stays tappable — deliberately no `disabled` matcher.
          // See this file's own top comment for why that's a rule, not an
          // oversight.
          className="mx-auto"
        />
        <Button
          type="button"
          size="touch"
          className="mt-1"
          disabled={selected === undefined}
          onClick={handleConfirm}
        >
          {selected === undefined ? "Confirm" : `Confirm ${format(selected, "MMMM d, yyyy")}`}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
