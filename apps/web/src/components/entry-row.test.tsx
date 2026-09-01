import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as entryDayModule from "@/lib/entry-day";
import { entryReferenceQueryKey } from "@/lib/query-keys";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { EntryRow } from "./entry-row";

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

/**
 * Stands in for `matchMedia("(hover: hover)")`, the same idea as
 * `theme.test.ts`'s own `stubMatchMedia` for `(prefers-color-scheme:
 * dark)` — `hoverCapable()` (entry-actions.tsx) only ever reads `.matches`
 * once per call, so this stub needs no `addEventListener` of its own.
 */
function stubHoverCapable(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches, media: query })),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * A date Reference's own renderer (entry-row.tsx's `DateReferenceLink`)
 * reads `dayHasEntries` off `useEntryStore()` and resolves it through
 * TanStack Query — this stands EntryRow up inside the same outlet-context
 * plus router plus query-client wiring composer-page.test.tsx uses for the
 * page above it, scoped down to a bare `<EntryRow>`.
 */
function renderEntryRow(
  target: Entry,
  overrides: Partial<EntryStoreOutletContext> = {},
  query = "",
  queryClient = new QueryClient(),
) {
  const context: EntryStoreOutletContext = {
    entries: [],
    pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
    sendEntry: vi.fn(),
    search: vi.fn(async () => []),
    getEntries: vi.fn(async () => []),
    editEntry: vi.fn(),
    removeEntry: vi.fn(),
    tasks: [],
    completedTasks: [],
    addTask: vi.fn(),
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    renameTask: vi.fn(),
    reorderTask: vi.fn(),
    removeTask: vi.fn(),
    setTaskDate: vi.fn(),
    setTaskDeadline: vi.fn(),
    setTaskDuration: vi.fn(),
    setTaskPriority: vi.fn(),
    disabled: false,
    ...overrides,
  };
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Routes>
            <Route element={<Outlet context={context} />}>
              <Route
                path="/"
                element={<EntryRow entry={target} syncEnabled={false} query={query} />}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("EntryRow", () => {
  it("renders an Entry's body plain when no query is given", () => {
    render(<EntryRow entry={entry({ body: "a recurring task" })} syncEnabled={false} />);

    expect(screen.queryByRole("mark")).not.toBeInTheDocument();
    expect(screen.getByText("a recurring task")).toBeInTheDocument();
  });

  // Issue #153: Grounding renders through EntryRow/EntryBody, and CONTEXT.md
  // requires it to stay a read-only view of what an Answer was based on — a
  // tickable checkbox there would let editing a past Answer relied on look
  // possible. entry-row.tsx's own EntryBody never passes onToggleTask to
  // entryBodyContent, which is what keeps this true; this is the
  // regression test for that decision.
  it("renders a task checkbox disabled — Grounding stays read-only", () => {
    render(<EntryRow entry={entry({ body: "- [ ] call mum" })} syncEnabled={false} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("highlights the query's match inside an Entry's body", () => {
    render(
      <EntryRow entry={entry({ body: "a recurring task" })} query="recur" syncEnabled={false} />,
    );

    const mark = screen.getByText("recurring", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(mark.parentElement).toHaveTextContent("a recurring task");
  });

  it("shows an Entry's capture time as a clock time, not a date", () => {
    render(
      <EntryRow entry={entry({ createdAt: "2026-08-15T17:27:00.000Z" })} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time.tagName).toBe("TIME");
    expect(time).not.toHaveTextContent(/2026/);
  });

  // Issue #81, fix 3: the absolute timestamp behind this attribute is
  // computed lazily, on hover, rather than for every row on every render —
  // almost no row's tooltip is ever actually shown. No `title` at all
  // before the hover is the observable half of "lazy"; the value appearing
  // after it is the observable half of "still discoverable."
  it("puts a more precise absolute timestamp on hover, computed lazily rather than up front", () => {
    render(
      <EntryRow entry={entry({ createdAt: "2026-08-15T17:27:00.000Z" })} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time).not.toHaveAttribute("title");

    fireEvent.mouseEnter(time);

    expect(time).toHaveAttribute("title", expect.stringMatching(/2026.*:\d{2}:\d{2}\s?(AM|PM)$/i));
  });

  it("renders no time when an Entry's createdAt doesn't parse as a date", () => {
    const { container } = render(
      <EntryRow entry={entry({ createdAt: "now", body: "undated" })} syncEnabled={false} />,
    );

    expect(container.querySelector("time")).not.toBeInTheDocument();
    expect(screen.getByText("undated")).toBeInTheDocument();
  });

  it("marks an unsynced Entry when Sync is on", () => {
    render(<EntryRow entry={entry({ seq: null })} syncEnabled />);

    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();
  });

  it("does not mark a synced Entry when Sync is on", () => {
    render(<EntryRow entry={entry({ seq: 3 })} syncEnabled />);

    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  it("marks nothing when Sync is off, even for an unsynced Entry", () => {
    render(<EntryRow entry={entry({ seq: null })} syncEnabled={false} />);

    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  it("defaults to no query when the query prop is omitted entirely", () => {
    render(<EntryRow entry={entry({ body: "a recurring task" })} syncEnabled={false} />);

    expect(screen.queryByRole("mark")).not.toBeInTheDocument();
  });

  // Issue #78: `select-none` is what the old ContextMenuTrigger's
  // `asChild` merged onto this row, and is exactly why Entry text couldn't
  // be dragged to select. Covered for both an action-less row (grounding-
  // disclosure.tsx's shape) and one with actions (history.tsx's), since
  // the class is assembled conditionally.
  describe("text selection", () => {
    it("carries no select-none, with no actions", () => {
      const { container } = render(
        <EntryRow entry={entry({ body: "hello" })} syncEnabled={false} />,
      );

      const row = container.querySelector('[data-slot="entry-row"]');
      expect(row).not.toHaveClass("select-none");
    });

    it("carries no select-none, with actions", () => {
      const { container } = render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet: vi.fn() }}
        />,
      );

      const row = container.querySelector('[data-slot="entry-row"]');
      expect(row).not.toHaveClass("select-none");
    });
  });

  // ADR 0028: Edit/Delete are opt-in via `actions`, defaulting to none —
  // see EntryRow's own doc comment on why (grounding-disclosure.test.tsx
  // covers the specific caller this default protects).
  describe("the Edit/Delete actions", () => {
    it("offers no hover buttons when actions is omitted", () => {
      render(<EntryRow entry={entry({ body: "hello" })} syncEnabled={false} />);

      expect(screen.queryByLabelText("Edit")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Delete")).not.toBeInTheDocument();
    });

    it("offers Edit and Delete hover buttons when actions is given", () => {
      render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet: vi.fn() }}
        />,
      );

      expect(screen.getByLabelText("Edit")).toBeInTheDocument();
      expect(screen.getByLabelText("Delete")).toBeInTheDocument();
      expect(screen.getByLabelText("Refer to this Entry")).toBeInTheDocument();
    });

    it("calls onEdit with the whole Entry when the Edit button is pressed", () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit, onDelete, onRefer: vi.fn(), onOpenSheet: vi.fn() }}
        />,
      );

      fireEvent.click(screen.getByLabelText("Edit"));

      expect(onEdit).toHaveBeenCalledWith(target);
      expect(onDelete).not.toHaveBeenCalled();
    });

    // Issue #82: Delete no longer deletes on the spot — it merely reports
    // the choice through `onDelete`, exactly like Edit reports through
    // `onEdit` above. Turning that report into a confirmation is the
    // ConfirmDialog history.tsx renders, one level above every row, not
    // anything this component or entry-actions.tsx knows about. EntryRow
    // renders EntryHoverActions but not that dialog, so this only has
    // EntryHoverActions' own contract to prove here; the dialog itself,
    // and onDelete actually firing once it's accepted, are covered by
    // history.test.tsx.
    it("calls onDelete with the whole Entry, to report the choice, when the Delete button is pressed", () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit, onDelete, onRefer: vi.fn(), onOpenSheet: vi.fn() }}
        />,
      );

      fireEvent.click(screen.getByLabelText("Delete"));

      expect(onDelete).toHaveBeenCalledWith(target);
      expect(onEdit).not.toHaveBeenCalled();
    });

    // Issue #144: unlike Delete, Refer calls straight through with no
    // confirm step in between (entry-actions.tsx's own comment on why).
    it("calls onRefer with the whole Entry when the Refer button is pressed", () => {
      const onRefer = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer, onOpenSheet: vi.fn() }}
        />,
      );

      fireEvent.click(screen.getByLabelText("Refer to this Entry"));

      expect(onRefer).toHaveBeenCalledWith(target);
    });
  });

  // #127 retired the tap entirely. This component is what the one surface
  // that stayed a list renders (Reflection's Grounding disclosure), and it
  // wires no `actions` at all — but the assertion is worth keeping, because
  // "a click on Entry text does nothing" is what leaves the click free to
  // place a cursor or dismiss a selection, and a regression here would be
  // invisible on every surface until someone wired `actions` back on.
  describe("clicking the row", () => {
    it("does nothing, on a touch device or a hover-capable one", () => {
      for (const hover of [false, true]) {
        stubHoverCapable(hover);
        const onOpenSheet = vi.fn();
        const { unmount } = render(
          <EntryRow
            entry={entry({ body: "hello" })}
            syncEnabled={false}
            actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet }}
          />,
        );

        fireEvent.click(screen.getByText("hello"));

        expect(onOpenSheet).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("does nothing when actions is omitted", () => {
      stubHoverCapable(false);
      render(<EntryRow entry={entry({ body: "hello" })} syncEnabled={false} />);

      expect(() => fireEvent.click(screen.getByText("hello"))).not.toThrow();
    });
  });

  // The optional half of the ticket: right-click may open the same sheet
  // on a pointer device, but must never intercept a touch device's
  // long-press — which is what actually starts native text selection —
  // by calling preventDefault on it.
  describe("right-clicking the row (optional, pointer devices)", () => {
    it("opens the sheet and prevents the native menu on a hover-capable device", () => {
      stubHoverCapable(true);
      const onOpenSheet = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet }}
        />,
      );

      const notPrevented = fireEvent.contextMenu(screen.getByText("hello"));

      expect(onOpenSheet).toHaveBeenCalledWith(target);
      expect(notPrevented).toBe(false);
    });

    it("leaves a touch device's contextmenu (long-press) alone entirely", () => {
      stubHoverCapable(false);
      const onOpenSheet = vi.fn();
      render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet }}
        />,
      );

      const notPrevented = fireEvent.contextMenu(screen.getByText("hello"));

      expect(onOpenSheet).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });
  });

  // Issue #81, fix 2: History can render hundreds of these, and most of
  // its own re-renders (a sibling row's state changing, a keystroke that
  // doesn't touch this row's Entry) leave a given row's own props
  // untouched — `React.memo` is what lets such a re-render skip this
  // component's own render function (and its call to `formatClockTime`)
  // entirely, rather than re-running it and reconciling unchanged output.
  //
  // `formatClockTime` (imported from entry-day.ts) is what this proves
  // against, rather than a `<Profiler>` wrapping the row: `Profiler`'s
  // `onRender` fires once per *commit that reaches its boundary*, which
  // still happens even when a `React.memo`'d child bails out and never
  // calls its own render function — it isn't actually a signal of whether
  // the row's body ran. A function the row's own body unconditionally
  // calls is.
  describe("memoisation", () => {
    it("does not re-render when a sibling's state changes and this row's own props stay the same", () => {
      const clockSpy = vi.spyOn(entryDayModule, "formatClockTime");
      const target = entry({ body: "hello", createdAt: "2026-08-15T17:27:00.000Z" });

      // Every prop EntryRow gets here is referentially stable across the
      // Harness's own re-renders — `target` is created once, outside the
      // component body — mirroring what history.tsx now guarantees for
      // real rows (memoised `actions`, stable `entry` references from
      // unchanged `groups`).
      function Harness() {
        const [unrelated, setUnrelated] = useState(0);
        return (
          <div>
            <button type="button" onClick={() => setUnrelated((count) => count + 1)}>
              Bump unrelated state
            </button>
            <p data-testid="unrelated">{unrelated}</p>
            <EntryRow entry={target} syncEnabled={false} />
          </div>
        );
      }

      render(<Harness />);
      expect(clockSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Bump unrelated state" }));

      expect(screen.getByTestId("unrelated")).toHaveTextContent("1");
      expect(clockSpy).toHaveBeenCalledTimes(1);
    });

    it("does re-render when its own entry prop actually changes", () => {
      const clockSpy = vi.spyOn(entryDayModule, "formatClockTime");

      function Harness() {
        const [body, setBody] = useState("hello");
        return (
          <div>
            <button type="button" onClick={() => setBody("goodbye")}>
              Change body
            </button>
            <EntryRow
              entry={entry({ body, createdAt: "2026-08-15T17:27:00.000Z" })}
              syncEnabled={false}
            />
          </div>
        );
      }

      render(<Harness />);
      expect(clockSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Change body" }));

      expect(screen.getByText("goodbye")).toBeInTheDocument();
      expect(clockSpy).toHaveBeenCalledTimes(2);
    });
  });

  // Issue #142: a `[[YYYY-MM-DD]]` date Reference resolves through
  // entryBodyContent's own `refs.date` renderer (entry-row.tsx's
  // `DateReferenceLink`), which is the single choke point both this
  // component and the Entry bubble render an Entry's body through.
  describe("a date Reference", () => {
    it("renders as a link to the Composer, seeking that day, once the day is confirmed to hold Entries", async () => {
      const dayHasEntries = vi.fn(async () => true);
      renderEntryRow(entry({ body: "see [[2026-08-28]] for context" }), { dayHasEntries });

      const link = await screen.findByRole("link", { name: /2026-08-28/ });
      expect(link).toHaveAttribute("href", "/composer?d=2026-08-28");
      // The visible text stays the literal mark, per the "a Reference keeps
      // its literal text" rule — only the accessible name says where it
      // goes.
      expect(link).toHaveTextContent("[[2026-08-28]]");
      expect(dayHasEntries).toHaveBeenCalledWith("2026-08-28");
    });

    it("says where it goes in its accessible name, distinct from its literal visible text", async () => {
      const dayHasEntries = vi.fn(async () => true);
      renderEntryRow(entry({ body: "[[2026-08-28]]" }), { dayHasEntries });

      const link = await screen.findByRole("link");
      expect(link.getAttribute("aria-label")).not.toBe("[[2026-08-28]]");
      expect(link.getAttribute("aria-label")).toMatch(/2026-08-28/);
    });

    it("renders as literal text, not a link, once the day is confirmed to hold no Entries", async () => {
      const dayHasEntries = vi.fn(async () => false);
      renderEntryRow(entry({ body: "see [[2026-08-28]] for context" }), { dayHasEntries });

      await screen.findByText("see [[2026-08-28]] for context");
      expect(screen.queryByRole("link", { name: /2026-08-28/ })).not.toBeInTheDocument();
    });

    it("renders as literal text while the day-has-Entries check is still resolving", () => {
      const dayHasEntries = vi.fn(() => new Promise<boolean>(() => {})); // never resolves
      renderEntryRow(entry({ body: "[[2026-08-28]]" }), { dayHasEntries });

      expect(screen.getByText("[[2026-08-28]]")).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders as literal text, and never probes anything, when no dayHasEntries is available at all", () => {
      renderEntryRow(entry({ body: "[[2026-08-28]]" }));

      expect(screen.getByText("[[2026-08-28]]")).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    // The parser's own guarantee (inline-markdown.ts's `parseReferenceDate`)
    // is that a shape which is not a real calendar day never becomes a
    // DateReference node at all — asserted here end to end, through
    // entryBodyContent, rather than only at the parser's own level.
    it("never reaches the renderer at all when the date is not a real calendar day", () => {
      const dayHasEntries = vi.fn(async () => true);
      renderEntryRow(entry({ body: "[[2026-13-45]]" }), { dayHasEntries });

      expect(screen.getByText("[[2026-13-45]]")).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(dayHasEntries).not.toHaveBeenCalled();
    });

    it("highlights a Search match inside the literal text of an unresolved Reference", () => {
      renderEntryRow(entry({ body: "[[2026-13-45]]" }), {}, "2026");

      expect(screen.getByText("2026", { selector: "mark" })).toBeInTheDocument();
    });
  });

  // Issue #143: an Entry Reference's own renderer (entry-row.tsx's
  // `EntryReferenceLink`) reads `getEntry` off `useEntryStore()` and
  // resolves it through TanStack Query — the same shape `DateReferenceLink`
  // already proved out above, mirrored test for test on the Entry side of
  // ADR 0042's "one rule, four causes."
  describe("an Entry Reference", () => {
    const targetId = "0192abcd-1234-7890-abcd-0123456789ab";

    function target(overrides: Partial<Entry> = {}): Entry {
      return entry({
        id: targetId,
        body: "See you at the park tomorrow",
        // Fixed, and far from any run date this suite will ever execute
        // on — `formatDaySeparator` only special-cases "Today"/"Yesterday"
        // relative to the real clock, and this test cares about the
        // generic-date branch, not that one.
        createdAt: "2020-01-01T09:00:00.000Z",
        ...overrides,
      });
    }

    it("renders a chip carrying the target's day and a snippet of its opening text, inline", async () => {
      // Host-independent: entryDayKey's day boundary shifts with the
      // Device's UTC offset, and this suite doesn't otherwise care which
      // timezone the machine running it is in.
      vi.spyOn(entryDayModule, "deviceUtcOffsetMinutes").mockReturnValue(0);
      const getEntry = vi.fn(async () => target());
      renderEntryRow(entry({ body: `see [[e:${targetId}]] for the plan` }), { getEntry });

      const link = await screen.findByRole("link");
      expect(link).toHaveAttribute("href", `/composer?e=${targetId}`);
      expect(link).toHaveTextContent(/2020/);
      expect(link).toHaveTextContent("See you at the park tomorrow");
      expect(getEntry).toHaveBeenCalledWith(targetId);

      // Inline, never a block — the real chip sits inside the Entry
      // bubble's own body `<p>`, among the parsed prose it's a mark in
      // (ADR 0041); see inline-prose.test.tsx's "never renders a block
      // element" test for the fuller version of this same guard.
      expect(link.tagName).toBe("A");
      for (const tag of ["div", "p", "ul", "ol", "li", "blockquote", "pre", "table"]) {
        expect(link.querySelectorAll(tag).length).toBe(0);
      }
    });

    it("updates the chip once the target's cache entry is invalidated, the same way an edit does", async () => {
      const getEntry = vi
        .fn()
        .mockResolvedValueOnce(target({ body: "the old opening line" }))
        .mockResolvedValueOnce(target({ body: "the edited opening line" }));
      const { queryClient } = renderEntryRow(entry({ body: `[[e:${targetId}]]` }), { getEntry });

      await screen.findByText("the old opening line");

      // Stands in for what a real edit does: `refreshNewestEntriesPage`
      // (entries-pagination.ts) invalidates this exact query key on every
      // local write. This test only needs to prove the chip is wired to
      // that cache entry — ADR 0042's "resolves live, not from a
      // snapshot" — not re-exercise the write path that triggers it.
      await queryClient.invalidateQueries({ queryKey: entryReferenceQueryKey(targetId) });

      await screen.findByText("the edited opening line");
      expect(screen.queryByText("the old opening line")).not.toBeInTheDocument();
    });

    it("renders as literal text, not a chip, once the target is confirmed unresolvable", async () => {
      const getEntry = vi.fn(async () => undefined);
      renderEntryRow(entry({ body: `see [[e:${targetId}]] for the plan` }), { getEntry });

      await waitFor(() => expect(getEntry).toHaveBeenCalledWith(targetId));
      expect(screen.getByText(`see [[e:${targetId}]] for the plan`)).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders as literal text while the lookup is still resolving", () => {
      const getEntry = vi.fn(() => new Promise<Entry | undefined>(() => {})); // never resolves
      renderEntryRow(entry({ body: `[[e:${targetId}]]` }), { getEntry });

      expect(screen.getByText(`[[e:${targetId}]]`)).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders as literal text, and never probes anything, when no getEntry is available at all", () => {
      renderEntryRow(entry({ body: `[[e:${targetId}]]` }));

      expect(screen.getByText(`[[e:${targetId}]]`)).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    // The parser's own guarantee (inline-markdown.ts's `ENTRY_SHAPE`) is
    // that a mark whose id isn't a well-formed uuid never becomes an
    // EntryReference node at all — asserted end to end, through
    // entryBodyContent, mirroring the malformed-date test above.
    it("never reaches the renderer at all when the id is not a well-formed uuid", () => {
      const getEntry = vi.fn(async () => target());
      renderEntryRow(entry({ body: "[[e:not-a-uuid]]" }), { getEntry });

      expect(screen.getByText("[[e:not-a-uuid]]")).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(getEntry).not.toHaveBeenCalled();
    });

    // The chip's snippet is a DIFFERENT Entry's words — the Search query
    // matched this Entry's own body, never the target's — so a match that
    // happens to also appear inside the target's snippet must not be
    // painted. Structural, not incidental: `entryBodyContent`'s `query`
    // never reaches `EntryReferenceLink` at all (inline-prose.tsx's
    // `ReferenceRenderers.entry` signature carries only `entryId`/`raw`),
    // which is what this proves.
    it("never highlights a Search match inside the chip's snippet, but still highlights it in the surrounding text", async () => {
      const getEntry = vi.fn(async () => target({ body: "a matching word inside the target" }));
      renderEntryRow(
        entry({ body: `a matching word before [[e:${targetId}]]` }),
        { getEntry },
        "matching",
      );

      await screen.findByText("a matching word inside the target");

      const marks = screen.getAllByText("matching", { selector: "mark" });
      expect(marks).toHaveLength(1);
      expect(marks[0]?.closest("a")).toBeNull();
    });
  });
});
