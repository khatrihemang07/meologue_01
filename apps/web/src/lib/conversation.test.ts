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
        tool_called: true,
        model: "codex-terra",
      }),
    ).toEqual({
      question: "How has my knee been?",
      answer: "It's been improving since February.",
      groundingEntryIds: ["entry-1", "entry-2"],
      toolCalled: true,
      digestSource: undefined,
      model: "codex-terra",
    });
  });

  it("ignores extra fields on the wire object, e.g. a WireReflectResponse's session_id and title", () => {
    // reflection-page.tsx builds this call as `{ question, ...response }` —
    // `response` (WireReflectResponse) carries session_id and title too,
    // which this mapper must simply not copy onto a ConversationTurn.
    const response = {
      answer: "You wrote about the move.",
      grounding_entry_ids: [] as string[],
      tool_called: true,
      model: "codex-terra",
      session_id: "11111111-1111-1111-1111-111111111111",
      title: "What did I write yesterday?",
    };

    expect(
      conversationTurnFromWire({ question: "What did I write yesterday?", ...response }),
    ).toEqual({
      question: "What did I write yesterday?",
      answer: "You wrote about the move.",
      groundingEntryIds: [],
      toolCalled: true,
      digestSource: undefined,
      model: "codex-terra",
    });
  });

  // Issue #96: the live event stream (`reflect-live-run.ts`) can learn a
  // just-answered turn drew on a real Digest before the tree write behind
  // it has committed — `WireReflectResponse` carries no `digest_source`
  // field of its own (only `WireSessionTurn` does, since issue #99).
  // `conversationTurnFromWire`'s optional second argument is how the live
  // value still reaches the mapped `ConversationTurn` in that case.
  it("carries a live digestSource onto the mapped turn when the wire itself has none", () => {
    const turn = conversationTurnFromWire(
      {
        question: "How was last week?",
        answer: "A quiet week, mostly focused on the move.",
        grounding_entry_ids: [],
        tool_called: true,
        model: "codex-terra",
      },
      { digestSource: { period: "week", periodStart: "2026-08-17", periodEnd: "2026-08-23" } },
    );

    expect(turn.digestSource).toEqual({
      period: "week",
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23",
    });
  });

  // Issue #99's carry-over from #96 pass 2: `GET /v1/sessions/:id` now
  // derives `digest_source` from the tree (`SessionTurnRow::digest_source`,
  // server/src/sessions.rs), so a turn restored after a page reload still
  // reports where its Answer came from — no `live` argument needed at all.
  it("carries digestSource straight off the wire for a turn restored from a fetched Session", () => {
    const turn = conversationTurnFromWire({
      question: "How was last week?",
      answer: "A quiet week, mostly focused on the move.",
      grounding_entry_ids: [],
      tool_called: true,
      model: "codex-terra",
      digest_source: { period: "week", period_start: "2026-08-17", period_end: "2026-08-23" },
    });

    expect(turn.digestSource).toEqual({
      period: "week",
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23",
    });
  });

  it("leaves digestSource undefined when neither the wire nor a live argument has one", () => {
    const turn = conversationTurnFromWire({
      question: "How was last week?",
      answer: "A quiet week, mostly focused on the move.",
      grounding_entry_ids: [],
      tool_called: true,
      model: "codex-terra",
    });

    expect(turn.digestSource).toBeUndefined();
  });

  it("prefers the wire's own digestSource over a live one when, implausibly, both are present", () => {
    const turn = conversationTurnFromWire(
      {
        question: "How was last week?",
        answer: "A quiet week, mostly focused on the move.",
        grounding_entry_ids: [],
        tool_called: true,
        model: "codex-terra",
        digest_source: { period: "week", period_start: "2026-08-17", period_end: "2026-08-23" },
      },
      { digestSource: { period: "day", periodStart: "2026-08-23", periodEnd: "2026-08-23" } },
    );

    expect(turn.digestSource).toEqual({
      period: "week",
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23",
    });
  });
});

// Issue #99 removed `grounded`/`fallback_used` from the wire entirely — the
// fixed pipeline's own verdict, meaningless once the loop replaced it (see
// `server/src/reflect.rs`'s own module doc comment) — so `groundingOutcome`
// derives its answer purely from `groundingEntryIds`/`toolCalled`/
// `digestSource` now. Derived once, still, so `GroundingNote`
// (reflection-page.tsx) and `summaryLabel` (grounding-disclosure.tsx) can't
// drift apart on what happened.
describe("groundingOutcome", () => {
  it("is 'grounded' when the tools returned at least one Entry", () => {
    expect(groundingOutcome({ groundingEntryIds: ["entry-1"], toolCalled: true })).toBe("grounded");
  });

  it("is 'nothingFound' when a tool ran and genuinely found nothing", () => {
    expect(groundingOutcome({ groundingEntryIds: [], toolCalled: true })).toBe("nothingFound");
  });

  // Issue #103: the case a keyword-free, structural corrective turn exists
  // for — a run that answered with no tool call at all must not be
  // reported the same way as one that looked and found nothing. Before
  // `toolCalled` existed, both reached this function with an identical
  // empty `groundingEntryIds` and were indistinguishable here, which is
  // what let the live bug this ticket fixes render as an ordinary "nothing
  // matched" Answer.
  it("is 'neverLooked' when the run never called a tool at all", () => {
    expect(groundingOutcome({ groundingEntryIds: [], toolCalled: false })).toBe("neverLooked");
  });

  // Issue #96: a Digest-sourced Answer usually leaves `groundingEntryIds`
  // empty (`read_digest` populates no `entry_ids` — server/src/harness/tools/read_digest.rs's
  // own doc comment) — `digestSource` is what tells that case apart from
  // "nothing matched at all," and it must win outright regardless of what
  // `groundingEntryIds`/`toolCalled` happen to carry (a Digest-answered
  // Turn's run can still have called another tool first).
  it("is 'digest' whenever digestSource is set, regardless of groundingEntryIds/toolCalled", () => {
    const digestSource = { period: "day", periodStart: "2026-08-20", periodEnd: "2026-08-20" };
    expect(groundingOutcome({ groundingEntryIds: [], toolCalled: false, digestSource })).toBe(
      "digest",
    );
    expect(
      groundingOutcome({ groundingEntryIds: ["entry-1"], toolCalled: true, digestSource }),
    ).toBe("digest");
  });
});

// Issue #103: `tool_called` maps onto `toolCalled` the same way every other
// wire field here does — a plain, direct copy, no derivation. Kept as its
// own test rather than folded into the mapping tests above, since those
// predate this field and stay focused on what they always tested
// (groundingEntryIds/digestSource).
describe("conversationTurnFromWire maps tool_called", () => {
  it("carries tool_called: true onto toolCalled", () => {
    const turn = conversationTurnFromWire({
      question: "How is my knee doing?",
      answer: "Your knee has improved since February.",
      grounding_entry_ids: ["entry-1"],
      tool_called: true,
      model: "codex-terra",
    });
    expect(turn.toolCalled).toBe(true);
  });

  it("carries tool_called: false onto toolCalled — the run that never looked", () => {
    const turn = conversationTurnFromWire({
      question: "How is my knee doing?",
      answer: "I can't access any journal entries from here.",
      grounding_entry_ids: [],
      tool_called: false,
      model: "codex-terra",
    });
    expect(turn.toolCalled).toBe(false);
  });
});

// Issue #98: `model` maps onto `ConversationTurn.model` the same plain,
// direct copy every other wire field here does.
describe("conversationTurnFromWire maps model", () => {
  it("carries the model that actually produced this turn's Answer", () => {
    const turn = conversationTurnFromWire({
      question: "How is my knee doing?",
      answer: "Your knee has improved since February.",
      grounding_entry_ids: [],
      tool_called: false,
      model: "claude-sonnet",
    });
    expect(turn.model).toBe("claude-sonnet");
  });
});
