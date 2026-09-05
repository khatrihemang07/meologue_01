import type { WireConfigPatch, WireConfigResponse } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

/**
 * `GET`/`PATCH /v1/config` (issue #200's own route, issue #203 is its first
 * client-side caller) — mirrors `modelsTransport`'s shape (a discriminated
 * union, no thrown `Error`, the Server URL read fresh per call via
 * `serverRequest`) with one deliberate addition: a 404 collapses to
 * `"unsupported"`, not `"unreachable"`.
 *
 * That distinction matters here in a way it doesn't for `/v1/models`:
 * `/v1/config` is registered unconditionally (ADR 0060 — it's the one route
 * that must exist on a Server with nothing else configured, because it's
 * how a Server *becomes* configured), so a 404 here can only mean this
 * Server predates the route entirely, never "not configured yet." Reporting
 * it as `"unreachable"` would render an older Server's Settings page as a
 * network failure to retry; `"unsupported"` reads instead as "this Server
 * is older than this setting" — the same distinction
 * `digestTransport`/`digestAtTransport` already draw with their own
 * `"not-supported"`, just spelled to match this ticket's own acceptance
 * criterion.
 */
export type ConfigResult =
  | { ok: true; config: WireConfigResponse }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "http-error"; status: number };

async function toConfigResult(response: Response | null): Promise<ConfigResult> {
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  if (!response.ok) {
    // A failure with a status to report — the "rejected value" half of the
    // acceptance criterion "a failure caused by an unreachable Server reads
    // as that rather than as a rejected value." `settings::apply_patch`
    // itself accepts any string, so this is realistically a Server-side
    // fault (a 500) rather than a validation rejection, but it's kept
    // distinct from `"unreachable"` regardless: a response the Server
    // actually sent back is a fact this Server reported, not a network
    // failure a caller only guessed at (server-check.ts's own reasoning for
    // why a real status gets its own name instead of folding into one
    // catch-all).
    return { ok: false, reason: "http-error", status: response.status };
  }

  const config = (await response.json()) as WireConfigResponse;
  return { ok: true, config };
}

/**
 * This Server's settings, resolved and reported per field — what
 * `useServerConfig` (`use-server-config.ts`) fetches, and what every server
 * row in the AI and Sync sections reads to show its own value, its
 * `source`, and whether this Server is `locked`.
 */
export async function getConfig(): Promise<ConfigResult> {
  return toConfigResult(await serverRequest("/v1/config"));
}

/**
 * Writes a `ConfigPatch` and reports the settings row exactly as `getConfig`
 * would immediately afterward — `patch_config_handler`'s own doc comment:
 * a field absent from `patch` is left untouched, and an empty string clears
 * it back to falling through to the environment (never to "off"; ADR 0060).
 * `useServerConfig`'s mutation is the only caller — see its own doc comment
 * for what runs after a successful write.
 */
export async function patchConfig(patch: WireConfigPatch): Promise<ConfigResult> {
  return toConfigResult(
    await serverRequest("/v1/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}
