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
   * The Entry ids the Answer was actually built from, in the order the server returned them. When
   * `fallbackUsed` is true these are the last few days of Entries (see `fallbackUsed`), not
   * Grounding the server judged relevant.
   */
  groundingEntryIds: string[];
  /**
   * Whether the server judged that the Grounding it found actually answers the Question — see
   * `WireReflectResponse.grounded`. `false` covers both "nothing recent to show either" and
   * "here's what you wrote lately instead" (`fallbackUsed` tells those two apart).
   */
  grounded: boolean;
  /**
   * Whether the server's disclosed fallback ran for this turn: it judged its Grounding didn't
   * answer the Question and showed the last few days of Entries instead, rather than an Answer
   * built on Entries that only shared a mood or a phrase with the Question — see
   * `WireReflectResponse.fallback_used` and CONTEXT.md's Grounding entry.
   */
  fallbackUsed: boolean;
  /**
   * Set only for a turn just answered in this browser session (never for one restored from a
   * fetched Session — `GET /v1/sessions/:id`'s own `SessionTurnRow` carries no per-tool detail at
   * all, only the four fields above) whose harness run read a real Digest
   * (`server/src/harness/tools/read_digest.rs`). `read_digest` deliberately populates no
   * `entry_ids` — a Digest's Grounding belongs to the Digest, not to this one tool call — which
   * otherwise leaves `groundingEntryIds` empty and `grounded` false for a Digest-only Answer,
   * indistinguishable from "nothing matched at all." This is what `grounding-disclosure.tsx`
   * reads instead, driven from the live `tool_execution_end` event's own `details`
   * (`reflect-live-run.ts`'s `applyReflectEvent`), to make "an Answer drawn from a Digest" an
   * honest, distinct thing the interface says, not silence.
   */
  digestSource?: DigestGroundingSource;
}

/**
 * The wire shape both `WireSessionTurn` (a turn loaded from a Session) and
 * `WireReflectResponse` (a turn just answered) share — everything a
 * `ConversationTurn` needs, in snake_case. `WireReflectResponse` doesn't
 * echo `question` back (the client already has it, from what it asked), so
 * a caller mapping a fresh Answer builds this object as `{ question,
 * ...response }` rather than this function reading `question` off the
 * response itself.
 */
type WireConversationTurn = Pick<
  WireSessionTurn,
  "question" | "answer" | "grounding_entry_ids" | "grounded" | "fallback_used"
>;

/**
 * Maps the wire's snake_case turn to the camelCase `ConversationTurn` the
 * components already take. This is the one place that knows both shapes —
 * `pages/reflection-page.tsx` calls it both for turns restored from a
 * fetched Session and for the turn a just-answered ask produces, so the two
 * paths can't drift into disagreeing about the mapping.
 *
 * `live` is only ever passed for the second case — a turn this browser
 * session just watched happen, event by event (`reflect-live-run.ts`). A
 * turn restored from `GET /v1/sessions/:id` carries no such thing; the wire
 * (`SessionTurnRow`) simply has nowhere to put it, so `digestSource` is
 * `undefined` for every restored turn regardless of whether a Digest
 * actually answered it. See `ConversationTurn.digestSource`'s own doc
 * comment for what that means the interface can and can't tell apart after
 * a reload.
 */
export function conversationTurnFromWire(
  wire: WireConversationTurn,
  live?: { digestSource?: DigestGroundingSource },
): ConversationTurn {
  return {
    question: wire.question,
    answer: wire.answer,
    groundingEntryIds: wire.grounding_entry_ids,
    grounded: wire.grounded,
    fallbackUsed: wire.fallback_used,
    digestSource: live?.digestSource,
  };
}

/**
 * The outcome a turn's `(grounded, fallbackUsed, digestSource)` triple
 * resolves to — named in CONTEXT.md's own vocabulary (Grounding) and ADR
 * 0024's ("real Grounding", "disclosed fallback", "nothing was found or
 * shown either way"), plus issue #96's own addition (`"digest"`).
 * `GroundingNote` (reflection-page.tsx) and `summaryLabel`
 * (grounding-disclosure.tsx) both used to branch on the raw fields
 * independently; two cascades over the same fields drift, and drifting
 * here means the caption and the expander label disagree about what
 * happened. Deriving the outcome once, here, is what keeps them agreeing
 * by construction.
 *
 * `fallbackUsed`/`grounded` still exist on the wire (`WireReflectResponse`
 * — issue #99 removes them later), but under the loop-based `/v1/reflect`
 * (issue #93 pass 2 onward) `fallback_used` is always `false` — the loop
 * has no disclosed-fallback mechanism of its own (`server/src/reflect.rs`'s
 * own doc comment on `ReflectResponse.fallback_used`) — so
 * `"disclosedFallback"` can no longer actually be produced by a freshly
 * answered turn. It stays reachable here, and is not dead code: a Session
 * turn stored before this change shipped can still carry `fallback_used:
 * true` from the pipeline that used to set it, and reloading that
 * Conversation must still render it the way ADR 0024 always described.
 */
export type GroundingOutcome =
  /** A `read_digest` tool call surfaced a real Digest this run — see `digestSource`. Checked before `grounded`/`fallbackUsed`: a Digest is not Entries, so it is never described as either. */
  | "digest"
  /** The server judged its Grounding actually answers the Question. */
  | "grounded"
  /** The server judged its Grounding didn't answer the Question and disclosed the last few days of Entries instead — see `fallbackUsed`. Only reachable for a turn stored before issue #96 — see this type's own doc comment. */
  | "disclosedFallback"
  /** Nothing matched and there was nothing recent to show either — `groundingEntryIds` is empty. */
  | "nothingFound";

/**
 * Derives a turn's outcome. `digestSource` wins outright — a Digest-sourced
 * Answer is never described as Grounding or as a fallback, whatever
 * `grounded`/`fallbackUsed` happen to carry. Otherwise `grounded: true`
 * always wins regardless of `fallbackUsed` — ADR 0024's fallback only ever
 * fired on a `GROUNDED: no` verdict, so the two were never both true in
 * practice, but `grounded` is what the summary label keys off either way
 * (see grounding-disclosure.tsx's original comment, preserved on this
 * derivation now).
 */
export function groundingOutcome(
  turn: Pick<ConversationTurn, "grounded" | "fallbackUsed" | "digestSource">,
): GroundingOutcome {
  if (turn.digestSource !== undefined) {
    return "digest";
  }
  if (turn.grounded) {
    return "grounded";
  }
  if (turn.fallbackUsed) {
    return "disclosedFallback";
  }
  return "nothingFound";
}
