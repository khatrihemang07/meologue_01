# 0021: The server calls an OpenAI-compatible LLM, over egress ADR 0003 and ADR 0017 never priced in

## Status

Accepted

## Context

ADR 0003 made reachability the entire trust boundary for the server: a Device that can reach it
over the network is trusted with every Entry. ADR 0017 made that boundary permanent by ruling
out Tailscale Funnel outright — the server is reachable only from inside the tailnet, never from
the open internet. Both decisions are about who can reach *in*.

Reflection (the domain concept — see `CONTEXT.md`) needs the server to reach *out*: to embed
Entry text into vectors (this ticket) and, later, to send Grounding and a Question to a chat
model and get an Answer back (ticket 4). Neither ADR considered outbound egress, because nothing
before this needed the server to call anything else. That gap needs closing explicitly rather
than left implicit, because the two things this reaches out to are not equivalent in what they
expose: an embedding call sends Entry text to whatever process answers at `MEOLOGUE_EMBED_BASE_URL`
so it can be turned into a vector; a chat call sends Entry text (as Grounding) *and* the user's
Question to whatever process answers at `MEOLOGUE_CHAT_BASE_URL` so it can be turned into an
Answer. Both are "Entry text leaves the process," but only one of them is plausible to point at
something outside the tailnet — a hosted provider makes little sense as an embedding backend
when a local model already sits on the same machine, but it's a completely ordinary choice for
chat.

## Decision

**Both the chat and embedding backends are configured as a base URL, model name, and optional
API key — pointing at anything that speaks the OpenAI-compatible `/chat/completions` and
`/embeddings` shapes.** `server/src/llm.rs`'s `OpenAiCompatibleClient` doesn't know or care
whether it's talking to a same-tailnet Ollama instance or a hosted provider; the only thing that
decides is which URL it was configured with.

**An unset config value means the feature is off, not misconfigured — mirroring ADR 0011's
"unset Server URL means Sync is off."** No `MEOLOGUE_CHAT_BASE_URL`/`MEOLOGUE_CHAT_MODEL` means
Reflection never calls out for a chat completion; no `MEOLOGUE_EMBED_MODEL` (with no base URL
resolvable from either `MEOLOGUE_EMBED_BASE_URL` or a fallback to the chat base URL) means the
embedding worker (ADR 0022) never starts, and the server runs exactly as it does with this
ticket reverted. The default state of a freshly cloned, freshly run server is silence on this
front, the same as Sync's default is silence until a Server URL is typed in.

**Embeddings are expected to stay local, so Entry text embedding never leaves the tailnet under
the default, documented configuration.** `MEOLOGUE_EMBED_BASE_URL` falling back to the chat base
URL is a convenience for the common case of one local endpoint serving both, not an endorsement
of pointing either at a hosted provider by default. The README documents Ollama as the intended
embedding backend precisely because it keeps this promise without the operator having to think
about it.

**Pointing `MEOLOGUE_CHAT_BASE_URL` at a hosted provider is allowed, and is the first time Entry
bodies would leave the tailnet — this ADR records that as a deliberate, visible choice made in
config, not a gap discovered later.** Nothing in the server prevents `MEOLOGUE_CHAT_BASE_URL`
from being `https://api.some-hosted-provider.example/v1`. That's intentional: a local chat model
capable enough for Reflection may not exist on every machine this runs on, and the operator
should be free to make that trade. What this ADR insists on is that the trade is visible —
spelled out here, and in the README's description of each variable — rather than something a
future reader has to reverse-engineer from the fact that `reqwest` got added as a dependency.

## Alternatives considered

- **Route chat and embeddings through the same base URL always, with no independent override.**
  Rejected: the two workloads have different latency and capability profiles (an embedding call
  is small and frequent, a chat call is larger and rarer), and different operators may
  legitimately want a small local embedding model alongside a more capable hosted chat model, or
  vice versa. Forcing them onto one URL would make that combination inexpressible.
- **Require an explicit `MEOLOGUE_EMBED_BASE_URL` always, with no fallback to the chat URL.**
  Rejected as unnecessary friction for the common case — a single local OpenAI-compatible
  wrapper (Ollama, in the reference setup) serving both chat and embeddings is the expected
  default, and typing the same URL into two variables buys nothing. An explicit
  `MEOLOGUE_EMBED_BASE_URL` still overrides the fallback for anyone who splits the two.
- **Have the server refuse to start, or warn loudly, if `MEOLOGUE_CHAT_BASE_URL` doesn't resolve
  to a private/tailnet address.** Rejected: ADR 0003's model is network-level trust, not a
  server-enforced allowlist, and this project has never tried to distinguish "private" from
  "public" addresses in code. Enforcing it here for one specific outbound call would be a new
  kind of policy this codebase doesn't otherwise have, for a choice that's better left legible in
  config (this ADR) than blocked in code.

## Consequences

`server/README.md` documents each of the six `MEOLOGUE_CHAT_*`/`MEOLOGUE_EMBED_*` variables and
states plainly that an unset chat base URL keeps Entry text on the tailnet, while a configured
one is the operator's explicit choice to send it further. If a future ticket adds authentication
or a narrower egress allowlist, this ADR is the one to revisit — it documents the current state
(egress is possible and configuration-driven) rather than a guarantee that it can't happen.
