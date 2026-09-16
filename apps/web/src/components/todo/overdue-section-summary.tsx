/**
 * The Overdue disclosure's own `<summary>` row (issue #299/#337) — bare
 * "Overdue," Todoist's one Reschedule action, and a rotating expand/
 * collapse chevron, in that order, read verbatim off Todoist's own DOM
 * capture (`todoist/android/android-dom/a03-todoist-today.json`): a
 * `TextView` "Overdue," a `Button` "Reschedule," then an `ImageView`
 * "Expand/collapse" — three nodes, not two. TodayView and UpcomingView
 * share this one implementation of that row rather than each rendering
 * their own, the same "one implementation, not two that could drift"
 * reasoning overdue-reschedule-action.tsx's own header comment already
 * gives for the Reschedule button this wraps.
 *
 * The chevron is `aria-hidden` and nothing else — no `role`, no
 * `tabIndex`, no click handler of its own. Todoist's own reference node
 * is an `ImageView`, not a `Button`: a second focusable control here
 * would be wrong, not just redundant, since the `<summary>` this renders
 * inside already owns the click (native `<details>` disclosure
 * behaviour, task-detail-view.tsx's Comments section has the fuller
 * "native over `aria-expanded`" reasoning). The explicit `aria-hidden`
 * prop below is not load-bearing by itself — `lucide-react`'s own
 * `createLucideIcon` already defaults every icon with no children and no
 * a11y prop to `aria-hidden="true"` (confirmed by mutation-testing this:
 * deleting the prop left every test green) — kept anyway because every
 * other icon in this file family (`CalendarClock`, `CheckCircle2` in
 * today-view.tsx/upcoming-view.tsx) already writes it explicitly, and
 * because relying on an unstated library default is the wrong thing to
 * do even when it happens to hold.
 *
 * Rotation is `group-open:rotate-180`, not JS state: the caller's own
 * `<details>` carries `open` directly (both TodayView and UpcomingView
 * default it open), and Tailwind's `group-open` variant reads that
 * attribute off the nearest `.group` ancestor — the caller must put
 * `className="group"` on its `<details>` for this to take effect, since
 * this component itself renders only the `<summary>`, not the `<details>`
 * around it.
 *
 * "Overdue" itself is `font-bold` (700), not this app's usual
 * `font-medium` (500) — Todoist web's own computed style, only caught by
 * measuring, not by eye (issue #337). Weight lives on the `<span>`, not
 * the `<summary>`, since the Reschedule button next to it carries its own
 * separately-measured weight (overdue-reschedule-action.tsx: 600).
 */
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
