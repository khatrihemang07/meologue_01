/**
 * Issue #439: Todoist web's own endless month list — one continuous
 * scrolling list of weeks, no month-at-a-time paging, replacing the old
 * `react-day-picker` month grid this popover's own calendar used to render
 * (`components/ui/calendar.tsx` — still used by `date-picker-sheet.tsx`
 * for History's own picker, untouched by this ticket: see that file's own
 * header comment for why it keeps `react-day-picker` for now, ahead of
 * #442).
 *
 * A deep module, small interface: every prop below is either a plain
 * value (`now`, `selectedDay`, `datesWithTasks`) or a `YYYY-MM-DD` day key
 * (`minDay`, `initialDay`) — nothing here leaks `@tanstack/react-virtual`'s
 * own types, a week-index, or any other internal shape to its caller.
 * Scroll position is entirely UNCONTROLLED and lives only inside this
 * component: `task-schedule-popover.tsx`'s own `PopoverContent`/
 * `SheetContent` fully unmount this component on close (Radix's default
 * `Presence` behaviour — neither wrapper passes `forceMount`), so a fresh
 * mount on the next open already starts back at `initialDay`/`minDay` with
 * no reset effect needed, unlike the old `Calendar`'s `month`/`onMonthChange`
 * pair, which the popover had to carry as its OWN state and explicitly
 * re-seed on every open (that file's own comment on why) precisely because
 * it was a controlled input instead.
 *
 * ## Virtualization
 *
 * One list item = one week (`@/lib/month-list.ts`'s own `weekStartForIndex`/
 * `indexForWeekStart` pair). `WEEK_COUNT` below is a large but finite
 * window (~100 years) rather than a literal infinite list — `@tanstack/
 * react-virtual` needs a `count` — which is the practical reading of the
 * ticket's own "The future is unbounded (Todoist kept going past 2118)":
 * nothing a real reader will ever scroll far enough to reach, while
 * `overscan` keeps the actually-rendered DOM small regardless of how far
 * the scroll position has moved (this file's own test suite proves the
 * bound holds after a multi-year jump, not just at rest).
 *
 * Each week's own height comes from `estimateSize` ALONE — this component
 * never wires `ref={virtualizer.measureElement}` onto a row, so
 * `@tanstack/react-virtual` never tries to re-measure one via
 * `ResizeObserver`/`offsetHeight` (jsdom's own permanent-zero trap,
 * `test/virtualized-scroll.ts`'s own header comment). That is safe here
 * specifically because `estimateSize` is not actually an ESTIMATE: a
 * week's height is fully determined by its own index (plain vs. carrying
 * an in-list month label), so there is nothing a real measurement could
 * ever correct it to. Only the SCROLL ELEMENT's own viewport size still
 * needs the harness's `stubOffsetSize`/`triggerResize` dance — that one
 * measurement has no deterministic substitute, in this component or
 * History's.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, Circle } from "lucide-react";
import { useRef, useState } from "react";
import { localDayKey } from "@/lib/local-day-key";
import {
  effectiveMonthOfWeek,
  indexOfMonthStart,
  type MonthKey,
  mondayOfWeek,
  neighborMonthKey,
  resolveInitialIndex,
  resolveMinMonday,
  sameMonthKey,
  weekDays,
  weekStartForIndex,
} from "@/lib/month-list";
import { cn } from "@/lib/utils";

/** A week day paired with its own `LocalDayKey` string — computed ONCE per `Date`, here, rather than every consumer re-deriving it (`localDayKey`) or, worse, round-tripping back through `new Date(dayKey)` (`local-day-key.ts`'s own header comment on why that parse is a trap). Every `dayKey`-shaped prop below this point is one of these, or a plain `string` sourced from one. */
interface WeekDay {
  readonly date: Date;
  readonly dayKey: string;
}

function weekDaysWithKeys(weekStart: Date): WeekDay[] {
  return weekDays(weekStart).map((date) => ({ date, dayKey: localDayKey(date) }));
}

export interface MonthListCalendarProps {
  /** Earliest day the list ever shows, `YYYY-MM-DD`. Defaults to `now`'s own current-week Monday — the ticket's own measured floor. History's later #442 jump-to-day is the one caller expected to pass an earlier bound. */
  minDay?: string;
  /**
   * The day the list opens scrolled to, `YYYY-MM-DD`. Defaults to
   * `minDay` itself. Todoist was never measured opening from a Task with
   * a FUTURE date (only "opening from a Task with a past date does not
   * scroll to it" was measured, per the issue's own body) — whether such
   * an open should auto-scroll to that date is OUR OWN decision, not one
   * the ticket makes: we chose not to, so the list always opens at its
   * own natural top instead. `task-schedule-popover.tsx` never passes
   * this prop at all, for exactly that reason. It exists so #442's
   * History caller — which DOES want to open pre-scrolled to a chosen
   * day — has a door to walk through without this component growing a
   * second, contradictory default.
   */
  initialDay?: string;
  /** The picker's current value, or `null`. Painted as a filled circle only while it is inside the rendered (index >= 0) range — a day before `minDay` never resolves to a real index, so a past-dated Task's own date is simply never painted, with no separate reachability check needed anywhere in this file. */
  selectedDay: string | null;
  /** "Today", for the today/greyed-weekend/disabled-nav comparisons below — read once by the caller, never `new Date()` here (mirrors every other `now` consumer in `task-schedule-popover.tsx`). */
  now: Date;
  datesWithTasks: ReadonlyMap<string, number>;
  /** Fires immediately on a day click — no separate confirm step, matching the issue's own "Picking a day commits immediately on mouse devices." */
  onPickDay: (day: string) => void;
}

/** `h-7` (28px) — the exact row height `task-schedule-popover.tsx`'s own OLD day-cell sizing already used (defect 5's own measured cell), reused rather than re-guessed. */
const WEEK_ROW_HEIGHT_PX = 28;
/** Not independently measured (the ticket gives the in-list label's own font, not its row height) — sized to comfortably hold 12px/700 text plus a little breathing room above the week it labels. */
const MONTH_LABEL_ROW_HEIGHT_PX = 20;
/** ~100 years of weeks — see this file's own header comment on why a large finite `count` is the practical reading of "future unbounded." */
const WEEK_COUNT = 5200;
/** Issue #439's own measured visible height for the scrolling weeks region. */
const VISIBLE_HEIGHT_PX = 180;
/** Small on purpose: this card's own viewport (~6-7 rows) is nowhere near History's (`OVERSCAN = 25`, a much taller list with its own reasons) — just enough padding above/below the visible rows to keep a fast scroll from flashing blank rows before they paint. */
const OVERSCAN = 6;

function monthLabelText(key: MonthKey, formatPattern: string): string {
  return format(new Date(key.year, key.month, 1), formatPattern);
}

/** Whether the week at `index` is the first week to carry `key`'s own 1st — the row Todoist's own in-list label sits on, and the one `effectiveMonthOfWeek` disagrees with its own predecessor about. Index 0 never carries one: its own month is already named by the pinned header, matching the ticket's screenshot (only LATER months get an in-list label). */
function startsNewMonth(minMonday: Date, index: number): boolean {
  if (index === 0) {
    return false;
  }
  const current = effectiveMonthOfWeek(weekStartForIndex(minMonday, index));
  const previous = effectiveMonthOfWeek(weekStartForIndex(minMonday, index - 1));
  return !sameMonthKey(current, previous);
}

function rowHeight(minMonday: Date, index: number): number {
  return WEEK_ROW_HEIGHT_PX + (startsNewMonth(minMonday, index) ? MONTH_LABEL_ROW_HEIGHT_PX : 0);
}

/**
 * The pixel offset `index` sits at — the sum of every earlier row's own
 * height, NOT `index * WEEK_ROW_HEIGHT_PX`. A plain multiplication would
 * under-count whenever a month-label row (`startsNewMonth`) sits between
 * 0 and `index`, landing `initialDay`'s own opening scroll position short
 * of the week it was supposed to land on by however many label rows it
 * passed on the way there. Only ever called once, for the initial mount's
 * own `initialOffset` (below) — every LATER jump goes through
 * `virtualizer.scrollToIndex`, which already knows each row's real,
 * cumulative offset from its own `measurementsCache` and needs no
 * separate sum here.
 */
function offsetForIndex(minMonday: Date, index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) {
    offset += rowHeight(minMonday, i);
  }
  return offset;
}

export function MonthListCalendar({
  minDay,
  initialDay,
  selectedDay,
  now,
  datesWithTasks,
  onPickDay,
}: MonthListCalendarProps) {
  const minMonday = resolveMinMonday(minDay, now);
  const initialIndex = resolveInitialIndex(minMonday, initialDay);
  const minMonth = effectiveMonthOfWeek(minMonday);
  const todayMonth = effectiveMonthOfWeek(mondayOfWeek(now));

  const scrollElementRef = useRef<HTMLDivElement>(null);
  // No hover state survives a day the pointer isn't over — `null` is
  // "showing the weekday row," matching Todoist's own default and every
  // touch device (which never fires `mouseenter` in the first place, so
  // this state simply never leaves `null` there) — touch usability for
  // this hover-only info line is met by construction this way, rather
  // than needing a separate touch branch.
  const [hoveredDay, setHoveredDay] = useState<WeekDay | null>(null);

  const virtualizer = useVirtualizer({
    count: WEEK_COUNT,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => rowHeight(minMonday, index),
    overscan: OVERSCAN,
    initialOffset: offsetForIndex(minMonday, initialIndex),
  });

  const virtualItems = virtualizer.getVirtualItems();
  // The first row actually inside the viewport — NOT `virtualItems[0]`,
  // which is overscan-padded (`OVERSCAN` rows ABOVE the real top, so it
  // stays index 0 for any scroll shallow enough that overscan alone still
  // reaches back to the start — three weeks ahead, at `OVERSCAN = 6`,
  // every time). `row.end > scrollOffset` is "this row's own bottom edge
  // is below the viewport's own top edge," which is exactly "this row is
  // at least partly visible," the same test a real reader's eye would
  // apply. Falls back to `initialIndex` before the scroll element has a
  // real, measured viewport (`virtualItems` comes back empty then — the
  // identical "measured viewport size is exactly zero" case history.tsx's
  // own comment on this describes) — the header/nav below read as if the
  // list were already sitting at its own opening position, which it is.
  const scrollOffset = virtualizer.scrollOffset ?? offsetForIndex(minMonday, initialIndex);
  const topItem = virtualItems.find((item) => item.end > scrollOffset) ?? virtualItems[0];
  const topIndex = topItem?.index ?? initialIndex;
  const topMonth = effectiveMonthOfWeek(weekStartForIndex(minMonday, topIndex));

  const atMinMonth = sameMonthKey(topMonth, minMonth);
  const atTodayMonth = sameMonthKey(topMonth, todayMonth);
  // `WEEK_COUNT` is a large but still FINITE window (this file's own
  // header comment) — › would otherwise silently do nothing once the next
  // month's own start week falls past the list's last real index, rather
  // than the button visibly refusing the way ‹/○ already do at their own
  // bound. `indexOfMonthStart` can return an index past `WEEK_COUNT - 1`
  // for a month this far out; comparing against that ceiling (not just
  // "did scrollToIndex move anything") is what catches it before a click
  // ever tries.
  const atMaxMonth = indexOfMonthStart(minMonday, neighborMonthKey(topMonth, 1)) > WEEK_COUNT - 1;

  // Deliberately no `behavior: "smooth"` passed to `scrollToIndex` itself —
  // that option drives `@tanstack/virtual-core`'s own `requestAnimationFrame`
  // easing loop, which never advances synchronously under jsdom (no test
  // here drives raw animation frames, and shouldn't have to just to prove a
  // button jumps to the right month). The CSS `scroll-smooth` class on the
  // scroll element below gets the identical easing for free, the ticket's
  // own "smooth-scrolls" behaviour, from the BROWSER'S native handling of
  // any `Element.scrollTo()` call (which `scrollToIndex` always makes,
  // `behavior` option or not) — while a test's own synchronous `scrollTo`
  // polyfill (this file's own test suite) still lands the scroll position
  // instantly, with nothing async left to wait out.
  function scrollToMonthStart(key: MonthKey) {
    const index = Math.max(indexOfMonthStart(minMonday, key), 0);
    virtualizer.scrollToIndex(index, { align: "start" });
  }

  function goToPreviousMonth() {
    if (atMinMonth) {
      return;
    }
    scrollToMonthStart(neighborMonthKey(topMonth, -1));
  }

  function goToNextMonth() {
    if (atMaxMonth) {
      return;
    }
    scrollToMonthStart(neighborMonthKey(topMonth, 1));
  }

  function goToToday() {
    if (atTodayMonth) {
      return;
    }
    scrollToMonthStart(todayMonth);
  }

  const navButtonClassName =
    "flex size-6 items-center justify-center rounded-md disabled:opacity-20";

  return (
    <div className="flex flex-col">
      <div className="flex h-6 items-center justify-between">
        <span className="font-bold text-[13px] text-foreground">
          {monthLabelText(topMonth, "MMM yyyy")}
        </span>
        <div
          className="flex items-center gap-0.5"
          style={{ color: "var(--td-calendar-list-nav-active)" }}
        >
          <button
            type="button"
            aria-label="Previous month"
            disabled={atMinMonth}
            onClick={goToPreviousMonth}
            className={navButtonClassName}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Jump to today"
            disabled={atTodayMonth}
            onClick={goToToday}
            className={navButtonClassName}
          >
            <Circle className="size-3" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            disabled={atMaxMonth}
            onClick={goToNextMonth}
            className={navButtonClassName}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Issue #439's own hover behaviour: hovering a day swaps this
          whole row for a one-line summary of that day instead of
          highlighting the cell itself — `onMouseLeave` here (on the row's
          own container, not per-cell) is what clears it once the pointer
          leaves the list, matching "until the pointer leaves the list"
          rather than "until it leaves that one cell." */}
      {hoveredDay === null ? (
        <div
          data-testid="month-list-weekday-row"
          className="flex text-[10px] text-[color:var(--td-calendar-list-weekday)]"
        >
          {weekDaysWithKeys(mondayOfWeek(now)).map(({ date, dayKey }) => (
            <span key={dayKey} className="flex-1 text-center" aria-hidden="true">
              {format(date, "EEEEE")}
            </span>
          ))}
        </div>
      ) : (
        <HoverInfoLine day={hoveredDay} datesWithTasks={datesWithTasks} />
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: this IS the virtualizer's own scroll container (`getScrollElement`/`ref={scrollElementRef}`) — it has to be a plain scrollable `div`, and `onMouseLeave` here is what clears the hover-info-line "until the pointer leaves the list" (this file's own header comment on that row), not a click/keyboard affordance that would need a role. Every day inside is its own real `<button>`. */}
      <div
        ref={scrollElementRef}
        data-testid="month-list-scroll"
        className="scroll-smooth overflow-y-auto"
        style={{ height: VISIBLE_HEIGHT_PX }}
        onMouseLeave={() => setHoveredDay(null)}
      >
        <div style={{ position: "relative", height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => {
            const weekStart = weekStartForIndex(minMonday, item.index);
            const showLabel = startsNewMonth(minMonday, item.index);
            return (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                  height: item.size,
                }}
              >
                {showLabel && (
                  <div className="font-bold text-[12px] text-foreground">
                    {monthLabelText(effectiveMonthOfWeek(weekStart), "MMM")}
                  </div>
                )}
                <WeekRow
                  weekStart={weekStart}
                  now={now}
                  selectedDay={selectedDay}
                  datesWithTasks={datesWithTasks}
                  onPickDay={onPickDay}
                  onHoverDay={setHoveredDay}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HoverInfoLine({
  day,
  datesWithTasks,
}: {
  day: WeekDay;
  datesWithTasks: ReadonlyMap<string, number>;
}) {
  const count = datesWithTasks.get(day.dayKey) ?? 0;
  return (
    <div
      data-testid="month-list-hover-info"
      className="flex items-center text-[10px] text-[color:var(--td-calendar-list-weekday)]"
    >
      {format(day.date, "EEE d MMM")} •{" "}
      <span className="font-bold">
        {count} task{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function WeekRow({
  weekStart,
  now,
  selectedDay,
  datesWithTasks,
  onPickDay,
  onHoverDay,
}: {
  weekStart: Date;
  now: Date;
  selectedDay: string | null;
  datesWithTasks: ReadonlyMap<string, number>;
  onPickDay: (day: string) => void;
  onHoverDay: (day: WeekDay | null) => void;
}) {
  const nowKey = localDayKey(now);
  return (
    <div className="flex" style={{ height: WEEK_ROW_HEIGHT_PX }}>
      {weekDaysWithKeys(weekStart).map((day) => (
        <DayCell
          key={day.dayKey}
          day={day}
          isToday={day.dayKey === nowKey}
          isSelected={day.dayKey === selectedDay}
          taskCount={datesWithTasks.get(day.dayKey) ?? 0}
          onPick={() => onPickDay(day.dayKey)}
          onHoverStart={() => onHoverDay(day)}
        />
      ))}
    </div>
  );
}

function DayCell({
  day,
  isToday,
  isSelected,
  taskCount,
  onPick,
  onHoverStart,
}: {
  day: WeekDay;
  isToday: boolean;
  isSelected: boolean;
  taskCount: number;
  onPick: () => void;
  onHoverStart: () => void;
}) {
  const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
  // Precedence, highest first: selected > today > (weekend with no Tasks)
  // > ordinary. The busy dot below is independent of all four — it marks
  // "has a Task" regardless of which text treatment the number itself got.
  const greyedWeekend = isWeekend && taskCount === 0 && !isToday && !isSelected;

  return (
    <button
      type="button"
      data-day={day.dayKey}
      data-selected={isSelected ? "true" : undefined}
      // Restores the OLD `react-day-picker` day button's own aria-label
      // shape (`labelDayButton`'s own default, `format(date, "PPPP")`,
      // which resolves to exactly this pattern in date-fns's en-US
      // locale) — an ORDINAL day ("September 24th, 2026"), not a bare
      // cardinal one. Written out explicitly rather than the "PPPP"
      // shorthand, matching this file's own preference elsewhere (the
      // pinned/in-list month labels) for a pattern a reader can see the
      // shape of without knowing date-fns's locale-dependent presets.
      aria-label={format(day.date, "EEEE, MMMM do, yyyy")}
      onClick={onPick}
      onMouseEnter={onHoverStart}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-0.5 text-[13px]",
        isSelected &&
          "rounded-full bg-[color:var(--td-calendar-list-selected)] font-bold text-white",
        !isSelected && isToday && "font-bold text-[color:var(--td-calendar-list-today)]",
        !isSelected && !isToday && greyedWeekend && "text-[color:var(--td-calendar-list-weekday)]",
        !isSelected && !isToday && !greyedWeekend && "text-foreground",
      )}
    >
      <span>{day.date.getDate()}</span>
      <span
        data-testid="busy-dot"
        aria-hidden="true"
        className="size-[3px] rounded-full"
        style={{
          backgroundColor: taskCount > 0 ? "var(--td-calendar-list-busy-dot)" : "transparent",
        }}
      />
    </button>
  );
}
