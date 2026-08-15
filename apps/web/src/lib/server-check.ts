import { checkServer, type ServerCheckResult } from "@meologue/core";
import { resolveServerUrl } from "@/lib/settings";

export type { ServerCheckResult };

/**
 * Checks whether `url` (a Server URL setting's raw value — possibly empty,
 * meaning same-origin/build-default) is a reachable meologue Server, via
 * core's `checkServer` against `GET /v1/health` (ADR 0010). `fetch` is
 * injected here the same way `syncTransport` reads it, keeping the actual
 * DOM API out of `packages/core`.
 */
export function checkServerUrl(url: string): Promise<ServerCheckResult> {
  return checkServer(resolveServerUrl(url), {
    fetch: (requestUrl, init) => fetch(requestUrl, init),
  });
}
