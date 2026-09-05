import type { ServerCapabilities, ServerCheckResult } from "@meologue/core";
import { PROTOCOL_VERSION } from "@meologue/core";

/**
 * Whether Reflect is answering Questions with no semantic retrieval behind
 * it — issue #203's own acceptance criterion. A chat-only Server
 * (`capabilities.reflect`/`config.reflect.effective`) still answers a
 * Question the moment embeddings are off or absent: `reflect.rs`'s tool
 * loop simply omits `similar_entries` for that request, with no error and
 * no visible sign anything changed. That silent quality loss is exactly
 * what this names — Reflect keeps working, but only ever searches whatever
 * was embedded before this gap opened, missing every Entry captured since.
 *
 * Deliberately takes two plain booleans, not a `ServerCapabilities` or a
 * `ConfigResponse`'s `FeatureConfig` pair — the two Settings surfaces that
 * need this sentence read the fact from different wire shapes
 * (`describeServerCheck` below from a health check's `ServerCapabilities`,
 * `ai-section.tsx` from `GET /v1/config`'s own `reflect.effective`/
 * `embeddings.effective` — the identical `RuntimeFlags`-backed booleans,
 * per `FeatureConfig`'s own doc comment on `effective`), and this is the
 * one function both funnel the condition through rather than each
 * reimplementing it against its own shape.
 */
export function describeSemanticRetrievalGap(reflect: boolean, embeddings: boolean): string | null {
  if (reflect && !embeddings) {
    return "Reflect is running without semantic retrieval — it can only search what was already embedded, missing anything captured since, with no error.";
  }
  return null;
}

/**
 * Turns a capability report into the sentence fragment(s) Settings shows
 * about it — the "gap" half of `describeServerCheck` below, split out so
 * `describeSemanticRetrievalGap`'s own condition has one call site here
 * rather than being inlined into the string-building below and duplicated
 * wherever else a capability report needs describing.
 */
function capabilityGapSentences(capabilities: ServerCapabilities): string[] {
  const notes: string[] = [];
  const missing: string[] = [];
  if (!capabilities.reflect) missing.push("Reflect");
  if (!capabilities.digest) missing.push("Digest");
  if (missing.length > 0) {
    // "no Digest model configured" for one gap; "no Reflect or Digest model
    // configured" for both — `capabilities.embeddings` never gates a
    // Destination row on its own (see `useDestinations()`), so it never
    // joins this particular sentence even though the Server reports it.
    const gap = missing.map((name) => `${name} model`).join(" or ");
    notes.push(`this server has no ${gap} configured`);
  }
  const semanticGap = describeSemanticRetrievalGap(capabilities.reflect, capabilities.embeddings);
  if (semanticGap !== null) {
    notes.push(semanticGap);
  }
  return notes;
}

// Distinct, actionable copy per outcome (ticket 30). A failed `fetch` in a
// browser is opaque — DNS failure, connection refused, TLS failure, CORS
// rejection and OS cleartext blocking are all indistinguishable from
// JavaScript — so "unreachable" is deliberately the one honest catch-all
// rather than several confident guesses.
//
// Issue #133: a bare "Reachable" was true and useless on a Server that
// answers its health check but can serve neither Destination — this names
// the specific gap instead, straight off the same `capabilities` object
// `useDestinations()` (`chat-list.tsx`) locks rows against, so Settings and
// the chat list can never disagree about what a Server can do. `undefined`
// (an older Server, or one this check hasn't learned the answer from yet)
// still reads as a plain "Reachable" — Settings has no missing-model gap to
// name when it doesn't know one exists, the same "unknown means unlocked"
// posture the chat list takes.
//
// Issue #203 extends this with `capabilityGapSentences`'s second note: a
// Server that can serve Reflect but not embeddings is not a "missing
// model" gap (Reflect itself works fine) — it's the narrower, silent
// degradation `describeSemanticRetrievalGap` names, appended as its own
// sentence rather than folded into the "no ... model configured" one,
// which is reserved for a feature that cannot run at all.
export function describeServerCheck(result: ServerCheckResult): string {
  if (result.ok) {
    const capabilities = result.capabilities;
    if (capabilities === undefined) {
      return "Reachable — this server is up and speaking the protocol this app expects.";
    }
    const notes = capabilityGapSentences(capabilities);
    if (notes.length === 0) {
      return "Reachable — this server is up and speaking the protocol this app expects.";
    }
    return `Reachable — but ${notes.join("; and ")}.`;
  }
  switch (result.reason) {
    case "not-configured":
      return "No server configured — sync is off. Enter an address to turn it on.";
    case "invalid-url":
      return "That's not a valid URL. Enter a full address, like https://example.com.";
    case "unreachable":
      return "Couldn't reach this address. Check that the server is running and the address is correct.";
    case "http-error":
      return `Server responded with an error (HTTP ${result.status}). Check the server's logs.`;
    case "protocol-mismatch":
      return `Server speaks protocol v${result.serverVersion}; this app expects v${PROTOCOL_VERSION}. Update the app or the server so they match.`;
  }
}
