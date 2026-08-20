import type { WireSessionResponse, WireSessionSummary } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

/**
 * Mirrors `reflect-transport.ts`'s shape exactly: a discriminated union
 * rather than a thrown Error, with the Server URL read fresh per call. This
 * transport has a failure mode `reflectTransport` doesn't need to name
 * separately — a 404 here is ordinary, not exceptional: the Session was
 * deleted, or Settings now points at a different Server that never held
 * it. `"not-found"` is that case; `"unreachable"` is every other failure
 * (network failure, a non-2xx, non-404 status) reported the same honest
 * catch-all way `reflectTransport` and `checkServer`
 * (`packages/core/src/server-check.ts`) already treat an opaque failure.
 */
export type SessionResult =
  | { ok: true; session: WireSessionResponse }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "unreachable" };

export async function sessionsTransport(sessionId: string): Promise<SessionResult> {
  const response = await serverRequest(`/v1/sessions/${sessionId}`);
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) {
    return { ok: false, reason: "not-found" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  const body = (await response.json()) as WireSessionResponse;
  return { ok: true, session: body };
}

/**
 * `GET /v1/sessions` — every Session the Server holds, newest first by when
 * it was last used, no Turns. Mirrors `sessionsTransport` above, minus the
 * `"not-found"` reason: there is no id to miss here, so a non-2xx (a 404
 * meaning this Server predates the route, same as `reflectTransport`'s, or
 * any other failure) collapses to the one honest `"unreachable"` catch-all
 * — ADR 0025 requires the list to say plainly that it cannot be shown
 * rather than render as an empty list a reader could mistake for "no
 * Sessions exist yet."
 *
 * `query` is issue #64's Search: an absent or blank string omits `?q=`
 * entirely rather than sending an empty one, so a Server that predates this
 * ticket still gets exactly the request it always did (and the existing
 * "fetches .../v1/sessions" test above keeps working unmodified for the
 * no-search case). `encodeURIComponent` via `URLSearchParams` is what
 * carries a term with reserved characters (spaces, `&`, `%`, `?`, …)
 * correctly onto the wire — the server's own `ILIKE` escaping (issue #64,
 * `server/src/sessions.rs`) only starts once the raw text has actually
 * arrived intact.
 */
export type SessionsListResult =
  | { ok: true; sessions: WireSessionSummary[] }
  | { ok: false; reason: "unreachable" };

export async function sessionsListTransport(query?: string): Promise<SessionsListResult> {
  const trimmed = query?.trim();
  const path =
    trimmed && trimmed !== ""
      ? `/v1/sessions?${new URLSearchParams({ q: trimmed })}`
      : "/v1/sessions";

  const response = await serverRequest(path);
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }

  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  const body = (await response.json()) as WireSessionSummary[];
  return { ok: true, sessions: body };
}

/**
 * `DELETE /v1/sessions/{id}` (issue #63) — permanently removes a Session
 * and, via the Server's own foreign-key cascade, every Turn inside it.
 * Mirrors `sessionsTransport`'s shape exactly, including its `"not-found"`
 * reason: deleting an id that's already gone (this Device raced another
 * one, or the row never existed) is the same ordinary case a fetch already
 * has to report, not a new kind of failure. A 204 carries no body, so the
 * success case is just `{ ok: true }` — nothing to parse.
 */
export type SessionsDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "unreachable" };

export async function sessionsDeleteTransport(sessionId: string): Promise<SessionsDeleteResult> {
  const response = await serverRequest(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) {
    return { ok: false, reason: "not-found" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  return { ok: true };
}
