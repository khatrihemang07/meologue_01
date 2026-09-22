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
    // top bar (shell.tsx's `TODO_TOPBAR_HEIGHT_PX` neighbour, the identical
    // `hidden pointer-fine:flex`-style device gate this reuses). No JS
    // "activate at N px of scroll" logic anywhere: `position: sticky`
    // already engages the instant this element's own natural, unstuck
    // position scrolls past its `top` offset, whatever that position turns
    // out to be — it follows from the page's own layout (the title/
    // subtitle/heading row above it), not a number this file hard-codes.
    // That position is NOT one fixed constant across apps either: measured
    // live, it's ~103px in meologue's own Today (1260x696) versus ~84px in
    // Todoist's — different chrome above the Overdue header in each, same
    // underlying rule. Todoist's own "N px of scroll" figure moved between
    // two readings of this ticket for the identical reason (shell.tsx's
    // own `TODO_TOPBAR_HEIGHT_PX` comment has the mini-title's parallel
    // story) — asking `position: sticky` for the real, current layout
    // instead of a captured number is what keeps this correct regardless
    // of which app, or which day's reading, produced it.
    // `bg-background` is load-bearing once stuck, not decorative: without
    // an opaque background the Tasks scrolling underneath show through.
    // `z-10`, one below the top bar's own `z-20` (shell.tsx), so the top
    // bar always wins the boundary where the two sticky elements meet.
    //
    // `flex` is also load-bearing for a second, unrelated reason: a bare
    // `<summary>` keeps the UA stylesheet's own `display: list-item`,
    // which WebKit has a history of mishandling under `position: sticky`.
    // This element was never actually at risk of that — an author-origin
    // rule (this `flex` utility) always outranks a user-agent default
    // regardless of selector specificity, so `display: list-item` was
    // never in effect here to begin with, in any engine — but it's
    // recorded here explicitly so a future edit that drops `flex` doesn't
    // silently reintroduce it. Nothing about the disclosure chevron
    // depends on the native marker either: `<ChevronDown>` below is this
    // component's own rendered affordance, not `::marker`.
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
