# 0054: Release builds are published as GitHub Releases

## Status

Accepted. Amends [0015](0015-locally-generated-release-signing-identities.md): that ADR's Decision
— locally-generated signing identities, no paid developer accounts — is unchanged and still holds;
only its stated Context, that "the only people who will ever run these builds already have the repo
open," stops being true once a build is attached to a public download page. 0015 gains a one-line
pointer to this ADR under its Consequences; its Status stays Accepted.

## Context

`scripts/build-android-production.sh` and `scripts/build-macos-production.sh` already produce
signed, installable artifacts into `build/production/`. They stop there — getting one onto a second
machine has meant having the whole toolchain and rebuilding, which is fine for the one developer
this project has had so far and useless for anyone else. Issue #176 closes that gap: attach the same
Production `.apk` and `.dmg` to a GitHub Release, so installing means downloading a file instead of
cloning a repo.

The repo is public, so a Release is a public download page, and that is the fact 0015 did not have
in front of it. 0015's Decision — no paid developer account behind either signing identity — does
not change: this project still has nowhere to submit to, still has one developer, and $99/yr still
buys nothing this ADR needs. What changes is that 0015's reasoning leaned on a specific, now-false
premise about who reaches the artifact, and a reader of 0015 alone would conclude the install
friction below was never weighed rather than knowingly kept.

**A terminology hazard, named here because it will recur.** This repo already uses "release" as a
build type — `assembleRelease`, "the release keystore," "a signed release build," all present in
0015 and the build scripts before this ADR existed. This ADR introduces a second sense: a **Release**
is the GitHub object `publish-release.sh` creates, one per version, holding attached files. A
**release build** is the artifact — the thing `build-macos-production.sh` signs. Every release build
that reaches a Release is still just a release build; not every release build has been published to
one. Keep the two apart in anything written after this ADR.

## Decision

**Production's `.apk` and `.dmg` are attached to a GitHub Release by a local script,
`scripts/publish-release.sh`, run by hand after a local build — never by CI.** 0015 put both signing
identities deliberately outside the repo: the macOS certificate lives in a dedicated keychain, and
the Android keystore lives at `~/.meologue/release.keystore`, "outside the git history, the repo
directory, and anything a `git clean` or a fresh checkout would touch." A GitHub Actions job that
builds and publishes would need at least the Android keystore and its passwords inside GitHub
Secrets to sign anything, which is exactly the boundary 0015 drew and exactly what this ADR declines
to cross. The version stays hand-bumped across all seven sites that carry it
(`package.json`, `packages/core/package.json`, `apps/web/package.json`, `apps/e2e/package.json`,
`apps/macos/Cargo.toml`, `apps/android/app/build.gradle`'s `versionName`, and
`apps/macos/tauri.conf.json`, which `publish-release.sh` treats as the source of truth) — nothing
in the workspace derives them from one another, so drift is a manual-bump problem rather than a
tooling one. `publish-release.sh` verifies they agree, and separately that `versionCode` strictly
increased since the last `v*` tag, before it lets a Release happen; it does not bump anything
itself. `server/Cargo.toml` is excluded on purpose: it sits at `0.1.0`, ships no artifact, and
adding it would block every future Release on a number with no reader.

**The publish path refuses a stale artifact.** `build-macos-production.sh` already carries the scar
tissue for why: on 2026-09-01 a `cargo tauri build` failure after a successful `.app` compile left
`build/production/` silently holding a build 36 hours old, which was then tested and reported as a
defect (issue #157) — a build that fails loudly but leaves an old artifact in place is worse than one
that fails and leaves nothing, because nothing looks like success. That was a local build/test loop;
attaching the same stale file to a public Release turns the same failure mode into a permanent public
download page pointing at the wrong build. `publish-release.sh` compares each artifact's mtime against the
commit time of `HEAD` — the commit the Release is about to tag — and refuses any artifact older
than it. That definition is the only one checkable from outside the build: an artifact written
before the commit it is being tagged against cannot reflect that commit, however similar the tree
was. It is deliberately weaker than `build-macos-production.sh`'s own check, which compares against
the moment that build started and so can only ever vouch for its own run; this one has to judge a
directory it did not write. `--build` remains optional, so the guard is what stands between a
by-hand publish and a stale upload.

**No accounts, still — but reconsidered with the real premise this time.** 0015 rejected paid
developer accounts because "the only people who will ever run these builds already have the repo
open" — the problem an account buys you out of, stranger trust, did not exist. That sentence is now
false for anyone downloading from the Release page rather than cloning the repo, so the same question
was put again, honestly: pay $99/yr and remove the friction below, or keep the self-signed identities
and document the friction instead. The decision is unchanged, but the reasoning behind it is not the
same reasoning 0015 gave — 0015 assumed the trust problem away; this ADR pays its cost knowingly, in
one documented command and one settings toggle, rather than in a subscription. See Alternatives.

**The two platforms are not equally affected, and a reader must not conclude otherwise.**

- **Android is not degraded at all.** Android has no certificate authority for app signing — the
  Play Console fee 0015 already declined to pay is a store-listing registration, not a signing
  service, and no vendor sells an APK signing key the way a CA sells a TLS certificate. The OS only
  ever asks whether an update carries the same key as the install it replaces, never who that key
  belongs to. A self-signed release APK downloaded from a Release is exactly as trusted by the OS as
  the same APK built and installed via USB — the only costs of staying off the Play Store are
  discoverability and a one-time "install unknown apps" prompt, both already true before this ADR.
- **macOS is degraded only once the artifact crosses a network boundary.** Gatekeeper evaluates a
  file only if it carries the `com.apple.quarantine` extended attribute, set by whatever downloaded
  it — a browser, or anything else that goes through the relevant Launch Services API.
  A `.app` built locally by `build-macos-production.sh` was never downloaded and never carries that
  attribute, so Gatekeeper never evaluates it and the self-signed `meologue Dev` identity is never
  judged. The byte-identical `.dmg` fetched from a Release *is* quarantined, so it *is* evaluated, and
  a non-notarized, self-signed app is refused outright. This is the one friction point this ADR asks
  a downloader to clear by hand: `xattr -dr com.apple.quarantine /Applications/meologue.app`, or
  System Settings → Privacy & Security → "Open Anyway" — not right-click → Open, which macOS 15
  removed as a Gatekeeper bypass. What $99/yr and notarization would actually buy is exactly this:
  a CA-issued identity plus Apple's own scan, together making a downloaded `.dmg` open on a plain
  double-click. Understanding precisely what that purchase removes is why it was reconsidered here
  rather than dismissed on the strength of 0015's own reasoning alone.

**Releases are NOT marked `--prerelease`, even at `0.x`.** They were, briefly, on the semver-honest
reasoning that a zero major version carries no compatibility promise and a Release page's reader
deserves to know that before downloading. Publishing v0.2.0 that way showed what the flag actually
costs: GitHub's repo sidebar only ever surfaces the latest NON-prerelease release, so the homepage
read "1 tag / Create a new release" with a published Release sitting right there, and
`/releases/latest` did not resolve to it either — the REST endpoint answered `404` and the browser
URL redirected to the bare `/releases` list. That is the precise URL README's "Install a build"
hands people, so the flag silently broke the one path this ADR exists to create. Discoverability
is the whole point of publishing a Release; semver honesty about a version number is already
carried by the version number. A genuine release candidate can pass `--prerelease` by hand, and
should expect to be absent from both places.

## Alternatives considered

- **Build and publish in GitHub Actions CI.** Rejected: it would relocate the Android keystore and
  its passwords into GitHub Secrets to let a hosted runner sign anything, which is precisely the
  boundary 0015 drew when it put that keystore at `~/.meologue/`, "deliberately outside the git
  history, the repo directory, and anything a `git clean` or a fresh checkout would touch." A local
  script run by the one person who holds both signing identities keeps that boundary intact; CI would
  not.
- **Buy an Apple Developer account ($99/yr) for notarization**, this time weighed against the real
  premise rather than the stranger-trust framing 0015 dismissed it under originally. Rejected again:
  $99/yr recurring for a personal tool with one developer and no store listing, against a workaround
  that is one documented shell command run once per machine. If the friction ever becomes the thing
  actually blocking someone from running the app, this is the alternative to revisit — but that has
  not happened yet, and the fee buys nothing else this project needs.
- **Ship a server tarball or Dockerfile alongside the clients**, so a downloader could stand up their
  own Server rather than needing one already running. Rejected: `scripts/run-production.sh` already
  builds the web bundle and the release binary and serves both from one process — "there is no gap to
  fill" here that a second, separately-maintained packaging path would close that the existing script
  does not already close for anyone who has cloned the repo, which every Server operator, as opposed
  to every client installer, still needs to have done.
- **Add a universal or Intel macOS build.** Rejected: Tauri can produce one, but it costs real build
  time on every single release for a machine class this project has no way to test — the only Mac
  available is Apple Silicon. A broken Intel build shipped to a Release page is worse than no Intel
  build; Apple Silicon-only is scoped honestly instead.

## Consequences

**The version-verification and staleness guards in `publish-release.sh` are load-bearing, not
defensive boilerplate.** They exist because of a specific, already-occurred failure — issue #157 — in
which a failed build left a stale artifact that was silently trusted and reported as a product
defect. That happened once against a local `build/production/` directory only the developer looked
at; the identical failure against a public Release page would misinform anyone who downloaded it, not
just one confused test run. The guards this ADR requires are the same shape as the one
`build-macos-production.sh` already carries for its own `.dmg` step, applied one level higher, at
the point where an artifact stops being local.

**The install-friction cost is now something this project pays deliberately, and documents, rather
than something it never had to think about.** README's "Install a build" states the two platforms'
asymmetric costs plainly, `xattr -dr com.apple.quarantine` and all, because a downloader who hits
Gatekeeper's refusal with no explanation will reasonably read it as a broken build rather than an
expected, documented step.

**Nothing about how the two builds are produced changes.** `build-android-production.sh` and
`build-macos-production.sh`, and the signing identities 0015 established, are unchanged by this ADR;
only what happens to their output afterward is new.
