import { PROTOCOL_VERSION } from "./protocol";
import type { WireHealthCapabilities, WireHealthResponse } from "./wire";

/**
 * Which Server-backed Destinations (CONTEXT.md) this Server can actually
 * serve — carried straight off the wire, not reshaped, since
 * `WireHealthCapabilities` already names exactly the three booleans issue
 * #133 needs (`server/src/health.rs`'s own doc comment covers what each
 * one reads).
 */
export type ServerCapabilities = WireHealthCapabilities;

export type ServerCheckResult =
  | { ok: true; protocolVersion: number; capabilities: ServerCapabilities | undefined }
  | { ok: false; reason: "not-configured" }
  | { ok: false; reason: "invalid-url" }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "http-error"; status: number }
  | { ok: false; reason: "protocol-mismatch"; serverVersion: number };

export interface ServerFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * The minimal slice of the DOM `fetch` this needs — narrow like
 * `SqliteDriver` (./sqlite/driver.ts) and `SyncTransport`, rather than the
 * full global type, so a test double only has to shape what's actually used.
 */
export type ServerFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<ServerFetchResponse>;

export interface CheckServerOptions {
  /** Injected, matching how every platform driver is already faked in tests. */
  fetch: ServerFetch;
  /** A black-holed address never rejects on its own — this bounds the wait. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Checks whether `url` is a reachable meologue Server speaking this build's
 * protocol version, against `GET /v1/health` (ADR 0010). An empty `url`
 * means no Server is configured (ADR 0011 — sync is opt-in) and is reported
 * as `"not-configured"` without ever calling `fetch`, rather than treated
 * as same-origin or as an invalid address.
 *
 * A failed `fetch` in a browser is opaque — DNS failure, connection
 * refused, TLS failure, CORS rejection, and OS cleartext blocking are all
 * indistinguishable from JavaScript's point of view — so every network- or
 * body-level failure collapses to one honest "unreachable" rather than
 * several confident guesses. Only a response the server actually sent back
 * (a non-2xx status, or a protocol_version that doesn't match) gets its own
 * reason, since those are the ones the platform can actually distinguish.
 */
export async function checkServer(
  url: string,
  options: CheckServerOptions,
): Promise<ServerCheckResult> {
  const { fetch: injectedFetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (url === "") {
    return { ok: false, reason: "not-configured" };
  }

  try {
    new URL(url);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await injectedFetch(`${url}/v1/health`, { signal: controller.signal });

    if (!response.ok) {
      return { ok: false, reason: "http-error", status: response.status };
    }

    const body = (await response.json()) as WireHealthResponse;

    if (body.protocol_version !== PROTOCOL_VERSION) {
      return { ok: false, reason: "protocol-mismatch", serverVersion: body.protocol_version };
    }

    // Issue #133: an older Server's `HealthResponse` simply has no
    // `capabilities` key at all — `body.capabilities` reads as `undefined`
    // exactly the same way whether the key is missing or the wire sent a
    // JSON `null` (`WireHealthResponse`'s generated type allows both). This
    // must never be reinterpreted as a `protocol-mismatch` or any other
    // failure: it is orthogonal to the check above, and a Server that
    // predates this field keeps checking exactly as it always has, with an
    // `undefined` capabilities the caller is required to treat as unknown
    // rather than "unsupported" (`ServerCapabilities`'s callers — the
    // capability cache in `apps/web/src/lib/settings.ts` — apply that
    // "unknown means unlocked" rule, not this function).
    return {
      ok: true,
      protocolVersion: body.protocol_version,
      capabilities: body.capabilities ?? undefined,
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}
