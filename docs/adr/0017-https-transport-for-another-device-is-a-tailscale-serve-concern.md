# 0017: Reaching the web app from another Device over HTTPS is a Tailscale Serve concern, not an app change

## Status

Accepted

## Context

The web app stores Entries in SQLite over OPFS (ADR 0007), which browsers only open in a secure
context — HTTPS, or `localhost`. `apps/web/src/platform/sqlite-driver.web.ts` checks
`window.isSecureContext` before it even starts the OPFS worker, and throws a `StorageUnavailableError`
that the UI turns into an explicit "meologue needs a secure context (HTTPS or localhost) to store
Entries" message. Over plain HTTP to anything but `localhost`, that check has always fired, and the
README has said as much since the server first bound `0.0.0.0`.

Ticket 43 asked whether that's an app problem or a transport problem. It's transport: the server
already listens on every interface, so the only missing piece was a certificate for something other
than `localhost` that a phone's browser would trust without the user installing anything. Tailscale
already issues real, auto-renewed Let's Encrypt certificates for a machine's tailnet name and can
proxy a local port behind one with `tailscale serve --bg http://127.0.0.1:41207` — no server code,
no client code, and nothing in `packages/core` needed to change for a phone on the tailnet to load
`https://hemangs-macbook-air-1.tail28560e.ts.net/`, send an Entry, reload, and see it persist.

## Decision

**Nothing in the app changes.** The fix is entirely operational: run `tailscale serve --bg` once,
pointed at the server's port, and use the tailnet name it prints as the Server URL on every Device
that needs to reach this machine from outside `localhost`. The README documents the command; this
ADR documents why nothing besides the README moved.

**The `isSecureContext` check stays exactly as it is.** It was never wrong — it's the one thing
standing between a browser silently failing to open OPFS and a user finding out their Entries were
never being stored at all. Weakening or bypassing it to tolerate plain HTTP would trade a clear,
immediate error for silent data loss the first time someone actually hit that path, which is a
strictly worse failure mode than the one it currently prevents.

**ADR 0012's cleartext-to-any-host exceptions on both native shells are retained, not tightened.**
Adding HTTPS as an option for reaching another Device doesn't remove the reasons cleartext needs to
keep working: the dev workflow still runs over `http://localhost` (browsers exempt `localhost` from
the secure-context requirement, so there's nothing to fix there), and a bare LAN address — never
going to have a Tailscale certificate — is still a legitimate thing to type into Settings for anyone
running the server on their home network without an overlay network at all. Requiring HTTPS
everywhere would foreclose that use case for no gain to it.

**Tailscale Serve is used, never Funnel, and that boundary is permanent.** `serve` only exposes the
port to devices already on the tailnet; `funnel` republishes it to the open internet. ADR 0003
already decided the server does no authentication of its own — reachability is the entire trust
boundary. Funnel would collapse that boundary to "anyone on the internet who finds the URL," which
turns a personal journal into a publicly readable and writable one. There is no tightening of Funnel
that fixes this while ADR 0003 stands; the two decisions are incompatible outright.

## Alternatives considered

- **Terminate TLS in the Rust server itself** (a self-signed cert, or `rustls` with a cert from
  somewhere else). Rejected: a self-signed cert fails every browser's trust check by design, which
  is the same "can't store Entries" experience this ticket exists to fix, just moved one layer down
  — a phone still has to be told to trust something. Tailscale's certs are trusted with zero
  per-device setup because the tailnet itself is the trust anchor; reimplementing that in the server
  would mean shipping and rotating certificates ourselves for a problem an existing tool already
  solves.
- **Loosen the `isSecureContext` check to also allow the app's own LAN/tailnet origin.** Rejected
  outright — see Decision above. There's no origin this check could special-case without also
  accepting the exact plain-HTTP request that silently fails to persist, which is the specific
  failure this check exists to surface instead of hide.
- **Wrap the `tailscale serve` command in a setup script**, the way `scripts/setup-signing.sh` wraps
  signing (ADR 0015). Rejected: `--bg` already persists the config in `tailscaled`'s own state across
  reboots, so there's no repeated step or generated secret to script — the entire operation is one
  command, run once, which is a worse candidate for a wrapper than a clearer sentence in the README.
- **Enable Funnel instead of Serve**, so the app is reachable without needing tailnet membership on
  every Device. Rejected without qualification: ADR 0003's whole premise is that reachability is the
  trust boundary, and Funnel deletes that boundary. This isn't a trade-off to weigh per-deployment;
  it's incompatible with a decision this project has already made.

## Consequences

Reaching the app from another Device now has a real procedure, not a blockquote saying it doesn't
work — the README's "Run it → Web" section documents the one command and why to use the tailnet name
rather than an IP the certificate wouldn't cover. The Server URL typed into Settings on both native
shells can now be an `https://` tailnet address instead of a bare `http://` one, though neither shell
requires that switch — ADR 0012's cleartext allowance means a plain-HTTP tailnet or LAN address still
works exactly as it did before this ticket.

This path is **not covered by CI**: Tailscale can't be stood up inside the e2e harness, so nothing
automated verifies that `tailscale serve` is configured correctly or that a real device can reach it.
Verification for this ticket was manual — a phone on the tailnet loaded the HTTPS URL in its browser,
sent an Entry, reloaded, and the Entry was still there. That's a one-time proof that the mechanism
works, not a regression test; if it silently stops working (an expired Tailscale account state, a
`tailscale serve reset`, a certificate provisioning failure), nothing in this repo will notice.

**What would invalidate this decision:** any move to a hosting model where the server isn't reachable
through an overlay network at all — a cloud deployment behind a real domain, for instance — would
need its own TLS story and would make Tailscale Serve's role here moot rather than wrong. Separately,
if ADR 0003 is ever revisited to add authentication, the Funnel-versus-Serve boundary in this ADR
should be revisited alongside it, not before it: authentication is the prerequisite that would make
wider exposure defensible, not a reason to loosen this ADR on its own.
