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
  /** The Entry ids Reflection's retrieval used to ground this Answer, in the order the server returned them. */
  groundingEntryIds: string[];
  /** Whether the server found any Grounding at all for this turn — see `WireReflectResponse.grounded`. */
  grounded: boolean;
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
