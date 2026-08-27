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
        tool_called: true,
      }),
    ).toEqual({
      question: "How has my knee been?",
      answer: "It's been improving since February.",
      groundingEntryIds: ["entry-1", "entry-2"],
      grounded: true,
      fallbackUsed: false,
      toolCalled: true,
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
        tool_called: true,
      }),
    ).toEqual({
      question: "Anything about scuba diving?",
      answer: "Nothing matched, but here's what you wrote lately.",
      groundingEntryIds: ["entry-3"],
      grounded: false,
      fallbackUsed: true,
      toolCalled: true,
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
      tool_called: true,
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
      toolCalled: true,
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
        tool_called: true,
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
      tool_called: true,
    });

    expect(turn.digestSource).toBeUndefined();
  });
});

// ADR 0024's three-way outcome, derived once so GroundingNote
// (reflection-page.tsx) and summaryLabel (grounding-disclosure.tsx) can't
// drift apart on the same (grounded, fallbackUsed) pair.
describe("groundingOutcome", () => {
  it("is 'grounded' when the server judged its Grounding answers the Question", () => {
    expect(groundingOutcome({ grounded: true, fallbackUsed: false, toolCalled: true })).toBe(
      "grounded",
    );
  });

  it("is 'disclosedFallback' when the server showed recent Entries instead of an Answer", () => {
    expect(groundingOutcome({ grounded: false, fallbackUsed: true, toolCalled: true })).toBe(
      "disclosedFallback",
    );
  });

  it("is 'nothingFound' when a tool ran and genuinely found nothing", () => {
    expect(groundingOutcome({ grounded: false, fallbackUsed: false, toolCalled: true })).toBe(
      "nothingFound",
    );
  });

  // Issue #103: the case a keyword-free, structural corrective turn exists
  // for — a run that answered with no tool call at all must not be
  // reported the same way as one that looked and found nothing. Before
  // `toolCalled` existed, both reached this function with an identical
  // (grounded: false, fallbackUsed: false) pair and were indistinguishable
  // here, which is what let the live bug this ticket fixes render as an
  // ordinary "nothing matched" Answer.
  it("is 'neverLooked' when the run never called a tool at all", () => {
    expect(groundingOutcome({ grounded: false, fallbackUsed: false, toolCalled: false })).toBe(
      "neverLooked",
    );
  });

  it("prefers 'grounded' even if fallbackUsed were somehow also true", () => {
    expect(groundingOutcome({ grounded: true, fallbackUsed: true, toolCalled: true })).toBe(
      "grounded",
    );
  });

  // Issue #96: a Digest-sourced Answer leaves grounded/fallbackUsed both
  // false (read_digest populates no entry_ids — server/src/reflect.rs's
  // own doc comment) — digestSource is what tells that case apart from
  // "nothing matched at all," and it must win outright.
  it("is 'digest' whenever digestSource is set, regardless of grounded/fallbackUsed/toolCalled", () => {
    const digestSource = { period: "day", periodStart: "2026-08-20", periodEnd: "2026-08-20" };
    expect(
      groundingOutcome({ grounded: false, fallbackUsed: false, toolCalled: false, digestSource }),
    ).toBe("digest");
    expect(
      groundingOutcome({ grounded: true, fallbackUsed: false, toolCalled: true, digestSource }),
    ).toBe("digest");
  });
});

// Issue #103: `tool_called` maps onto `toolCalled` the same way every other
// wire field here does — a plain, direct copy, no derivation. Kept as its
// own test rather than folded into the mapping tests above, since those
// predate this field and stay focused on what they always tested
// (grounded/fallbackUsed/digestSource).
describe("conversationTurnFromWire maps tool_called", () => {
  it("carries tool_called: true onto toolCalled", () => {
    const turn = conversationTurnFromWire({
      question: "How is my knee doing?",
      answer: "Your knee has improved since February.",
      grounding_entry_ids: ["entry-1"],
      grounded: true,
      fallback_used: false,
      tool_called: true,
    });
    expect(turn.toolCalled).toBe(true);
  });

  it("carries tool_called: false onto toolCalled — the run that never looked", () => {
    const turn = conversationTurnFromWire({
      question: "How is my knee doing?",
      answer: "I can't access any journal entries from here.",
      grounding_entry_ids: [],
      grounded: false,
      fallback_used: false,
      tool_called: false,
    });
    expect(turn.toolCalled).toBe(false);
  });
});
