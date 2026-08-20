import { afterEach, describe, expect, it } from "vitest";
import { useConversationStore } from "./conversation";

describe("useConversationStore", () => {
  afterEach(() => {
    useConversationStore.setState({ turns: [] });
  });

  it("starts with an empty Conversation", () => {
    expect(useConversationStore.getState().turns).toEqual([]);
  });

  it("appends a completed turn via addTurn", () => {
    useConversationStore.getState().addTurn({
      question: "How has my knee been?",
      answer: "It's been improving since February.",
      groundingEntryIds: ["entry-1", "entry-2"],
      grounded: true,
      fallbackUsed: false,
    });

    expect(useConversationStore.getState().turns).toEqual([
      {
        question: "How has my knee been?",
        answer: "It's been improving since February.",
        groundingEntryIds: ["entry-1", "entry-2"],
        grounded: true,
        fallbackUsed: false,
      },
    ]);
  });

  it("carries fallbackUsed for a turn where the server showed recent Entries instead of an Answer", () => {
    useConversationStore.getState().addTurn({
      question: "Anything about scuba diving?",
      answer: "Nothing matched, but here's what you wrote lately.",
      groundingEntryIds: ["entry-3"],
      grounded: false,
      fallbackUsed: true,
    });

    expect(useConversationStore.getState().turns).toEqual([
      {
        question: "Anything about scuba diving?",
        answer: "Nothing matched, but here's what you wrote lately.",
        groundingEntryIds: ["entry-3"],
        grounded: false,
        fallbackUsed: true,
      },
    ]);
  });

  it("keeps turns in the order they were added, for follow-up Questions to build on", () => {
    useConversationStore.getState().addTurn({
      question: "first question",
      answer: "first answer",
      groundingEntryIds: [],
      grounded: false,
      fallbackUsed: false,
    });
    useConversationStore.getState().addTurn({
      question: "second question",
      answer: "second answer",
      groundingEntryIds: [],
      grounded: false,
      fallbackUsed: false,
    });

    const { turns } = useConversationStore.getState();
    expect(turns.map((turn) => turn.question)).toEqual(["first question", "second question"]);
  });
});
