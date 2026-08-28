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
    // Issue #103: every fixture in this file is about a tool that *did*
    // run (grounded or found-nothing) — none of this component's own
    // behaviour differs for `neverLooked` vs `nothingFound` (both hit the
    // same `groundingEntryIds.length === 0` early return, see
    // grounding-disclosure.tsx's own doc comment), so a fixed `true` here
    // keeps every existing case exactly what it always tested.
    toolCalled: true,
    // Issue #98: `ConversationTurn.model` is always present on the wire
    // (`SessionTurnRow.model`/`ReflectResponse.model` are both required
    // fields) — a fixed placeholder here, since nothing in this file's own
    // behaviour depends on which model produced a turn.
    model: "codex-terra",
    ...overrides,
  };
}

// GroundingDisclosure is pure (the page/component layering fix): it takes
// the turn and this Device's Entries as props rather than reading the Entry
// store itself, so rendering it needs no router or store stand-in — a plain
// render suffices.
function renderDisclosure(
  props: { groundingEntryIds: string[] },
  entries: Entry[] = [],
  syncEnabled = false,
  loading = false,
) {
  return render(
    <GroundingDisclosure
      turn={turn(props)}
      entries={entries}
      loading={loading}
      syncEnabled={syncEnabled}
    />,
  );
}

describe("GroundingDisclosure", () => {
  it("renders nothing when there are no grounding Entry ids", () => {
    const { container } = renderDisclosure({ groundingEntryIds: [] });

    expect(container).toBeEmptyDOMElement();
  });

  it("labels a single grounded Entry with singular wording", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"] }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    expect(screen.getByText("1 Entry read")).toBeInTheDocument();
  });

  it("labels multiple grounded Entries with plural wording", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1", "entry-2"] }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
      entry({ id: "entry-2", body: "Physio went well" }),
    ]);

    expect(screen.getByText("2 Entries read")).toBeInTheDocument();
  });

  it("is collapsed by default and expands to show Entry bodies", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"] }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    const details = screen.getByText("1 Entry read").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText("Knee felt better")).not.toBeVisible();

    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above.
    details!.setAttribute("open", "");
    expect(screen.getByText("Knee felt better")).toBeInTheDocument();
  });

  it("renders Entries in the server's order, not re-sorted", () => {
    renderDisclosure({ groundingEntryIds: ["entry-2", "entry-1"] }, [
      entry({ id: "entry-1", body: "First written" }),
      entry({ id: "entry-2", body: "Second written" }),
    ]);

    const bodies = screen.getAllByText(/written$/).map((element) => element.textContent);
    expect(bodies).toEqual(["Second written", "First written"]);
  });

  it("discloses an id with no local Entry as a placeholder, not by dropping it", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1", "entry-missing"] }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    expect(screen.getByText("Knee felt better")).toBeInTheDocument();
    expect(screen.getByText(/hasn't reached this device yet/i)).toBeInTheDocument();
  });

  // Issue #79 regression fix: the page's by-id lookup is now async
  // (EntryStoreOutletContext.getEntries), so there's a real moment where an
  // id genuinely local to this Device just hasn't resolved yet. Showing
  // "hasn't reached this Device yet" in that window would be exactly the
  // false claim CONTEXT.md's Grounding entry forbids, so `loading: true`
  // must render a neutral placeholder instead.
  it("shows a neutral placeholder, not the false 'hasn't reached' claim, while the lookup is still in flight", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"] }, [], false, true);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/hasn't reached this device yet/i)).not.toBeInTheDocument();
  });

  // ADR 0028: Grounding is a read-only view of what an Answer was based
  // on, so it must never offer to edit or delete an Entry — GroundingDisclosure
  // never passes EntryRow an `actions` prop, so EntryRow's own default
  // ("no actions" -> "no menu") is what enforces this here.
  it("never offers an Edit/Delete menu on a Grounding row, even on long-press/right-click", async () => {
    renderDisclosure({ groundingEntryIds: ["entry-1"] }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    const details = screen.getByText("1 Entry read").closest("details");
    expect(details).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above.
    details!.setAttribute("open", "");

    fireEvent.contextMenu(screen.getByText("Knee felt better"));

    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("counts the server's ids in the summary, not just the Entries found locally", () => {
    renderDisclosure({ groundingEntryIds: ["entry-1", "entry-missing-a", "entry-missing-b"] }, [
      entry({ id: "entry-1", body: "Knee felt better" }),
    ]);

    expect(screen.getByText("3 Entries read")).toBeInTheDocument();
  });

  // Issue #96: a Digest-sourced Answer is driven from `turn.digestSource`
  // (live, from the `tool_execution_end` event's own `details` while
  // answering — or, since issue #99, straight off the wire after a reload
  // — `apps/web/src/lib/conversation.ts`'s own doc comment), not from
  // `groundingEntryIds` — `read_digest` deliberately populates none. Before
  // digestSource existed the component returned null here, so the user saw
  // no disclosure at all for a Digest-only Answer.
  it("says the Answer came from a Digest, distinctly from Entries, when digestSource is set", () => {
    render(
      <GroundingDisclosure
        turn={turn({
          groundingEntryIds: [],
          digestSource: { period: "week", periodStart: "2026-08-17", periodEnd: "2026-08-23" },
        })}
        entries={[]}
        loading={false}
        syncEnabled={false}
      />,
    );

    expect(
      screen.getByText("Answered from the week Digest for 2026-08-17 to 2026-08-23."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Grounded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/recent Entr/)).not.toBeInTheDocument();
  });

  it("collapses a single-day Digest's range to one date rather than 'X to X'", () => {
    render(
      <GroundingDisclosure
        turn={turn({
          groundingEntryIds: [],
          digestSource: { period: "day", periodStart: "2026-08-20", periodEnd: "2026-08-20" },
        })}
        entries={[]}
        loading={false}
        syncEnabled={false}
      />,
    );

    expect(screen.getByText("Answered from the day Digest for 2026-08-20.")).toBeInTheDocument();
  });

  it("renders no expandable Entries list for a Digest-sourced turn — a Digest is prose, not a set of rows", () => {
    const { container } = render(
      <GroundingDisclosure
        turn={turn({
          groundingEntryIds: [],
          digestSource: { period: "day", periodStart: "2026-08-20", periodEnd: "2026-08-20" },
        })}
        entries={[]}
        loading={false}
        syncEnabled={false}
      />,
    );

    expect(container.querySelector("details")).toBeNull();
  });
});
