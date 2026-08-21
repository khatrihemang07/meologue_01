import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "@/lib/conversation";
import { GroundingDisclosure } from "./grounding-disclosure";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

function turn(overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    question: "How has my knee been?",
    answer: "It's improved since February.",
    groundingEntryIds: [],
    grounded: true,
    fallbackUsed: false,
    ...overrides,
  };
}

// GroundingDisclosure is pure (the page/component layering fix): it takes
// the turn and this Device's Entries as props rather than reading the Entry
// store itself, so rendering it needs no router or store stand-in — a plain
// render suffices.
function renderDisclosure(
  props: { groundingEntryIds: string[]; grounded: boolean; fallbackUsed: boolean },
  entries: Entry[] = [],
  syncEnabled = false,
) {
  return render(
    <GroundingDisclosure turn={turn(props)} entries={entries} syncEnabled={syncEnabled} />,
  );
}

describe("GroundingDisclosure", () => {
  it("renders nothing when there are no grounding Entry ids", () => {
    const { container } = renderDisclosure({
      groundingEntryIds: [],
      grounded: true,
      fallbackUsed: false,
    });

    expect(container).toBeEmptyDOMElement();
  });

  it("labels a single grounded Entry with singular wording", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"], grounded: true, fallbackUsed: false }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    expect(screen.getByText("Grounded in 1 Entry")).toBeInTheDocument();
  });

  it("labels multiple grounded Entries with plural wording", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-1", "entry-2"],
        grounded: true,
        fallbackUsed: false,
      },
      [
        entry({ id: "entry-1", body: "Knee felt better" }),
        entry({ id: "entry-2", body: "Physio went well" }),
      ],
    );

    expect(screen.getByText("Grounded in 2 Entries")).toBeInTheDocument();
  });

  it("labels a fallback turn as recent Entries, never as Grounding — ADR 0024", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"], grounded: false, fallbackUsed: true }, [
      entry({ id: "entry-1", body: "Just a Tuesday" }),
    ]);

    expect(screen.getByText("1 recent Entry")).toBeInTheDocument();
    expect(screen.queryByText(/^Grounded/)).not.toBeInTheDocument();
  });

  it("pluralizes the fallback label for multiple recent Entries", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-1", "entry-2"],
        grounded: false,
        fallbackUsed: true,
      },
      [
        entry({ id: "entry-1", body: "Just a Tuesday" }),
        entry({ id: "entry-2", body: "Just a Wednesday" }),
      ],
    );

    expect(screen.getByText("2 recent Entries")).toBeInTheDocument();
  });

  it("is collapsed by default and expands to show Entry bodies", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"], grounded: true, fallbackUsed: false }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    const details = screen.getByText("Grounded in 1 Entry").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText("Knee felt better")).not.toBeVisible();

    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above.
    details!.setAttribute("open", "");
    expect(screen.getByText("Knee felt better")).toBeInTheDocument();
  });

  it("renders Entries in the server's order, not re-sorted", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-2", "entry-1"],
        grounded: true,
        fallbackUsed: false,
      },
      [
        entry({ id: "entry-1", body: "First written" }),
        entry({ id: "entry-2", body: "Second written" }),
      ],
    );

    const bodies = screen.getAllByText(/written$/).map((element) => element.textContent);
    expect(bodies).toEqual(["Second written", "First written"]);
  });

  it("discloses an id with no local Entry as a placeholder, not by dropping it", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-1", "entry-missing"],
        grounded: true,
        fallbackUsed: false,
      },
      [entry({ id: "entry-1", body: "Knee felt better" })],
    );

    expect(screen.getByText("Knee felt better")).toBeInTheDocument();
    expect(screen.getByText(/hasn't reached this device yet/i)).toBeInTheDocument();
  });

  // ADR 0028: Grounding is a read-only view of what an Answer was based
  // on, so it must never offer to edit or delete an Entry — GroundingDisclosure
  // never passes EntryRow an `actions` prop, so EntryRow's own default
  // ("no actions" -> "no menu") is what enforces this here.
  it("never offers an Edit/Delete menu on a Grounding row, even on long-press/right-click", async () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"], grounded: true, fallbackUsed: false }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    const details = screen.getByText("Grounded in 1 Entry").closest("details");
    expect(details).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above.
    details!.setAttribute("open", "");

    fireEvent.contextMenu(screen.getByText("Knee felt better"));

    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("counts the server's ids in the summary, not just the Entries found locally", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-1", "entry-missing-a", "entry-missing-b"],
        grounded: true,
        fallbackUsed: false,
      },
      [entry({ id: "entry-1", body: "Knee felt better" })],
    );

    expect(screen.getByText("Grounded in 3 Entries")).toBeInTheDocument();
  });
});
