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
 * Formats an Entry's capture time with weekday and seconds ("Saturday,
 * August 15, 2026 at 5:27:03 PM"), for the hover tooltip — more precise than
 * the row's own date and time, so hovering still adds information.
 */
export function formatAbsoluteTime(iso: string): string | null {
  const date = parseEntryDate(iso);
  return date === null
    ? null
    : date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" });
}
