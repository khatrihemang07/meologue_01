# 0015: Release builds are signed with locally-generated identities

## Status

Accepted

## Context

Neither native shell was signed at all: the Android build had no signing config, and
`apps/macos/tauri.conf.json` had no `bundle.macOS` block. Both platforms normally get their
signing identity from a paid developer program — an Apple Developer account for macOS
notarization, a Play Console account (or at least a self-managed upload key with Google's
backing) for Android distribution. This project has neither, and, being a self-hosted personal
tool with no App Store or Play Store listing, has no reason to ever acquire one: there is nowhere
to submit to.

An unsigned macOS app and an unsigned Android APK still work — Gatekeeper and `adb install` both
tolerate them — but that isn't the whole story. macOS ties Accessibility/Input-Monitoring-style
permission grants and, more immediately here, launch trust to a signing identity; an APK cannot
be installed over an existing install at all without *some* signature, matching or not, on both
sides. "Unsigned" isn't neutral — it's a specific set of platform behaviors this project needs to
opt out of deliberately, not by omission.

## Decision

Both platforms get a signing identity generated on the developer's own machine, with no store
account behind either one. `scripts/setup-signing.sh` creates both, and is the only place either
identity is created.

**macOS.** The script creates a dedicated keychain
(`~/Library/Keychains/meologue-signing.keychain-db`, not the login keychain) and a self-signed
certificate (`openssl req -x509`, `CN=meologue Dev`) carrying the code-signing extended key usage
(`extendedKeyUsage=codeSigning`) and a critical `digitalSignature` key usage — without those two
extensions, `codesign` refuses to treat the cert as a code-signing identity at all. The cert is
packaged as a `.p12` and imported with `security import ... -T /usr/bin/codesign`, then
`security set-key-partition-list -S apple-tool:,apple: -s -k ... "$KEYCHAIN"` grants `codesign`
standing access to the key — without that line, every single build prompts for the keychain
password interactively, which defeats the point of scripting this at all.
`apps/macos/tauri.conf.json` then just names the identity in `bundle.macOS.signingIdentity`;
Tauri signs the `.app` and the newly-added `dmg` bundle target with it automatically, no
post-build `codesign` step needed. The macOS half is safe to re-run: it deletes and recreates the
keychain every time, so a fresh cert costs nothing beyond needing Gatekeeper's one-time
right-click→Open again (see Consequences).

The app ships with **no entitlements**. Penio, the sibling project this technique is adapted
from, carries four hardened-runtime exceptions in its `entitlements.plist` — but those exist for
Penio's own WebKit needs (JIT, unsigned executable memory, disabled library validation, dyld
environment variables), not for anything meologue's webview does. Starting from zero and adding
exceptions only if the signed build actually fails to launch avoids copying permissions this app
has no use for.

**Android.** The script also creates a release keystore with `keytool -genkeypair`, but *outside*
the repo, at `~/.meologue/release.keystore` — see Consequences for why. It writes a gitignored
`apps/android/keystore.properties` next to it, holding the keystore path and its two generated
passwords (store and key). `apps/android/app/build.gradle` reads that file into
`signingConfigs.release`, wired to `buildTypes.release`. Unlike the keychain, **the script refuses
to touch an existing keystore** — see Consequences for why that asymmetry exists. If
`keystore.properties` is missing, the build doesn't quietly emit an unsigned release APK: a
`gradle.taskGraph.whenReady` check fails any release-variant task with a message naming
`scripts/setup-signing.sh`, while leaving `assembleDebug` (which needs no keystore at all)
untouched. `minifyEnabled` stays `false` in the release build type — R8 breaks Capacitor plugins
silently without proguard rules tuned for them, and none exist yet; that's an orthogonal problem
to signing and out of scope here.

## Alternatives considered

- **Enroll in the Apple Developer Program and Google Play Console anyway**, even without an
  intent to distribute through either store, purely to get notarization and a Play-backed upload
  key. Rejected: both cost money annually for a personal, self-hosted tool that will never be
  listed anywhere, in exchange for solving a problem (stranger trust) this project doesn't have —
  the only people who will ever run these builds already have the repo open.
- **Ship builds unsigned on both platforms.** Rejected for Android outright: an unsigned APK is
  actually a *build error*, not a lesser form of a real one — Android's package installer refuses
  it. Rejected for macOS because launch trust and TCC permission continuity depend on a stable
  identity; an unsigned `.app` re-triggers Gatekeeper and permission prompts on every rebuild, not
  just once.
- **Generate the Android keystore inside the repo**, gitignored like `keystore.properties` is.
  Considered and rejected — see Consequences below for the reasoning; it's the same reasoning that
  puts the keystore in `~/.meologue/` in the Decision above rather than repeating it here.

## Consequences

**Notarization is permanently off the table**, not merely deferred. Apple only notarizes builds
signed with a certificate it issued, which requires the paid developer program this project
deliberately doesn't have. Anyone who opens the app on a machine that isn't the one it was built
on gets Gatekeeper's "unidentified developer" block and needs one right-click→Open to run it —
every time the app is rebuilt with a freshly recreated keychain, since each self-signed cert is a
new, unrecognized identity as far as Gatekeeper's cache is concerned. For a single-developer,
self-hosted tool this is a one-time nuisance per build, not a distribution blocker.

**The Android keystore is the one artifact in this whole setup that is genuinely
unrecoverable if lost**, which is why it lives at `~/.meologue/` — deliberately outside the git
history, the repo directory, and anything a `git clean` or a fresh checkout would touch — and why
`setup-signing.sh` refuses to overwrite it once it exists. Android has no equivalent of macOS's
"just recreate the keychain": every release APK on a device is permanently tied to the key that
first signed it, and `adb install -r` (and the Play Store, if this project ever somehow acquired
a listing) refuses to install a new signature over an old one. Losing the keystore means every
device with a release build already installed can never receive another signed upgrade over
it — the only recovery is uninstalling and reinstalling fresh, which discards nothing server-side
(Entries live in Postgres, ADR 0001) but does lose whatever hasn't synced yet. The keystore
directory is not backed up by this project in any way; that is a gap a future ticket could close,
but doing so here would be solving a problem beyond what issue #42 asked for.

Every future contributor machine needs its own run of `scripts/setup-signing.sh` before it can
produce a release build — debug builds need nothing and remain the documented daily path (README).
A machine that runs the script twice gets a brand-new macOS identity both times (expected) and
the same Android keystore both times (required) — the asymmetry between the two halves of the one
script is the load-bearing property this ADR records, not an inconsistency to clean up later.

See [0054](0054-release-builds-are-published-as-github-releases.md): once release builds reach a
public GitHub Release, "the only people who will ever run these builds already have the repo open"
stops being true, though the Decision above does not change.
