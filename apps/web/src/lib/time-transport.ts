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
 * GET /v1/time/intervals for one day, across every source.
 *
 * `day` is a floating YYYY-MM-DD: which calendar boundary it names is the
 * Server's to decide, and issue #424 is what moves that from UTC to the
 * Server's configured timezone.
 *
 * Deliberately unfiltered by source. Every interval carries its own source
 * name, kind and enabled flag, so one request is enough to build every lane —
 * and the response never carries raw provider rows, which is what makes
 * fetching a whole dense day cheap enough to do this way (issue #419).
 */
export async function listActivityIntervals(day: string): Promise<ActivityIntervalsResult> {
  const parameters = new URLSearchParams({ day });
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
