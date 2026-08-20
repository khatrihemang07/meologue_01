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
 */
export function conversationTurnFromWire(wire: WireConversationTurn): ConversationTurn {
  return {
    question: wire.question,
    answer: wire.answer,
    groundingEntryIds: wire.grounding_entry_ids,
    grounded: wire.grounded,
    fallbackUsed: wire.fallback_used,
  };
}

/**
 * The three-way outcome a turn's `(grounded, fallbackUsed)` pair always
 * resolves to — named in CONTEXT.md's own vocabulary (Grounding) and ADR
 * 0024's ("real Grounding", "disclosed fallback", "nothing was found or
 * shown either way"). `GroundingNote` (reflection-page.tsx) and
 * `summaryLabel` (grounding-disclosure.tsx) both used to branch on the raw
 * pair independently; two cascades over the same two booleans drift, and
 * drifting here means the caption and the expander label disagree about
 * what happened. Deriving the outcome once, here, is what keeps them
 * agreeing by construction.
 */
export type GroundingOutcome =
  /** The server judged its Grounding actually answers the Question. */
  | "grounded"
  /** The server judged its Grounding didn't answer the Question and disclosed the last few days of Entries instead — see `fallbackUsed`. */
  | "disclosedFallback"
  /** Nothing matched and there was nothing recent to show either — `groundingEntryIds` is empty. */
  | "nothingFound";

/**
 * Derives a turn's outcome from `grounded` and `fallbackUsed`. `grounded:
 * true` always wins regardless of `fallbackUsed` — ADR 0024's fallback only
 * ever fires on a `GROUNDED: no` verdict, so the two are never both true in
 * practice, but `grounded` is what the summary label keys off either way
 * (see grounding-disclosure.tsx's original comment, preserved on this
 * derivation now).
 */
export function groundingOutcome(
  turn: Pick<ConversationTurn, "grounded" | "fallbackUsed">,
): GroundingOutcome {
  if (turn.grounded) {
    return "grounded";
  }
  if (turn.fallbackUsed) {
    return "disclosedFallback";
  }
  return "nothingFound";
}
