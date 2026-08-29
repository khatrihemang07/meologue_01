import type { WireDigest, WireDigestResponse } from "@meologue/core";
import { serverRequest } from "@/lib/server-request";

/**
 * Mirrors `reflect-transport.ts`'s shape exactly: a discriminated union
 * rather than a thrown Error, with the Server URL read fresh per call
 * (`serverRequest`). Digest has the same one failure mode Reflection does
 * that `sessionsTransport`'s `"not-found"` doesn't need to name — a 404
 * here means this Server has no Digest routes at all (an old Server, or
 * one with no chat config — see `server/src/digest.rs`'s `DigestResponse`
 * doc comment for the full reasoning), never "no Digest exists yet." That
 * second case is not a failure at all: it comes back as an ordinary 200
 * with `digest: null`, which both functions below hand straight to the
 * caller as `{ ok: true, digest: null }` rather than folding it into
 * either failure reason. Collapsing that distinction would tell a fresh
 * install its Server is too old, which is simply false (see the server
 * doc comment this mirrors) — the whole reason issue #70 chose "always
 * 200" over a 404-when-empty design.
 */
export type DigestResult =
  | { ok: true; digest: WireDigest | null }
  | { ok: false; reason: "not-supported" }
  | { ok: false; reason: "unreachable" };

/**
 * `GET /v1/digests/{period}` — the most recent Digest of this Period, or
 * `digest: null` if none has been written yet (issue #70's
 * `latest_digest_handler`). This is what the Digest page's three cards
 * (last day, last week, last month) each fetch.
 */
export async function digestTransport(period: string): Promise<DigestResult> {
  const response = await serverRequest(`/v1/digests/${period}`);
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  const body = (await response.json()) as WireDigestResponse;
  return { ok: true, digest: body.digest ?? null };
}

/**
 * `GET /v1/digests/{period}/{date}` — the Digest at one exact
 * `period_start`, or `digest: null` if none exists there (issue #70's
 * `digest_at_handler`). Mirrors `digestTransport` above exactly; `date` is
 * the `YYYY-MM-DD` string the server hands back as
 * `period_start`/`prev_date`/`next_date`, passed straight through rather
 * than re-parsed, the same "one implementation of this maths" discipline
 * `docs/adr/0027` asks of the server side.
 */
export async function digestAtTransport(period: string, date: string): Promise<DigestResult> {
  const response = await serverRequest(`/v1/digests/${period}/${date}`);
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  const body = (await response.json()) as WireDigestResponse;
  return { ok: true, digest: body.digest ?? null };
}

/**
 * Issue #132 / ADR 0039: `POST /v1/digests/{period}/{date}/regenerate` —
 * writes and returns a new revision, synchronously (`digest.rs`'s own
 * `regenerate_digest_handler` does the chat call inline, so this `fetch`
 * genuinely takes as long as that one call does; the reader's Regenerate
 * button shows a spinner for exactly that reason, not a fixed delay).
 *
 * Shares `DigestResult`'s shape rather than inventing a fourth transport
 * type, with one addition: `"failed"` for a non-404, non-2xx status (the
 * chat call or the insert failed server-side, `regenerate_digest_handler`'s
 * own 500) — a real failure this button's own caller has to tell the
 * reader about, which `digestTransport`/`digestAtTransport` never produce
 * because a plain read has nothing that can fail this way. `"not-supported"`
 * stays for a 404, defensively — the Regenerate action only ever renders
 * once a Digest route answered something, so this Server predating the
 * routes entirely would be a surprise, not the expected case.
 */
export type DigestRegenerateResult =
  | { ok: true; digest: WireDigest | null }
  | { ok: false; reason: "not-supported" }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "failed" };

export async function digestRegenerateTransport(
  period: string,
  date: string,
): Promise<DigestRegenerateResult> {
  const response = await serverRequest(`/v1/digests/${period}/${date}/regenerate`, {
    method: "POST",
  });
  if (response === null) {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) {
    return { ok: false, reason: "not-supported" };
  }
  if (!response.ok) {
    return { ok: false, reason: "failed" };
  }

  const body = (await response.json()) as WireDigestResponse;
  return { ok: true, digest: body.digest ?? null };
}
