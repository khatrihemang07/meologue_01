/**
 * Formats an Entry's capture time as a clock time ("5:27 PM"), via the
 * built-in Intl.DateTimeFormat rather than a date library (ticket 33: no new
 * date-formatting dependency). Returns null for a `createdAt` that doesn't
 * parse as a date, so callers can render nothing rather than "Invalid Date".
 */
export function formatEntryTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Formats an Entry's capture time as a full date and time, for the hover tooltip. */
export function formatAbsoluteTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
