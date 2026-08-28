import type { WireModelInfo } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

/**
 * `GET /v1/models` (issue #96 built the route; issue #98 is its first
 * client-side caller) — the models the Server can actually reach right now,
 * discovered at runtime rather than hard-coded on the Device, so the picker
 * in `question-composer.tsx` offers exactly what `resolve_model`
 * (`server/src/reflect.rs`) can actually answer on.
 *
 * Mirrors `sessions-transport.ts`'s shape: a discriminated union, no thrown
 * Error, the Server URL read fresh per call. Unlike a Session fetch, there
 * is no "not found" here — either the route doesn't exist yet (a Server
 * that predates Reflection, or this ticket: both a 404), or it does and
 * always answers `200` with a list, empty when the wrapper itself can't be
 * reached (`llm::list_models`'s own doc comment, server/src/llm.rs) — so a
 * non-2xx of any kind collapses to the one `"unreachable"` reason, matching
 * `sessionsListTransport`'s own precedent for a route with nothing more
 * specific to say about a failure.
 */
export type ModelsListResult =
  | { ok: true; models: WireModelInfo[] }
  | { ok: false; reason: "unreachable" };

export async function modelsTransport(): Promise<ModelsListResult> {
  const response = await serverRequest("/v1/models");
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  const body = (await response.json()) as { models: WireModelInfo[] };
  return { ok: true, models: body.models };
}
