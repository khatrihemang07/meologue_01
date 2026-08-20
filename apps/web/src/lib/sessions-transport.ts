import type { WireSessionResponse } from "@meologue/core";
import { useSettingsStore } from "@/lib/settings";

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
  // Read per request, not hoisted to a local — same reasoning as
  // reflectTransport and syncTransport: a Server URL saved between two
  // opens takes effect on the very next one, with no reload.
  const url = useSettingsStore.getState().serverUrl;

  let response: Response;
  try {
    response = await fetch(`${url}/v1/sessions/${sessionId}`);
  } catch {
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
