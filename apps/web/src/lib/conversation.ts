/**
 * The Conversation types shared by Reflection's page and its components —
 * CONTEXT.md's own definition: "The running sequence of Questions and
 * Answers inside one Session... Because the Server holds the Session, a
 * Conversation is reachable from every Device, not only the one it started
 * on."
 *
 * There used to be an in-memory `useConversationStore` here (a Zustand
 * store shaped like `lib/settings.ts`), built when ADR 0020 deliberately
 * deferred persistence: "Building it when the asking-and-answering ticket
 * actually needs persistence — if it ever does — means designing it
 * against a real shape instead of one imagined now." ADR 0025 is that
 * ticket. A Conversation now lives on the Server as part of its Session,
 * fetched through TanStack Query (`pages/reflection-page.tsx`) rather than
 * held in a client-side store — so there is no store left to define here,
 * only the shape both the page and `grounding-disclosure.tsx` render.
 */
import type { WireSessionTurn } from "@meologue/core";

/** What a `read_digest` tool call found, when it found a real Digest — see `ConversationTurn.digestSource`. */
export interface DigestGroundingSource {
  period: string;
  periodStart: string;
  periodEnd: string;
}

/** One completed Question-and-Answer pair, plus the Grounding it drew on. */
export interface ConversationTurn {
  question: string;
  answer: string;
  /**
   * The Entry ids that appeared in a tool result during this turn's run, in the order the server
   * returned them — see `WireSessionTurn.grounding_entry_ids`'s own doc comment (server/src/sessions.rs).
   * Never a merged, ranked list computed in advance (issue #99 removed the pipeline that used to
   * build one): simply what the tools returned, which can include an Entry that turned out not to
   * matter — `groundingOutcome` is what a caller should key off to render an outcome, not the
   * length of this array alone.
   */
  groundingEntryIds: string[];
  /**
   * Whether this turn's run called a tool at all — see `WireReflectResponse.tool_called`'s own
   * doc comment (server/src/reflect.rs) for why this is not derivable from `groundingEntryIds`
   * alone: an empty array means either "a tool ran and found nothing" or "no tool ever ran", and
   * those read very differently to a user (issue #103 — a run that never looked once answered as
   * though it had, with no way for this page to tell the two apart, because this field didn't
   * exist). `groundingOutcome` is where that distinction actually gets used.
   */
  toolCalled: boolean;
  /**
   * A `read_digest` tool call surfaced a real Digest this run. `read_digest` deliberately
   * populates no `entry_ids` — a Digest's Grounding belongs to the Digest, not to this one tool
   * call — which otherwise leaves `groundingEntryIds` empty for a Digest-only Answer,
   * indistinguishable from "nothing matched at all." This is what `grounding-disclosure.tsx`
   * reads instead, to make "an Answer drawn from a Digest" an honest, distinct thing the
   * interface says, not silence.
   *
   * Available for both a turn just answered in this browser session (from the live
   * `tool_execution_end` event's own `details` — `reflect-live-run.ts`'s `applyReflectEvent`) and
   * one restored from a fetched Session (`WireSessionTurn.digest_source`, derived from the tree —
   * `sessions::SessionTurnRow::digest_source`'s own doc comment on `server/src/sessions.rs`
   * explains why that field exists at all: before it did, a Digest-sourced Turn read back after a
   * page reload with no way to tell it apart from an ordinary one).
   */
  digestSource?: DigestGroundingSource;
  /**
   * Issue #98: the model that actually produced this turn's Answer —
   * `WireSessionTurn.model`/`WireReflectResponse.model`. Always present
   * (both wire shapes require it — even a Turn stored before this ticket
   * reads back as the Server's own configured default,
   * `SessionTurnRow::model`'s own doc comment on `server/src/sessions.rs`),
   * so this is never optional here either.
   */
  model: string;
}

/**
 * The wire shape both `WireSessionTurn` (a turn loaded from a Session) and
 * `WireReflectResponse` (a turn just answered) share — everything a
 * `ConversationTurn` needs, in snake_case. `WireReflectResponse` doesn't
 * echo `question` back (the client already has it, from what it asked), so
 * a caller mapping a fresh Answer builds this object as `{ question,
 * ...response }` rather than this function reading `question` off the
 * response itself.
 *
 * Issue #105: `digest_source` is now on *both* wire shapes — the same
 * `sessions::DigestSourceTracker` computation
 * `server/src/reflect.rs::run_reflect_stream_inner` folds over the run's
 * own steps and puts directly on `ReflectResponse`, flattened onto
 * `agent_end` (`run_reflect_stream`'s own doc comment) — so it needed no
 * separate `Pick` here even before this ticket: `WireSessionTurn` and
 * `WireReflectResponse` already agreed on the field's shape structurally.
 */
type WireConversationTurn = Pick<
  WireSessionTurn,
  "question" | "answer" | "grounding_entry_ids" | "tool_called" | "model" | "digest_source"
>;

/**
 * Maps the wire's snake_case turn to the camelCase `ConversationTurn` the
 * components already take. This is the one place that knows both shapes —
 * `pages/reflection-page.tsx` calls it both for turns restored from a
 * fetched Session and for the turn a just-answered ask produces, so the two
 * paths can't drift into disagreeing about the mapping.
 *
 * Issue #105 removed this function's own second, `live` parameter: before
 * that ticket, `digestSource` for a turn just answered in this browser
 * session came from the *client* re-deriving it from `tool_execution_end`
 * events as they streamed by (`reflect-live-run.ts`) — a second, ad hoc
 * copy of a rule `server/src/sessions.rs`'s `digest_source_from_details`
 * already stated once, and the two could (and did — issue #105's own
 * reported bug) disagree. `wire.digest_source` is now the *only* source,
 * on both paths: the live path gets it because `ReflectResponse` itself
 * now carries the field, server-derived, and a restored Session already
 * did (`WireSessionTurn.digest_source`, since issue #99).
 */
export function conversationTurnFromWire(wire: WireConversationTurn): ConversationTurn {
  return {
    question: wire.question,
    answer: wire.answer,
    groundingEntryIds: wire.grounding_entry_ids,
    toolCalled: wire.tool_called,
    digestSource: wireDigestSource(wire.digest_source),
    model: wire.model,
  };
}

function wireDigestSource(
  source: WireSessionTurn["digest_source"],
): DigestGroundingSource | undefined {
  if (source === null || source === undefined) {
    return undefined;
  }
  return {
    period: source.period,
    periodStart: source.period_start,
    periodEnd: source.period_end,
  };
}

/**
 * The outcome a turn's `(groundingEntryIds, toolCalled, digestSource)` triple
 * resolves to — named in CONTEXT.md's own vocabulary (Grounding), plus
 * issue #96's own addition (`"digest"`). `GroundingNote` (reflection-page.tsx)
 * and `summaryLabel` (grounding-disclosure.tsx) both used to branch on the
 * raw fields independently; two cascades over the same fields drift, and
 * drifting here means the caption and the expander label disagree about
 * what happened. Deriving the outcome once, here, is what keeps them
 * agreeing by construction.
 *
 * Issue #99 removed `grounded`/`fallback_used` from the wire (and, with
 * them, `"disclosedFallback"` from this type): both were a verdict the
 * Server extracted from the fixed pipeline's own answering call, which the
 * tool-calling loop that replaced it has no equivalent for — see
 * `server/src/reflect.rs`'s own module doc comment. There is no longer a
 * disclosed-fallback mechanism anywhere behind this wire shape for a turn
 * to have run, so there is no shape left for this type to represent it
 * with.
 */
export type GroundingOutcome =
  /** A `read_digest` tool call surfaced a real Digest this run — see `digestSource`. Checked before the Entry-count cases below: a Digest is not Entries, so it is never described as either. */
  | "digest"
  /**
   * Issue #103: the run never called a tool at all — `toolCalled` is `false`, so nothing was
   * ever searched, as opposed to `"nothingFound"` below where something genuinely was. This is
   * the outcome the live bug this ticket fixes used to render identically to `"nothingFound"`:
   * a confident Answer that never looked, shown with the same "nothing matched" caption a real
   * empty search gets. Checked before `"nothingFound"` for exactly that reason — the two must
   * not collapse back into one outcome the way they did before this field existed.
   */
  | "neverLooked"
  /**
   * A tool ran and genuinely found nothing — `toolCalled` is `true`, `groundingEntryIds` is
   * empty.
   *
   * Issue #111: since #92 removed `similar_entries`'s similarity floor, `groundingEntryIds`
   * reaching this function empty requires *every* tool call the whole run made to come back
   * empty — and `similar_entries` (semantic top-k, no floor) essentially never does for a
   * non-empty journal, whatever the Question. So this outcome is not reachable by the kind of
   * Question it was written for (a topic absent from the journal) unless the model happens
   * never to call `similar_entries` at all during that run. It stays reachable through the
   * other two tools, which *can* legitimately return zero: `entries_in_range` for a real
   * calendar range with nothing written in it, and `search_entries`'s literal word/trigram
   * match for a query nothing in the journal is close enough to. `apps/e2e/tests/reflection.spec.ts`'s
   * "a run that genuinely finds nothing" test exercises exactly the `entries_in_range` case,
   * deliberately (a query embedding the same as every Entry's, per `STUB_EMBEDDING`'s own doc
   * comment in `llm-stub.ts`, would otherwise make `similar_entries` unable to come back empty
   * even in the stub). Kept, not deleted: it is still the honest outcome for the runs that do
   * hit it, and collapsing it into `"grounded"` would make an Entry-less disclosure claim
   * Entries that don't exist.
   */
  | "nothingFound"
  /** At least one Entry appeared in a tool result this run — simply what the tools returned, not a verdict that it actually answers the Question (see this type's own doc comment). */
  | "grounded";

/**
 * Derives a turn's outcome. `digestSource` wins outright — a Digest-sourced
 * Answer is never described as Grounding, whatever `groundingEntryIds`
 * happens to carry (`read_digest` populates no `entry_ids` of its own, but a
 * Digest-answered Turn's run can still have called another tool first).
 * Otherwise: no tool ever called is `"neverLooked"`; a tool called but
 * `groundingEntryIds` empty is `"nothingFound"`; anything else is
 * `"grounded"` — simply "the tools returned at least one Entry," not a
 * relevance judgment (this type's own doc comment).
 */
export function groundingOutcome(
  turn: Pick<ConversationTurn, "groundingEntryIds" | "toolCalled" | "digestSource">,
): GroundingOutcome {
  if (turn.digestSource !== undefined) {
    return "digest";
  }
  if (!turn.toolCalled) {
    return "neverLooked";
  }
  if (turn.groundingEntryIds.length === 0) {
    return "nothingFound";
  }
  return "grounded";
}
