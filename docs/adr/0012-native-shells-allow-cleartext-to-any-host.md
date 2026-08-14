# 0012: Both native shells allow cleartext to any host

## Status

Accepted

## Context

The Server URL (ADR 0008) is a runtime setting the user types, but both native shells only
permitted cleartext HTTP to one hardcoded Tailscale address — Android's
`network_security_config.xml` and macOS's `bundle.macOS.exceptionDomain` in `tauri.conf.json`
(ADR 0008's "Consequences" section already flagged this gap when Settings first shipped). Any
other `http://` address the user typed was refused by the operating system before the app's own
code ever ran, and nothing surfaced that refusal — a live server at a different address looks
indistinguishable from one that isn't running. A runtime setting whose values the platform
silently vetoes isn't really a setting.

Neither native target is affected by browser mixed-content blocking. Capacitor's origin is
`http://localhost` and Tauri's on macOS is `tauri://localhost`; both Blink and WebKit gate mixed
content on the literal `https` scheme, so both can fetch `http://` and `https://` freely already.
The OS cleartext policy is the only gate, which is why loosening it is the whole fix.

## Decision

Both shells reach any address the user types, not just one hardcoded host. The hardcoded
Tailscale IP is deleted from both rather than joined by a second entry, because no static
allowlist can anticipate what someone types into a text field later.

On Android, `network_security_config.xml`'s single-domain `domain-config` is replaced by a
base-wide `<base-config cleartextTrafficPermitted="true" />`, permitting cleartext to every host
rather than one.

On macOS, `exceptionDomain` can only name a single domain and has no wildcard, so it can't
express "any host" at all. The fix instead adds `apps/macos/Info.plist`, which Tauri merges into
the generated bundle `Info.plist`, setting `NSAppTransportSecurity` → `NSAllowsArbitraryLoads` to
`true`. The `exceptionDomain` key is removed from `tauri.conf.json` since the Info.plist override
supersedes it.

This combines with ADR 0003 (no authentication, trust is network-level) to mean the app will
send Entries in plaintext to whatever address is typed into the Server URL field, with no
platform check on where that address points. That is defensible for a single-user tool expected
to run on a private network or overlay network, not on the open internet — the same boundary ADR
0003 already draws — but it is now a boundary the OS no longer helps enforce on the native
shells, which is why it is written down here rather than left as a side effect of a UI change.

## Alternatives considered

- **Keep a per-host allowlist and add entries as new servers come into use.** Rejected: the
  Server URL is typed at runtime specifically so it isn't fixed at build time (ADR 0008
  superseding ADR 0006's build-time constant). A allowlist maintained in source can never keep
  up with a value the user chooses after the app is already installed.
- **Detect the typed Server URL's host at runtime and register it as an exception dynamically.**
  Rejected: neither platform's cleartext exception mechanism is designed to be edited at runtime
  by the app itself — Android's network security config and macOS's ATS exceptions are both
  read from static bundled configuration at process start. Achieving this would mean shipping a
  companion native plugin per platform in service of a check ADR 0003 has already decided not to
  perform at the application layer.

## Consequences

The hardcoded Tailscale IP `100.106.24.91` no longer appears anywhere in the repo. Both files'
comments now describe a base-wide cleartext posture instead of a narrow one-host exception, so a
future reader doesn't mistake the absence of a domain list for an oversight.

There is no automated test for either change — verifying that Android and macOS actually reach
an arbitrary address requires a connected device and a real build. If a future ticket adds
transport security (TLS, pinning, or similar) to the server side, both files need revisiting:
loosening cleartext policy and later requiring encryption are opposite decisions that would need
to be reconciled explicitly, not left for one to quietly override the other.
