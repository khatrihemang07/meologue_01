# 0081: An insecure origin's failure names the HTTPS address that would work

## Status

Accepted. Extends [0017](0017-https-transport-for-another-device-is-a-tailscale-serve-concern.md).
The `isSecureContext` check, the no-fallback rule, and the Serve-not-Funnel boundary 0017 decided
are all untouched — this ADR moves none of them. 0017's "Nothing in the app changes" was a claim
about the *transport* fix: pointing Tailscale Serve at the Server's port was enough, and no app
code needed to move. That claim still holds for how storage works. It does not extend to what the
failure *says* when a reader hits it anyway — narrowing that in writing is the whole of this ADR.

Supersedes nothing.

## Context

A user ran `scripts/run-production.sh` (binds `0.0.0.0:41207`, serves the web bundle) and tried to
reach it from an iPad on the tailnet. Two failures, not one:

1. `http://<magicdns-name>:41207/` loaded and showed "meologue can't store Entries here…" — correct
   behaviour per 0017: `apps/web/src/platform/sqlite-driver.web.ts` checks `window.isSecureContext`
   before opening OPFS (ADR 0007's Entry store for the web target) and refuses a plain-HTTP origin
   that isn't `localhost`. But the message gave no next step, because it shared copy with every
   other reason storage can fail to open — a reader on a tablet, with no console, learned only that
   something was wrong, not that the fix was a different URL.
2. Switching to HTTPS then failed with Safari's "couldn't reach." Verified from the Mac: Tailscale
   Serve *was* configured (443 → `http://127.0.0.1:41207`), and `https://hemangs-macbook-air-1.tail28560e.ts.net/`
   returned 200 as a tailnet peer. The same name with `:41207` kept on the end, though, dies with a
   TLS broken pipe — TLS spoken at a plaintext port — which Safari reports as unreachable rather
   than as anything actionable. `tailscale serve --bg` publishes on 443, so the working URL drops
   the port; 0017 documented the command but never said the resulting address drops it too.

A third gap compounded the first: issue #159 had already carried the originating `DOMException`'s
own message (e.g. `SecurityError: The operation is insecure.`) across the OPFS worker's
`postMessage`, meaning to surface exactly this kind of detail. It was being discarded at the render
step — `describeOpenError` matched on error *type* and returned a fixed sentence, throwing the
detail away — so it existed only in the console, which is not somewhere a tablet user can look.

## Decision

Four changes, all in the web target, none of them touching whether or how storage opens:

**`InsecureContextError`** (`apps/web/src/lib/entry-store-errors.ts`) is new, and a *sibling* of
`StorageUnavailableError` rather than a subclass — `sqlite-driver.web.ts`'s existing
`isSecureContext` check throws this in place of the `StorageUnavailableError` it used to share with
every other open failure. Sibling, not subclass, because the two now carry opposite advice: this
one is fixable from where the reader is standing (open the same app over HTTPS), where
`StorageUnavailableError` means the browser turned down a legitimate attempt and mostly isn't
theirs to fix. A subclass would also make `describeOpenError`'s `instanceof` chain silently
order-dependent — checking the parent branch first would swallow this one before it ever matched.

**`describeOpenError`** (`apps/web/src/pages/entry-store-layout.tsx`) now returns
`{ message, action? }` instead of a bare string. The `StorageUnavailableError` branch and the
fallback branch append the originating error's own `.message` through a small `withDetail` helper —
the real `DOMException` name the browser reported. This is issue #159's detail finally reaching the
render step instead of stopping at the console, which is where it was landing and doing nothing.

**`classifyOpenError`** (`sqlite-worker.web.ts`) is deliberately *not* changed. `NoModificationAllowedError`
is the only `DOMException` name specific enough to map to an actionable cause; `SecurityError` in
particular means different things on different engines, so mapping it to a guessed cause ("try a
non-private window") would be inventing a taxonomy the browser doesn't actually hand us. Showing
the name the browser reported is more honest than a confident-looking wrong guess.

**`httpsOriginHint`** (`apps/web/src/lib/https-origin-hint.ts`) builds `https://${location.hostname}/` —
port dropped — from `window.location` alone, and only when `location.hostname` ends in `.ts.net`.
That suffix is the one case where dropping the port is a promise rather than a guess: Tailscale
issues a real certificate for exactly that name, and `serve --bg` is documented (0017) to publish
it on 443. A bare LAN address gets no hint at all, because no HTTPS origin can be promised there.
`shell.tsx` renders it as an ordinary `<a href>`: an insecure context restricts powerful APIs (OPFS
among them), not navigation, so the link works from the very page reporting the failure.

## Alternatives considered

- **Report the URL from the Server on `/v1/health` instead of constructing it client-side.** The
  Server already knows its own Serve URL — it prints `Tailscale Serve URL for Settings: <url>` on
  startup (`server/src/main.rs`) — so this would be a fact instead of a guess. Rejected for now:
  getting a new field from a Rust struct to a rendered link crosses five layers (the struct,
  `HealthResponse`'s OpenAPI schema, the generated `wire.ts` types, `server-check.ts`'s read of
  them, and finally the failing page), and the web target's service worker precaches the app shell,
  so a server-injected value could go stale between deploys in a way a hostname suffix never does.
  The failure this ADR fixes doesn't need the Server's help to name itself — `location.hostname`
  already has the answer — so the wire change is severable, not a prerequisite, and can be
  revisited if a case shows up that `location` genuinely can't answer.
- **Map more `DOMException` names in `classifyOpenError` to friendly causes.** Rejected — see
  Decision above. `SecurityError` is not specific enough across engines to act on safely, and
  guessing invites a wrong diagnosis that reads as more confident than it is.

## Consequences

The HTTPS link `httpsOriginHint` builds is a guess derived from the hostname, not a fact read from
the Server: nothing checks that Tailscale Serve is still actually configured before rendering it.
A `tailscale serve reset` leaves the link pointing at a dead address, and nothing in this app
notices or updates it.

The HTTPS origin a reader lands on has its own OPFS store and its own `localStorage`, entirely
separate from the HTTP origin that just failed — different origin, different storage, the same
same-origin rule this app has always lived under. The reader starts empty there until Sync fills
History back in. Nothing is lost in that handoff, because nothing was ever written on the HTTP
origin to begin with — that guarantee is exactly what the `isSecureContext` check (ADR 0017)
exists to keep.

The tailnet path stays outside CI, exactly as ADR 0017 already recorded: nothing here stands up
Tailscale in the e2e harness, so a change that broke `httpsOriginHint`'s output or `serve`'s own
port binding would not be caught automatically. What unit tests *do* cover is the app's half — that
the `isSecureContext` check fires before a Worker is ever constructed
(`sqlite-driver.web.test.ts`, the seam's first test), which sentence each error type produces, and
that the port is dropped from the hint (`https-origin-hint.test.ts`). Verification of the rendered
result was manual and done on the Mac, by serving the built bundle over the machine's own MagicDNS
name on a spare port — a genuinely insecure origin, reached the same way the iPad reached the
original one. The iPad itself was not re-tested, so the claim proven here is that the app now names
the failure and the address; that the address then works on iPadOS Safari rests on the same
one-time manual proof 0017 recorded and no more.
