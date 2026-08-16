function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Minutes east of UTC, formatted as ±HH:MM — e.g. 330 -> "+05:30", -270 -> "-04:30", 0 -> "+00:00". */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

export interface LocalParts {
  /** YYYY-MM-DD in the given offset's local day. */
  date: string;
  /** HH:MM:SS in the given offset's local time. */
  time: string;
}

/**
 * Splits a UTC `createdAt` instant into the local calendar date and
 * time-of-day at `offsetMinutes` east of UTC, by shifting the instant and
 * reading the shifted value's UTC fields back — never the host's own
 * timezone. This code runs in a browser tab, a vitest process, and
 * eventually a native shell; none of those should have to agree on a
 * process-wide TZ for a Device's own export to group its own Entries
 * correctly (see the export ADR).
 */
export function toLocalParts(createdAt: string, offsetMinutes: number): LocalParts {
  const shifted = new Date(Date.parse(createdAt) + offsetMinutes * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
  return { date, time };
}
