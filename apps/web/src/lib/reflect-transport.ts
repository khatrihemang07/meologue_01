import type { WireReflectRequest, WireReflectResponse } from "@meologue/core";
import { useSettingsStore } from "@/lib/settings";

/**
 * Mirrors `sync-transport.ts`'s shape, but Reflection has a failure mode
 * Sync doesn't: a Server that's up and speaking the protocol but simply
 * predates this route (`/v1/reflect` genuinely 404s — see the server's
 * `v1_not_found`, ticket 4). That's the one case the caller needs to tell
 * apart from every other failure, so the result is a discriminated union
 * rather than a thrown Error: "unreachable" (network failure, non-2xx other
 * than 404) is reported the same honest catch-all way `checkServer` already
 * treats an opaque `fetch` failure (`packages/core/src/server-check.ts`).
 */
export type ReflectResult =
  | { ok: true; response: WireReflectResponse }
  | { ok: false; reason: "not-supported" }
  | { ok: false; reason: "unreachable" };

export async function reflectTransport(request: WireReflectRequest): Promise<ReflectResult> {
  // Read per request, not hoisted to a local — same reasoning as
  // syncTransport: a Server URL saved between two Questions takes effect on
  // the very next one, with no reload.
  const url = useSettingsStore.getState().serverUrl;

  let response: Response;
  try {
    response = await fetch(`${url}/v1/reflect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  const body = (await response.json()) as WireReflectResponse;
  return { ok: true, response: body };
}
