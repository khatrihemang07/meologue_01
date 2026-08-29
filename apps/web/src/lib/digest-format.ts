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

/**
 * The reader's provenance cue (issue #132 / ADR 0039): "Written {date}"
 * for a Digest's first, worker-written revision, "Regenerated {date}" for
 * any later one. There is no revision picker anywhere in this app — a
 * reader only ever sees the newest revision, and this line is what tells
 * them whether the Server wrote it by itself or they asked for it.
 *
 * `writtenAt` is an instant (`WireDigest["written_at"]`, the revision's own
 * `created_at`), not a calendar date like `period_start`/`period_end`
 * above — so unlike `formatDigestRange`'s `formatUtcDate`, this is
 * deliberately rendered in the reader's own local timezone rather than
 * pinned to UTC: "when the Server wrote this" is a moment in this reader's
 * day, not a Period boundary the Server itself already resolved.
 */
export function formatDigestProvenance(revision: number, writtenAt: string): string {
  const label = revision <= 1 ? "Written" : "Regenerated";
  const parsed = Date.parse(writtenAt);
  if (Number.isNaN(parsed)) {
    return label;
  }
  return `${label} ${new Date(parsed).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

/**
 * A completed-Period noun for the stale marker's own sentence below —
 * `formatDigestRange`'s `LABELS` in `digest-reader-page.tsx` is titled
 * ("Day"/"Week"/"Month", for a page heading); this is the lowercase noun
 * that sentence actually reads with ("...changed after this Digest was
 * written"). Falls back to "Period" (CONTEXT.md's own term for the
 * concept) for a `period` string this client doesn't recognise, rather
 * than rendering nothing.
 */
const STALE_PERIOD_NOUN: Record<string, string> = { day: "day", week: "week", month: "month" };

/**
 * The stale marker's copy (issue #132 / ADR 0039) — neutral, never an
 * error, matching CONTEXT.md's *Sync status* precedent that "off" reads as
 * a fact, not a failure: staleness is a fact about freshness, not a
 * mistake anyone made. Shared between the reader and the cards
 * (`digest-page.tsx`) so the two surfaces never drift into saying this two
 * different ways.
 */
export function formatStaleCopy(period: string): string {
  const noun = STALE_PERIOD_NOUN[period] ?? "Period";
  return `Entries for this ${noun} changed after this Digest was written.`;
}
