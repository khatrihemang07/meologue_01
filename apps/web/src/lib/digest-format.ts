/**
 * Renders a Digest's `period_start`/`period_end` as the date or date range
 * a reader sees under a card's label (issue #71) — shared between
 * `digest-page.tsx` (three cards) and `digest-reader-page.tsx` (one
 * Digest's title), the same "one implementation, used everywhere" reason
 * `entry-day.ts` exists at all.
 *
 * Both fields are plain `YYYY-MM-DD` calendar dates, not instants — the
 * Server already resolved which local day, week or month each one is
 * (`docs/adr/0027`, `server/src/period.rs`), so this only ever formats,
 * never re-derives a boundary. Parsed as UTC midnight and rendered with
 * `timeZone: "UTC"` pinned, mirroring `entry-day.ts`'s
 * `formatDaySeparator`: the point is that "2026-08-20" reads as 20 August
 * 2026 on every Device regardless of *this* reader's own timezone offset,
 * not a second timezone conversion layered on top of the Server's own.
 */
function formatUtcDate(date: string, options: Intl.DateTimeFormatOptions): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return date;
  }
  return new Date(parsed).toLocaleDateString(undefined, { timeZone: "UTC", ...options });
}

/**
 * `period` is the plain string off the wire (`WireDigest["period"]` —
 * `"day"`, `"week"`, or `"month"`), not a richer type: nothing here needs
 * more than that one comparison against `"month"` below.
 */
export function formatDigestRange(period: string, periodStart: string, periodEnd: string): string {
  // A day's start and end are the same date — one date, not a one-day
  // "range" that would read as a typo (`period.rs::period_end` returns
  // `start` itself for `Period::Day`).
  if (periodStart === periodEnd) {
    return formatUtcDate(periodStart, { dateStyle: "medium" });
  }

  // A month's start and end always fall in the same calendar month
  // (`period.rs::period_end`'s `Period::Month` arm is always "the last day
  // of `start`'s own month") — "August 2026" reads naturally where "1 Aug
  // 2026 – 31 Aug 2026" would just restate the same month twice.
  const startYearMonth = periodStart.slice(0, 7);
  const endYearMonth = periodEnd.slice(0, 7);
  if (period === "month" && startYearMonth === endYearMonth) {
    return formatUtcDate(periodStart, { month: "long", year: "numeric" });
  }

  // A week (or the defensive fallback for a month that somehow didn't
  // collapse above): a real range. The year is dropped from the start
  // label when both ends share one — "17 – 23 Aug 2026" — and kept on
  // both when a week crosses a year boundary, the same "don't repeat what
  // the reader already knows, unless it would be wrong to drop it" rule
  // `formatDaySeparator` applies to a day separator's own year.
  const startYear = periodStart.slice(0, 4);
  const endYear = periodEnd.slice(0, 4);
  const sameYear = startYear === endYear;
  const start = formatUtcDate(periodStart, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const end = formatUtcDate(periodEnd, { month: "short", day: "numeric", year: "numeric" });
  return `${start} – ${end}`;
}
