/**
 * The HTTPS origin to send a reader to when this one can't store Entries.
 *
 * `InsecureContextError` tells a reader that plain HTTP can't hold their
 * Entries, which is true but not actionable on a tablet: the fix is a
 * different URL, and hand-typing a tailnet name is exactly how the port
 * survives a scheme change. `tailscale serve` publishes on 443, so the
 * working URL is the same hostname over HTTPS with **no port** — dropping
 * `:41207` is the whole of it, and keeping it fails with an opaque TLS
 * error rather than a useful one (ADR 0017, ADR 0081).
 *
 * Deliberately narrow: only a `.ts.net` hostname gets a hint. That suffix is
 * a promise — Tailscale issues a real certificate for it and `serve` is the
 * documented way to reach this app from another Device — so the constructed
 * URL is either right or the tailnet isn't serving, in which case the reader
 * sees a dead link rather than a wrong idea. For a bare LAN address there is
 * no HTTPS origin to promise at all, and inventing one would send the reader
 * somewhere that cannot exist. Silence is the honest answer there.
 *
 * Computed here rather than asked of the Server: the page is already failing,
 * and the answer is sitting in `location`.
 */
export function httpsOriginHint(location: Location = window.location): string | undefined {
  if (location.protocol !== "http:") return undefined;
  if (!location.hostname.endsWith(".ts.net")) return undefined;
  return `https://${location.hostname}/`;
}
