import type { Task } from "@meologue/core";
import { today, upcoming, upcomingDayHeading, upcomingWeekStrip } from "@meologue/core";
import { CalendarClock } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { OverdueSectionSummary } from "@/components/todo/overdue-section-summary";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { UpcomingWeekStrip } from "@/components/todo/upcoming-week-strip";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import { localDayKey } from "@/lib/local-day-key";
import { OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";

export interface UpcomingViewProps {
  /** Every active Task (TaskStore.list()'s result) — upcoming() does its own filtering; this component never pre-narrows it, mirroring TodayView's identical `tasks` prop. */
  tasks: Task[];
  /** Passed straight through to every row this view renders — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  /** `dateString` rides along so todo-page.tsx's own `handleComplete` can decide between `completeTask` and `advanceRecurringTask` — this component has no TaskStore access of its own to decide with. */
  onComplete: (id: string, content: string, dateString: string | null) => void;
  /** Shift+Click on a recurring Task's checkbox, or its touch-reachable button — "Complete and archive recurring task," ending the series. */
  onCompleteForever: (id: string, content: string) => void;
  onRequestDelete: (id: string) => void;
  onOpenSchedule: (id: string) => void;
  /** The Overdue section's own bulk Reschedule button calls this — see `overdue-reschedule-action.tsx`'s own doc comment on why `onSetDate` and never `onSetDeadline`. */
  onSetDate: (id: string, date: string | null) => void;
}

export function UpcomingView({
  tasks,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onSetDate,
}: UpcomingViewProps) {
  // Issue #303: reuses `use-swipe-actions.ts`'s shared recogniser —
  // today-view.tsx's own identical wiring has the fuller reasoning, both
  // for why this is reuse rather than a second recogniser and for why the
  // container ref goes on the outer wrapper below rather than on any one
  // day-section's own `<ul>`.
  const openScheduleForSwipe = useCallback((target: HTMLElement) => {
    const taskId = target.dataset.taskId;
    if (taskId !== undefined) {
      document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId } }));
    }
  }, []);
  const swipeRowsRef = useSwipeActions({ onOpen: openScheduleForSwipe });

  // localDayKey(new Date()), not new Date().toISOString(): the identical
  // "Today's boundary is the Device's local calendar day" discipline
  // today-view.tsx's own comment requires, reused rather than re-derived.
  const now = localDayKey(new Date());
  const days = upcoming(tasks, now);
  // Same `now` as `upcoming()` just above, passed to the identical
  // `today()` TodayView calls — one derivation of "overdue," reused, not
  // a second one written here that could drift from TodayView's.
  const { overdue } = today(tasks, now);

  const todayKey = now.slice(0, 10);
  // Initialised once, to today — the same default the strip's own "jump
  // back to today" affordance treats as the resting state (that file's
  // own header comment). Deliberately a plain `useState` initial value,
  // not re-derived on every render: this component's own `now` is
  // recomputed each render (the comment just above explains why that's
  // fine for `today()`/`upcoming()`, which are pure functions of it), but
  // re-running that same recomputation into `selectedDayKey`'s initial
  // value would only matter if a session stayed open across a real
  // midnight, which nothing else in this view accounts for either.
  const [selectedDayKey, setSelectedDayKey] = useState(todayKey);

  // Every day this component renders SOME node for, keyed by dayKey —
  // both `<section>`s from `days` below and the empty-day anchors
  // `renderUnits` inserts for the rest of the strip's week — so
  // `handleSelectDay` has one map to look a target up in regardless of
  // which of the two a given day turned out to be.
  const dayAnchors = useRef(new Map<string, HTMLElement | null>());
  function registerDayAnchor(dayKey: string) {
    return (el: HTMLElement | null) => {
      dayAnchors.current.set(dayKey, el);
    };
  }

  // `?.scrollIntoView?.(...)`, not a bare call: jsdom implements neither
  // the property nor the method (task-custom-repeat-dialog.tsx's own
  // header comment names this exact trap for a different API), so a
  // plain call here would throw in every test that exercises it. A real
  // browser has both, and that is the only place the actual scroll motion
  // is verified — see upcoming-view.test.tsx's own describe block on this
  // handler for what a jsdom run can and cannot prove about it.
  function handleSelectDay(dayKey: string) {
    setSelectedDayKey(dayKey);
    dayAnchors.current.get(dayKey)?.scrollIntoView?.({ block: "start" });
  }

  // The strip's own week (issue #343) — recomputed here, separately from
  // `UpcomingWeekStrip`'s identical internal call, only to know which of
  // its seven days `upcoming()` already covers with a real `<section>`;
  // this component never reads `hasDatedTask` itself, since the strip is
  // the one place that flag is rendered.
  const weekDayKeys = new Set(upcomingWeekStrip(tasks, now).map((d) => d.dayKey));
  const sectionDayKeys = new Set(days.map((d) => d.dayKey));
  type RenderUnit = { dayKey: string; day?: (typeof days)[number] };
  const unitsByDayKey = new Map<string, RenderUnit>();
  for (const day of days) {
    unitsByDayKey.set(day.dayKey, { dayKey: day.dayKey, day });
  }
  for (const dayKey of weekDayKeys) {
    if (!sectionDayKeys.has(dayKey)) {
      unitsByDayKey.set(dayKey, { dayKey });
    }
  }
  const renderUnits = [...unitsByDayKey.values()].sort((a, b) =>
    a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0,
  );

  return (
    <div ref={swipeRowsRef} className="flex flex-col gap-4">
      <UpcomingWeekStrip
        tasks={tasks}
        now={now}
        selectedDayKey={selectedDayKey}
        onSelectDay={handleSelectDay}
      />

      {days.length === 0 && overdue.length === 0 ? (
        // Mirrors TodayView's own "All caught up" empty state shape (an
        // achievement/explanation pair, not a bare icon) — worded for what
        // is actually true here: nothing has a Date today or later, not
        // that every dated Task is done. The strip above still renders
        // and stays fully tappable even here — every one of its seven
        // days gets an anchor below, unconditionally, so a tap when
        // nothing is scheduled at all still has somewhere defined to
        // scroll to rather than silently doing nothing.
        <div className="flex flex-col items-center gap-2 px-3 py-12 text-center">
          <CalendarClock aria-hidden="true" className="size-8 text-muted-foreground" />
          <p className="font-medium text-sm">Nothing scheduled</p>
          <p className="max-w-xs text-muted-foreground text-sm">
            No Task carries a Date today or later. Give one a Date from Inbox or Today to see it
            here.
          </p>
          {[...weekDayKeys].map((dayKey) => (
            <div
              key={dayKey}
              ref={registerDayAnchor(dayKey)}
              aria-hidden="true"
              data-upcoming-day-anchor={dayKey}
            />
          ))}
        </div>
      ) : (
        <>
          {overdue.length > 0 && (
            // `open` by default: TodayView's own Overdue section is always
            // visible, never collapsed, and this is the same Tasks shown a
            // second time here — starting collapsed would hide the one thing
            // this section exists to surface. `className="group"`:
            // overdue-section-summary.tsx's own chevron reads this element's
            // `open` state through it.
            <details open className="group">
              <OverdueSectionSummary overdue={overdue} onSetDate={onSetDate} />
              <ul className="flex flex-col">
                {overdue.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    detailActions={detailActions}
                    commentCount={detailActions.commentCountFor(task.id)}
                    onComplete={() => onComplete(task.id, task.content, task.dateString)}
                    onCompleteForever={() => onCompleteForever(task.id, task.content)}
                    onRequestDelete={() => onRequestDelete(task.id)}
                    onOpenSchedule={() => onOpenSchedule(task.id)}
                  />
                ))}
              </ul>
            </details>
          )}

          {renderUnits.map((unit) =>
            unit.day === undefined ? (
              <div
                key={unit.dayKey}
                ref={registerDayAnchor(unit.dayKey)}
                aria-hidden="true"
                data-upcoming-day-anchor={unit.dayKey}
              />
            ) : (
              <section
                key={unit.dayKey}
                ref={registerDayAnchor(unit.dayKey)}
                data-upcoming-day-anchor={unit.dayKey}
              >
                <header className="px-3 py-2">
                  <h2 className="font-medium text-sm">
                    {upcomingDayHeading(unit.day.dayKey, now)}
                  </h2>
                </header>
                <ul className="flex flex-col">
                  {unit.day.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      detailActions={detailActions}
                      commentCount={detailActions.commentCountFor(task.id)}
                      onComplete={() => onComplete(task.id, task.content, task.dateString)}
                      onCompleteForever={() => onCompleteForever(task.id, task.content)}
                      onRequestDelete={() => onRequestDelete(task.id)}
                      onOpenSchedule={() => onOpenSchedule(task.id)}
                    />
                  ))}
                </ul>
              </section>
            ),
          )}
        </>
      )}
    </div>
  );
}
