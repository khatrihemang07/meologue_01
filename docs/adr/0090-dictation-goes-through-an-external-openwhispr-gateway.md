# 0090: Dictation goes through an external OpenWhispr gateway

## Status

Accepted. Builds on [0008](0008-device-settings-are-local-configuration-held-outside-the-entry-store.md)
(the gateway address and token are Device settings) and on
[0017](0017-https-transport-for-another-device-is-a-tailscale-serve-concern.md) and
[0081](0081-an-insecure-origin-names-the-https-address-that-would-work.md) (the secure-context
constraint). Amends the Backup rule that a Backup carries every `meologue.*` Device setting
(issue #195): one key is now excluded. Supersedes nothing.

## Context

Issue #454 adds speech-to-text to the Composer: a mic button records, the audio is transcribed, and
the text lands at the cursor. The user already runs OpenWhispr on the Mac, with its own Whisper
configuration, dictionary prompt, LLM cleanup and snippet expansion, and it keeps a history of what
was dictated. Dictating into meologue should go through that same pipeline so the output is the same
text the user would have got from OpenWhispr's own hotkey, and so the dictation also shows up in
OpenWhispr's history.

## Decision

**The transcription happens in a separate gateway service, not in meologue.** The gateway lives
outside this repo, runs on the Mac, and exposes a small HTTP surface (`GET /v1/health`,
`POST /v1/dictations`, `GET /v1/dictations/:id`, bearer-token auth). meologue only records audio and
speaks that contract (`apps/web/src/lib/dictation-transport.ts`). Whisper, the dictionary, cleanup
and snippets all belong to OpenWhispr; none of it is re-implemented or configurable here. The
transport deliberately does not go through `server-request.ts`: that helper marks the meologue
Server unreachable on any network failure, and a dictation gateway outage must never read as
"Sync is down" (ADR 0011).

**The token is a Device-local secret and is excluded from Backup and Restore.** The gateway URL and
token are stored as plain `meologue.dictation-url` and `meologue.dictation-token` keys (ADR 0008's
format). The URL travels in a Backup like any other Device setting. The token does not:
`readAllDeviceSettings` skips it and `applyDeviceSettings` refuses to write it, through a small
explicit set (`BACKUP_EXCLUDED_KEYS` in `apps/web/src/lib/settings.ts`). The token is a credential,
and Backup files are user-handled files that leave the Device. Both directions are checked, because
a Backup made by another build or edited by hand could still carry a token, and Restore must not
overwrite the one this Device holds. The cost is that a restored Device has to have the token typed
in again.

**The mic button is hidden while no gateway URL is set.** `useDictationEnabled()` is true only for a
non-empty URL, and the Composer renders the button only then. This follows ADR 0011's reading of an
empty address: unset means the feature is off, not broken. A button that always showed would, for
every user without a gateway, lead to a failure toast on first press. Hiding it keeps the Composer
unchanged for them.

**Recording needs a secure context.** `navigator.mediaDevices` is undefined on a plain-http page
that is not `localhost`, so `getUserMedia` cannot even be called there. This is the same constraint
0017 and 0081 describe for OPFS, and the app reports it as its own failure ("Dictation needs a
secure (HTTPS or localhost) page.") rather than as a denied permission, because the fix is a
different URL, not a different permission setting. The Android shell serves the app from
`http://localhost` (`apps/web/capacitor.config.ts`), which is a secure context; whether the macOS
Tauri origin counts as one for `getUserMedia` is checked by the acceptance run on that shell, not
assumed. Both native shells also declare the microphone permission (`RECORD_AUDIO` on Android;
`NSMicrophoneUsageDescription` and the audio-input entitlement on macOS, whose build is signed with
the hardened runtime).

**An HTTPS-served web origin cannot call an http gateway.** The gateway is a LAN service with no
certificate, in the same position as the meologue Server (ADR 0003), but a page served over HTTPS
(for example through Tailscale Serve, which is what 0017 prescribes for using the web app from
another Device) is blocked by mixed-content rules from fetching an `http://` address. The browser
reports that as a network failure, so it surfaces as "Couldn't reach the dictation gateway."
meologue does not work around it. The gateway has to be served over HTTPS too (for example its own
Tailscale Serve address) when the web app is itself on HTTPS. The Android shell's
`http://localhost` origin may call an `http://` gateway (the reason `capacitor.config.ts` picks
the `http` scheme), so the restriction is specific to the web target served over HTTPS.

## Alternatives considered

- **Put the endpoint inside meologue's own Rust Server.** Rejected by the owner in favour of a
  standalone service that other clients can use later.
- **Have the gateway reproduce OpenWhispr's pipeline itself, or drive the running app.** This
  belongs to the gateway's design; see the gateway's README.
- **Expose OpenWhispr's whisper-server port directly.** Rejected: it has no auth, no cleanup or
  dictionary, and is not OpenWhispr's full processing.

## Consequences

- A restored Device, or a second Device, needs the gateway token entered once in Settings.
- Dictation is only as available as the gateway: if the Mac is off, the mic button fails with
  "Couldn't reach the dictation gateway." and nothing is queued for later.
- The audio leaves the Device for the gateway, which is on the user's own network; this is stated in
  the Settings hint next to the fields.
