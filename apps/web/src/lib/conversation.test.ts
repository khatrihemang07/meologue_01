import { describe, expect, it } from "vitest";
import { conversationTurnFromWire, groundingOutcome } from "./conversation";

// ADR 0025 deleted `useConversationStore` — the Conversation now comes from
// the Server, not an in-memory Zustand store — so these tests, which used
// to exercise `addTurn`/`getState().turns`, are rewritten to exercise what
// replaced it: the wire-to-camelCase mapper both `reflection-page.tsx`'s
// restore path (a fetched `WireSessionTurn`) and its just-answered path (a
// `WireReflectResponse` plus the Question that produced it) now share.
describe("conversationTurnFromWire", () => {
  it("maps a wire turn's snake_case fields to a camelCase ConversationTurn", () => {
    expect(
      conversationTurnFromWire({
        question: "How has my knee been?",
        answer: "It's been improving since February.",
        grounding_entry_ids: ["entry-1", "entry-2"],
        grounded: true,
        fallback_used: false,
      }),
    ).toEqual({
      question: "How has my knee been?",
      answer: "It's been improving since February.",
      groundingEntryIds: ["entry-1", "entry-2"],
      grounded: true,
      fallbackUsed: false,
    });
  });

  it("carries fallbackUsed for a turn where the server showed recent Entries instead of an Answer", () => {
    expect(
      conversationTurnFromWire({
        question: "Anything about scuba diving?",
        answer: "Nothing matched, but here's what you wrote lately.",
        grounding_entry_ids: ["entry-3"],
        grounded: false,
        fallback_used: true,
      }),
    ).toEqual({
      question: "Anything about scuba diving?",
      answer: "Nothing matched, but here's what you wrote lately.",
      groundingEntryIds: ["entry-3"],
      grounded: false,
      fallbackUsed: true,
    });
  });

  it("ignores extra fields on the wire object, e.g. a WireReflectResponse's session_id and title", () => {
    // reflection-page.tsx builds this call as `{ question, ...response }` —
    // `response` (WireReflectResponse) carries session_id and title too,
    // which this mapper must simply not copy onto a ConversationTurn.
    const response = {
      answer: "You wrote about the move.",
      grounding_entry_ids: [] as string[],
      grounded: true,
      fallback_used: false,
      session_id: "11111111-1111-1111-1111-111111111111",
      title: "What did I write yesterday?",
    };

    expect(
      conversationTurnFromWire({ question: "What did I write yesterday?", ...response }),
    ).toEqual({
      question: "What did I write yesterday?",
      answer: "You wrote about the move.",
      groundingEntryIds: [],
      grounded: true,
      fallbackUsed: false,
    });
  });

  // Issue #96: the live event stream (`reflect-live-run.ts`) can learn a
  // just-answered turn drew on a real Digest — something the wire's own
  // `WireReflectResponse`/`WireSessionTurn` shape has no field for at all.
  // `conversationTurnFromWire`'s optional second argument is how that
  // carries onto the `ConversationTurn` the components render, without the
  // wire mapping itself needing to know anything about it.
  it("carries a live digestSource onto the mapped turn when one is passed", () => {
    const turn = conversationTurnFromWire(
      {
        question: "How was last week?",
        answer: "A quiet week, mostly focused on the move.",
        grounding_entry_ids: [],
        grounded: false,
        fallback_used: false,
      },
      { digestSource: { period: "week", periodStart: "2026-08-17", periodEnd: "2026-08-23" } },
    );

    expect(turn.digestSource).toEqual({
      period: "week",
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23",
    });
  });

  it("leaves digestSource undefined for a turn restored from a fetched Session, with no live argument", () => {
    const turn = conversationTurnFromWire({
      question: "How was last week?",
      answer: "A quiet week, mostly focused on the move.",
      grounding_entry_ids: [],
      grounded: false,
      fallback_used: false,
    });

    expect(turn.digestSource).toBeUndefined();
  });
});

// ADR 0024's three-way outcome, derived once so GroundingNote
// (reflection-page.tsx) and summaryLabel (grounding-disclosure.tsx) can't
// drift apart on the same (grounded, fallbackUsed) pair.
describe("groundingOutcome", () => {
  it("is 'grounded' when the server judged its Grounding answers the Question", () => {
    expect(groundingOutcome({ grounded: true, fallbackUsed: false })).toBe("grounded");
  });

  it("is 'disclosedFallback' when the server showed recent Entries instead of an Answer", () => {
    expect(groundingOutcome({ grounded: false, fallbackUsed: true })).toBe("disclosedFallback");
  });

  it("is 'nothingFound' when nothing matched and nothing recent existed either", () => {
    expect(groundingOutcome({ grounded: false, fallbackUsed: false })).toBe("nothingFound");
  });

  it("prefers 'grounded' even if fallbackUsed were somehow also true", () => {
    expect(groundingOutcome({ grounded: true, fallbackUsed: true })).toBe("grounded");
  });

  // Issue #96: a Digest-sourced Answer leaves grounded/fallbackUsed both
  // false (read_digest populates no entry_ids — server/src/reflect.rs's
  // own doc comment) — digestSource is what tells that case apart from
  // "nothing matched at all," and it must win outright.
  it("is 'digest' whenever digestSource is set, regardless of grounded/fallbackUsed", () => {
    const digestSource = { period: "day", periodStart: "2026-08-20", periodEnd: "2026-08-20" };
    expect(groundingOutcome({ grounded: false, fallbackUsed: false, digestSource })).toBe("digest");
    expect(groundingOutcome({ grounded: true, fallbackUsed: false, digestSource })).toBe("digest");
  });
});
