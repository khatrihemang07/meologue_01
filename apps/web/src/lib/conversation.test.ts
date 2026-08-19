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
    });

    expect(useConversationStore.getState().turns).toEqual([
      {
        question: "How has my knee been?",
        answer: "It's been improving since February.",
        groundingEntryIds: ["entry-1", "entry-2"],
        grounded: true,
      },
    ]);
  });

  it("keeps turns in the order they were added, for follow-up Questions to build on", () => {
    useConversationStore.getState().addTurn({
      question: "first question",
      answer: "first answer",
      groundingEntryIds: [],
      grounded: false,
    });
    useConversationStore.getState().addTurn({
      question: "second question",
      answer: "second answer",
      groundingEntryIds: [],
      grounded: false,
    });

    const { turns } = useConversationStore.getState();
    expect(turns.map((turn) => turn.question)).toEqual(["first question", "second question"]);
  });
});
