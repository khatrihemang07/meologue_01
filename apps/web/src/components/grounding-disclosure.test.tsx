import type { Entry } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { GroundingDisclosure } from "./grounding-disclosure";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    ...overrides,
  };
}

const defaultContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  search: vi.fn(async () => []),
  disabled: false,
};

// GroundingDisclosure reads the Device's own Entry store via
// useEntryStore() (useOutletContext) — this stand-in supplies that context
// the way EntryStoreLayout would, mirroring composer-page.test.tsx and
// history-page.test.tsx.
function renderDisclosure(
  props: {
    groundingEntryIds: string[];
    grounded: boolean;
    fallbackUsed: boolean;
    syncEnabled?: boolean;
  },
  context: EntryStoreOutletContext = defaultContext,
) {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route
            path="/"
            element={
              <GroundingDisclosure
                groundingEntryIds={props.groundingEntryIds}
                grounded={props.grounded}
                fallbackUsed={props.fallbackUsed}
                syncEnabled={props.syncEnabled ?? false}
              />
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
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
    renderDisclosure(
      { groundingEntryIds: ["entry-1"], grounded: true, fallbackUsed: false },
      { ...defaultContext, entries: [entry({ id: "entry-1", body: "Knee felt better" })] },
    );

    expect(screen.getByText("Grounded in 1 Entry")).toBeInTheDocument();
  });

  it("labels multiple grounded Entries with plural wording", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-1", "entry-2"],
        grounded: true,
        fallbackUsed: false,
      },
      {
        ...defaultContext,
        entries: [
          entry({ id: "entry-1", body: "Knee felt better" }),
          entry({ id: "entry-2", body: "Physio went well" }),
        ],
      },
    );

    expect(screen.getByText("Grounded in 2 Entries")).toBeInTheDocument();
  });

  it("labels a fallback turn as recent Entries, never as Grounding — ADR 0024", () => {
    renderDisclosure(
      { groundingEntryIds: ["entry-1"], grounded: false, fallbackUsed: true },
      { ...defaultContext, entries: [entry({ id: "entry-1", body: "Just a Tuesday" })] },
    );

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
      {
        ...defaultContext,
        entries: [
          entry({ id: "entry-1", body: "Just a Tuesday" }),
          entry({ id: "entry-2", body: "Just a Wednesday" }),
        ],
      },
    );

    expect(screen.getByText("2 recent Entries")).toBeInTheDocument();
  });

  it("is collapsed by default and expands to show Entry bodies", () => {
    renderDisclosure(
      { groundingEntryIds: ["entry-1"], grounded: true, fallbackUsed: false },
      { ...defaultContext, entries: [entry({ id: "entry-1", body: "Knee felt better" })] },
    );

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
      {
        ...defaultContext,
        entries: [
          entry({ id: "entry-1", body: "First written" }),
          entry({ id: "entry-2", body: "Second written" }),
        ],
      },
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
      { ...defaultContext, entries: [entry({ id: "entry-1", body: "Knee felt better" })] },
    );

    expect(screen.getByText("Knee felt better")).toBeInTheDocument();
    expect(screen.getByText(/hasn't reached this device yet/i)).toBeInTheDocument();
  });

  it("counts the server's ids in the summary, not just the Entries found locally", () => {
    renderDisclosure(
      {
        groundingEntryIds: ["entry-1", "entry-missing-a", "entry-missing-b"],
        grounded: true,
        fallbackUsed: false,
      },
      { ...defaultContext, entries: [entry({ id: "entry-1", body: "Knee felt better" })] },
    );

    expect(screen.getByText("Grounded in 3 Entries")).toBeInTheDocument();
  });
});
