/**
 * The running Conversation on this Device — CONTEXT.md's own definition:
 * "The running sequence of Questions and Answers on one Device... A
 * Conversation belongs to the Device it happened on and does not Sync."
 *
 * Copies the *shape* of `lib/settings.ts` (a Zustand store every reader
 * subscribes to, one writer owning every mutation) but deliberately does
 * NOT persist to `localStorage` — ADR 0020 already decided a Conversation
 * lives only in memory, with no local table and no reload survival, as the
 * cheapest thing that could be true until a later ticket needs otherwise.
 * "In memory" is exactly what a module-scoped Zustand store already is: it
 * survives navigating Reflect → History → Reflect (the store isn't torn
 * down when `ReflectionPage` unmounts), and is lost on a reload (the whole
 * JS process, store included, is gone) — no extra code needed to get either
 * half of that right.
 */
import { create } from "zustand";

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

interface ConversationState {
  turns: ConversationTurn[];
  /**
   * Appends a completed turn. There is deliberately no way to add a
   * half-finished one (a Question with no Answer yet) — the in-flight state
   * while waiting on the server is the Reflection page's own concern (a
   * staged indicator), not part of the Conversation itself, which CONTEXT.md
   * defines as a sequence of Questions *and Answers*, not bare Questions.
   */
  addTurn: (turn: ConversationTurn) => void;
}

export const useConversationStore = create<ConversationState>()((set) => ({
  turns: [],
  addTurn: (turn) => set((state) => ({ turns: [...state.turns, turn] })),
}));
