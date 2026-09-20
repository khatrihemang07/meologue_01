import type { WireActivityInterval, WireCreateTimeSource, WireTimeSource } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

export type TimeSource = WireTimeSource;
export type ActivityInterval = WireActivityInterval;
export type CreateTimeSourceInput = WireCreateTimeSource;

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

/**
 * GET /v1/time/intervals for one Server day and, until multi-source lanes
 * arrive, one selected source. `day` stays a floating YYYY-MM-DD value: the
 * Server owns the timezone boundary rather than the client inferring UTC.
 */
export async function listActivityIntervals(
  day: string,
  sourceId: string,
): Promise<ActivityIntervalsResult> {
  const parameters = new URLSearchParams({ day, source_id: sourceId });
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
