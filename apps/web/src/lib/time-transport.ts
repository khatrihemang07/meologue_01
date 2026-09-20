import type {
  WireActivityInterval,
  WireCreateTimeSource,
  WireTimeSource,
  WireUpdateTimeSource,
} from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

export type TimeSource = WireTimeSource;
export type ActivityInterval = WireActivityInterval;
export type CreateTimeSourceInput = WireCreateTimeSource;
export type UpdateTimeSourceInput = WireUpdateTimeSource;

export type TimeSourcesResult =
  | { ok: true; sources: TimeSource[] }
  | { ok: false; reason: "not-supported" | "unreachable" };

export type ActivityIntervalsResult =
  | { ok: true; intervals: ActivityInterval[] }
  | { ok: false; reason: "not-supported" | "unreachable" };

/** GET /v1/time/sources — the Server-owned source configuration. */
export async function listTimeSources(): Promise<TimeSourcesResult> {
  const response = await serverRequest("/v1/time/sources");
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }
  return { ok: true, sources: (await response.json()) as TimeSource[] };
}

/** Which slice of a day to ask for. */
export type IntervalFilters = {
  /** The source lanes to include. `undefined` means every source. */
  sourceIds?: readonly string[];
  /** Free text matched against label and detail. */
  search?: string;
};

/**
 * GET /v1/time/intervals for one day.
 *
 * `day` is a floating YYYY-MM-DD and the Server resolves it against its own
 * configured timezone, so two Devices in different zones asking for the same
 * date get the same day (issue #424).
 *
 * The response carries only normalized fields — never raw provider rows —
 * which is what makes fetching a whole dense day, filtered or not, cheap
 * enough to do on every navigation (issue #419).
 */
export async function listActivityIntervals(
  day: string,
  filters: IntervalFilters = {},
): Promise<ActivityIntervalsResult> {
  const parameters = new URLSearchParams({ day });
  if (filters.sourceIds) {
    // Deliberately set even when empty: a reader who has switched every lane
    // off has asked for nothing, and omitting the parameter would ask for
    // everything instead.
    parameters.set("source_ids", filters.sourceIds.join(","));
  }
  if (filters.search?.trim()) {
    parameters.set("q", filters.search.trim());
  }
  const response = await serverRequest(`/v1/time/intervals?${parameters}`);
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }
  return { ok: true, intervals: (await response.json()) as ActivityInterval[] };
}

export type ActivityIntervalDetail = ActivityInterval & {
  /** The provider's complete row, by column, with its SQLite storage class. */
  raw_row: Record<string, { type: string; value?: unknown; base64?: string }>;
};

export type ActivityIntervalDetailResult =
  | { ok: true; interval: ActivityIntervalDetail }
  | { ok: false; reason: "not-found" | "unreachable" };

/**
 * GET /v1/time/intervals/{id} — one record, with the provider evidence.
 *
 * Fetched only when a record is actually opened. That is the whole reason the
 * daily response omits `raw_row`: a dense day would otherwise carry every
 * provider's icons and BLOBs whether or not anyone looked at one (issue #424).
 */
export async function fetchActivityInterval(id: string): Promise<ActivityIntervalDetailResult> {
  const response = await serverRequest(`/v1/time/intervals/${id}`);
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not-found" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }
  return { ok: true, interval: (await response.json()) as ActivityIntervalDetail };
}

export type CreateTimeSourceResult =
  | { ok: true; source: TimeSource }
  | { ok: false; reason: "not-supported" | "unreachable" | "rejected" };

/** POST /v1/time/sources — validates and then begins the initial import. */
export async function createTimeSource(
  input: CreateTimeSourceInput,
): Promise<CreateTimeSourceResult> {
  const response = await serverRequest("/v1/time/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: true, source: (await response.json()) as TimeSource };
}

export type UpdateTimeSourceResult =
  | { ok: true; source: TimeSource }
  | { ok: false; reason: "not-supported" | "unreachable" | "rejected" | "locked" };

/**
 * PATCH /v1/time/sources/{id} — archive, re-enable or rename one source.
 *
 * There is no delete, deliberately (issue #423): archiving already stops
 * future imports, and Activity intervals are evidence attributed to their
 * source, so removing the source would either orphan them or take them with
 * it. `locked` is separated from the other refusals because it is the one a
 * reader can do nothing about from this Device — a Server whose configuration
 * is locked will keep refusing however the form is filled in.
 */
export async function updateTimeSource(
  id: string,
  input: UpdateTimeSourceInput,
): Promise<UpdateTimeSourceResult> {
  const response = await serverRequest(`/v1/time/sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    // A Server that predates Time answers 404 for the route itself, and one
    // that has Time answers 404 for a source that is gone. Neither leaves
    // anything for this Device to do, so both read as "not supported here".
    return { ok: false, reason: "not-supported" };
  }
  if (response.status === 423) {
    return { ok: false, reason: "locked" };
  }
  if (!response.ok) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: true, source: (await response.json()) as TimeSource };
}

export type RefreshResult =
  | { ok: true; queued: number }
  | { ok: false; reason: "not-supported" | "unreachable" | "already-running" | "locked" };

/**
 * POST /v1/time/refresh — import every enabled source, once, serially.
 *
 * Returns as soon as the run is queued rather than when it finishes: a Server
 * with a week of unimported activity would otherwise hold the request open
 * for minutes. Progress is read back off the source list, whose `state` says
 * which source is running and which are still queued.
 *
 * `already-running` is its own reason, not a generic refusal. Two runs over
 * the same sources would race each other's writes, so a second press has to
 * be told a run is already going rather than silently doing nothing.
 */
export async function refreshTimeSources(): Promise<RefreshResult> {
  const response = await serverRequest("/v1/time/refresh", { method: "POST" });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (response.status === 409) {
    return { ok: false, reason: "already-running" };
  }
  if (response.status === 423) {
    return { ok: false, reason: "locked" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }
  const body = (await response.json()) as { queued: number };
  return { ok: true, queued: body.queued };
}
