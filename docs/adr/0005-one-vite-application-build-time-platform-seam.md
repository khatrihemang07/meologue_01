# 0005: One Vite application; platform differences live behind a build-time seam

## Status

Accepted

## Context

Meologue is going to run on three Devices: a browser tab, an Android WebView, and a macOS
WKWebView. All three run the same React UI against the same platform-agnostic `packages/core`
(ADR 0001). What differs between them is small and grows one seam at a time — the first is *when
to wake and sync*: the browser has `visibilitychange`/`focus`/`online` events; a WKWebView has the
same events and behaves identically; an Android WebView does not expose them at all and needs a
different signal, arriving with the Android ticket.

Two ways to structure that: extract a `packages/ui` with three thin per-platform app shells
(`apps/web`, `apps/android`, `apps/macos`), or keep one Vite application and let it vary by build
target. The former assumes the divergence between platforms will be broad; today it's exactly one
function's worth.

## Decision

There is one Vite application, `apps/web`. Where a platform genuinely differs, the difference is
isolated to a small module with one file per target (e.g. `src/platform/wake-signals.<target>.ts`)
and resolved at *build time* — `vite.config.ts`'s `resolve.alias` picks the file for the active
`--mode` (`web`, `android`, or `macos`; anything else falls back to `web`, so existing scripts and
CI are unaffected). The application code imports the seam by its target-agnostic name
(`@/platform/wake-signals`) and never learns which file answered.

Building for a target that isn't web (`pnpm build:android`, `pnpm build:macos`) never bundles
another target's platform code — this is a real build-time exclusion, not a runtime branch guarded
by a flag.

## Alternatives considered

- **Extract `packages/ui` behind three thin per-platform apps.** Rejected: three near-identical
  Vite/TS/lint/test configs to maintain for a single differing function is premature — the seam
  this ADR introduces scales to more divergence later without that duplication existing yet.
- **Branch at runtime (e.g. `if (isAndroid()) { ... }`) inside one shared module.** Rejected: every
  target's platform-detection and event-wiring code ships in every build, which is exactly what a
  small embedded WebView shouldn't carry, and it invites the wrong signals to silently apply on
  the wrong platform (a `window.addEventListener("online", ...)` call is a no-op mistake on
  Android, not a compile-time error).

## Consequences

Adding a new platform-specific seam means adding one file per target under `src/platform/` plus
one alias entry in `vite.config.ts` (and a matching entry in `tsconfig.app.json`'s `paths`, since
TypeScript can't resolve Vite's per-target alias on its own — it type-checks against the `web`
file, which is representative of the shared shape all targets implement). Each target's file is
still compiled and type-checked as part of `tsc -b`, even on days its only consumer is the `web`
alias. Android's module may be a placeholder until its ticket lands; anything behind that seam
degrades to "never wakes early, relies on the interval" rather than failing to build.
