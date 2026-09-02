## Before you install

**Apple Silicon only.** The `.dmg` is built `aarch64`; there is no Intel build. If your Mac has an
Intel chip, this release has nothing for it.

**macOS: signed but not notarized** (docs/adr/0015). There is no Apple Developer account behind
this build, so Apple never notarized it — but that alone would not stop it from opening, because
Gatekeeper only evaluates files carrying the `com.apple.quarantine` extended attribute, and that
attribute is set by whatever downloaded the file, not by the file itself. A `.app` you build
locally on your own machine was never downloaded, so it is never evaluated. The same bytes fetched
from this Release page were, and Gatekeeper will refuse them as being from an "unidentified
developer." Clear the attribute and it opens like any local build:

```
xattr -dr com.apple.quarantine /Applications/meologue.app
```

Or, without a terminal: System Settings → Privacy & Security → scroll to the blocked-app notice →
"Open Anyway". (Not right-click → Open — that bypass was removed in macOS 15.)

**Android: allow installs from your browser.** Your browser will ask for permission the first time,
under "Install unknown apps" — allow it for the browser you downloaded the APK with. The APK is
self-signed (docs/adr/0015) rather than signed by a store-issued key, and that is not a degraded
artifact: Android has no certificate authority for app signing and never asks who signed a package,
only that an update carries the *same* key as the install it's replacing. Debug and release builds
use different keys, so if `com.meologue.app` is already installed from a debug build, uninstall it
first — installing over it will fail with a signature mismatch otherwise.

**No authentication** (docs/adr/0003). The Server trusts anything that can reach it on the network.
Run it on localhost or a tailnet only — never expose it to a public host.

**Sync is off until a Server URL is set**, in Settings (docs/adr/0011). Without one, each install
is a local-only journal.
