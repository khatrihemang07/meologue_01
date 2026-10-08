# 0091: Dictation goes through the meologue Server

## Status

Accepted. Supersedes the parts of [0090](0090-dictation-goes-through-an-external-openwhispr-gateway.md)
that put the gateway URL and token on each Device and that hide the mic until a Device has a gateway
URL. Builds on [0060](0060-server-settings-are-a-stored-overlay-on-the-environment-and-the-ui-wins.md) (stored settings over the
environment) for how the Server holds the new settings.

## Context

Issue #454 shipped Composer dictation with a per-Device gateway URL and token (0090), and the mic
rendered only after both were saved in Settings. The v0.17.0 production build then showed no mic at
all: a fresh install has neither value, so the feature was invisible (issue #455, "I couldn't find
any mic button anywhere").

The owner's decision: the dictation gateway and the meologue Server run on the same machine, so
Devices should not configure a second address. Dictation is handled at the Server.

## Decision

**The Server proxies to the existing OpenWhispr gateway.** `POST /v1/dictations` (multipart `audio`,
optional `?wait=1`) and `GET /v1/dictations/{id}` forward to the gateway with the Server-held bearer
token. The gateway is unchanged. The multipart body is streamed through with its Content-Type, the
body limit on the POST route is raised to 50 MB (axum's default is about 2 MB), and the gateway's
status and JSON body are passed through for 200, 202, 400, 404, 413 and 500. The Server adds three
errors of its own: `503 {"error":"dictation_unavailable"}` when no token is configured or the toggle
is Off, `502 {"error":"gateway_unreachable"}` on a connection error or timeout (120 s, since
`wait=1` holds up to 25 s and uploads can be large), and `502 {"error":"gateway_rejected_token"}`
when the gateway answers 401.

**Configuration is Server settings plus environment.** Like the Chat endpoint, under Settings → On the
server: a stored `dictation_base_url` and `dictation_token` (migration 0026), with
`MEOLOGUE_DICTATION_URL` and `MEOLOGUE_DICTATION_TOKEN` as the fallback and the same
stored-then-environment precedence and `MEOLOGUE_CONFIG_LOCK` rule as every other setting (0060).
With neither set the URL is `http://127.0.0.1:47300`. The token is write-only on the wire:
`GET /v1/config` reports `dictation_token` as `{configured, source}` and never the value, and an empty
`PATCH` value clears it back to the environment. This is stricter than the Chat API key, which 0060
returns in full.

**A Default/On/Off toggle sits next to Reflect, Digest and Embeddings.** "Configured" means a token
is resolved. Default follows "configured"; Off disables a configured gateway; On cannot conjure a
token. Unlike the other three, dictation needs no restart: the routes are always registered and the
resolved gateway is held in `RuntimeFlags`, re-derived on every `PATCH /v1/config`.

**The mic follows the Server's capability, not a Device setting.** `GET /v1/health` reports
`capabilities.dictation`, true when a token is configured and the toggle allows it. It is read from
memory like the other capabilities, so health stays database-free and does not probe the gateway. The
field is optional on the wire; an older Server lacks it, which a Device reads as "no dictation". The
mic (first group of the format toolbar) shows only when the format toolbar is on and the connected
Server reports the capability.

**Device-side configuration is removed.** The per-Device dictation URL and token, the Dictation
settings section, and the Backup exclusion for the token (0090) go away; there is no Device secret
left to exclude.

**`PROTOCOL_VERSION` is not bumped.** The change is additive: a new optional capability and new
routes, with no change to the sync wire shape. This follows the precedent of issue #184 (Events).

## Alternatives considered

- **Proxy versus porting the gateway into Rust.** The proxy was chosen: the gateway already drives
  OpenWhispr's pipeline (Whisper, dictionary, cleanup, snippets, history), and the Server only needs
  to reach it.
- **Server settings plus environment versus environment only versus reading the gateway's own config
  file.** Settings plus environment was chosen, matching how the Chat endpoint is configured.

## Consequences

- A fresh install shows the mic as soon as the Server it connects to has a dictation token; nothing
  is typed on the Device.
- Dictation is only as available as the Server and the gateway: if the Mac is off the Server answers
  `gateway_unreachable`.
- The audio now travels Device to Server to gateway. The Server and gateway share a machine, so the
  second hop is loopback.
- Reaching the gateway no longer depends on the Device's origin, so the mixed-content restriction on
  an HTTPS web origin calling an http gateway (0090) no longer applies; the secure-context
  requirement for recording itself is unchanged.
- The Server has no authentication (0003), so anyone who can reach it can use the proxy and spend the
  gateway's token. This matches what that reachability already allows for Entries.
