function parseEntryDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formats an Entry's capture time as a date and clock time ("Aug 15, 2026,
 * 5:27 PM"), via the built-in Intl.DateTimeFormat rather than a date library
 * (ticket 33: no new date-formatting dependency). Returns null for a
 * `createdAt` that doesn't parse as a date, so callers can render nothing
 * rather than "Invalid Date".
 */
export function formatEntryTime(iso: string): string | null {
  const date = parseEntryDate(iso);
  return date === null
    ? null
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * `toLocaleString` *with* an options bag (unlike the bare zero-argument
 * form) bypasses V8's cached-formatter fast path and builds a fresh
 * `Intl.DateTimeFormat` internally on every call — for `formatAbsoluteTime`
 * below, one per row's tooltip per History render (issue #81), on top of
 * entry-row.tsx now only calling this lazily (fix 3) rather than eagerly.
 * Built once, lazily, and reused — this formatter's options never vary
 * per call, so unlike entry-day.ts's `formatDaySeparator` it needs no
 * keyed cache, just one instance.
 */
let absoluteTimeFormatter: Intl.DateTimeFormat | undefined;
function getAbsoluteTimeFormatter(): Intl.DateTimeFormat {
  if (absoluteTimeFormatter === undefined) {
    absoluteTimeFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "medium",
    });
  }
  return absoluteTimeFormatter;
}

/**
 * Formats an Entry's capture time with weekday and seconds ("Saturday,
 * August 15, 2026 at 5:27:03 PM"), for the hover tooltip — more precise than
 * the row's own date and time, so hovering still adds information.
 */
export function formatAbsoluteTime(iso: string): string | null {
  const date = parseEntryDate(iso);
  return date === null ? null : getAbsoluteTimeFormatter().format(date);
}
