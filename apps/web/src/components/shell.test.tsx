import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { Shell } from "./shell";

// Shell reads `useLocation`/`useNavigationType` to decide whether it was
// pushed onto (ADR 0036's list-then-push shape), so it needs a router above
// it. Wrapping once here rather than at all 22 call sites below keeps each
// test about the thing it names instead of about routing. RTL reapplies the
// wrapper on `rerender`, so the pinned-thread tests that re-render keep it.
function render(ui: ReactElement) {
  return rtlRender(ui, {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
}

// jsdom lays nothing out, so scrollHeight/clientHeight are always 0 unless
// a test overrides them — see use-pinned-scroll.test.tsx for the same
// technique, exercised there against the hook directly rather than Shell's
// wiring of it.
function setScrollGeometry(
  el: HTMLElement,
  {
    scrollHeight,
    clientHeight,
    scrollTop,
  }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

// Ticket 40: the Sync status indicator is ambient — mounted once in Shell,
// which every page renders through — rather than wired into each page, so
// this exercises Shell directly instead of duplicating the same assertions
// across composer-page and settings-page tests.
describe("Shell's Sync status indicator", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("reads as off, a neutral state, with no Server URL configured", () => {
    render(<Shell title="Meologue">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is off" })).toBeInTheDocument();
  });

  it("reads as working once a Server URL is configured with no failure recorded", () => {
    useSettingsStore.setState({ serverUrl: "https://server.example" });

    render(<Shell title="Meologue">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is working" })).toBeInTheDocument();
  });

  it("reads as failing once an attempt against the configured Server URL has failed", () => {
    useSettingsStore.setState({ serverUrl: "https://server.example" });
    useSyncStatusStore.getState().recordFailure("https://server.example", "boom");

    render(<Shell title="Meologue">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is failing" })).toBeInTheDocument();
  });

  it("is visible on every page Shell renders, not only Settings", () => {
    useSettingsStore.setState({ serverUrl: "https://server.example" });
    useSyncStatusStore.getState().recordFailure("https://server.example", "boom");

    render(<Shell title="History">content</Shell>);

    expect(screen.getByRole("img", { name: "Sync is failing" })).toBeInTheDocument();
  });
});

// Ticket 53: Shell's own wiring of use-pinned-scroll.ts — the hook's
// conditional-pin logic itself is covered by use-pinned-scroll.test.tsx;
// these confirm Shell plumbs `pinnedThread` into the scroll region and
// jump-to-newest control correctly, not the pin rule itself.
describe("Shell's pinned thread", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("shows no jump-to-newest control without a pinnedThread prop", () => {
    render(<Shell title="Meologue">content</Shell>);

    expect(screen.queryByRole("button", { name: "Jump to newest" })).not.toBeInTheDocument();
  });

  it("shows no jump-to-newest control while at the newest end", () => {
    render(
      <Shell title="Meologue" pinnedThread={{ watch: 1 }}>
        content
      </Shell>,
    );

    expect(screen.queryByRole("button", { name: "Jump to newest" })).not.toBeInTheDocument();
  });

  it("shows the jump-to-newest control once the reader scrolls away, and hides it again once the control is used", () => {
    render(
      <Shell title="Meologue" pinnedThread={{ watch: 1 }}>
        content
      </Shell>,
    );
    const scroller = screen.getByTestId("shell-scroll-region");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);

    const control = screen.getByRole("button", { name: "Jump to newest" });
    expect(control).toBeInTheDocument();

    fireEvent.click(control);

    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).not.toBeInTheDocument();
  });

  it("does not move the scroll region when new content arrives (watch changes) after the reader scrolled away", () => {
    const { rerender } = render(
      <Shell title="Meologue" pinnedThread={{ watch: 1 }}>
        content
      </Shell>,
    );
    const scroller = screen.getByTestId("shell-scroll-region");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to newest" })).toBeInTheDocument();

    setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 0 });
    rerender(
      <Shell title="Meologue" pinnedThread={{ watch: 2 }}>
        content
      </Shell>,
    );

    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByRole("button", { name: "Jump to newest" })).toBeInTheDocument();
  });

  it("jumps to the newest end and re-hides the control when forceToNewest changes, however far away the reader is", () => {
    const { rerender } = render(
      <Shell title="Meologue" pinnedThread={{ watch: 1, forceToNewest: 0 }}>
        content
      </Shell>,
    );
    const scroller = screen.getByTestId("shell-scroll-region");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to newest" })).toBeInTheDocument();

    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    rerender(
      <Shell title="Meologue" pinnedThread={{ watch: 1, forceToNewest: 1 }}>
        content
      </Shell>,
    );

    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).not.toBeInTheDocument();
  });

  it("keeps the jump-to-newest control outside the scroll region, so it never covers an Entry", () => {
    render(
      <Shell title="Meologue" pinnedThread={{ watch: 1 }}>
        content
      </Shell>,
    );
    const scroller = screen.getByTestId("shell-scroll-region");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);

    // The control first shipped as an overlay hanging at the scroll
    // region's bottom edge, which put it on top of whatever line happened
    // to sit at the bottom of the screen — and it only ever shows while
    // scrolled away, so that was always a line the reader was reading.
    // Living outside the scroller is what keeps it covering nothing.
    const control = screen.getByRole("button", { name: "Jump to newest" });
    expect(scroller.contains(control)).toBe(false);
  });
});

// Ticket 55: Shell's own wiring of the magnifier-expands-in-place mode —
// composer-page.test.tsx covers the page-level consequences (narrowing the
// thread, the URL param), these cover the pure interaction Shell owns by
// itself: showing/hiding the affordance and switching the header's
// contents.
describe("Shell's search mode", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("shows no magnifier without a search prop — Settings' case (ADR 0008/0009, #55: no search affordance without a thread)", () => {
    render(<Shell title="Settings">content</Shell>);

    expect(screen.queryByRole("button", { name: "Search History" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
  });

  it("shows the magnifier, not the field, while a search prop is given but empty", () => {
    render(
      <Shell title="History" search={{ query: "", onQueryChange: vi.fn(), onDismiss: vi.fn() }}>
        content
      </Shell>,
    );

    expect(screen.getByRole("button", { name: "Search History" })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
  });

  it("expands the app bar into a search field in place when the magnifier is tapped, hiding the title", () => {
    render(
      <Shell title="History" search={{ query: "", onQueryChange: vi.fn(), onDismiss: vi.fn() }}>
        content
      </Shell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search History" }));

    expect(screen.getByRole("searchbox", { name: "Search History" })).toBeInTheDocument();
    expect(screen.queryByText("History")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search History" })).not.toBeInTheDocument();
  });

  it("reports keystrokes through onQueryChange rather than owning the query itself", () => {
    const onQueryChange = vi.fn();
    render(
      <Shell title="History" search={{ query: "", onQueryChange, onDismiss: vi.fn() }}>
        content
      </Shell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search History" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
      target: { value: "wor" },
    });

    expect(onQueryChange).toHaveBeenCalledWith("wor");
  });

  it("opens already-expanded when a query is already active, without a click", () => {
    render(
      <Shell title="History" search={{ query: "wor", onQueryChange: vi.fn(), onDismiss: vi.fn() }}>
        content
      </Shell>,
    );

    expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("wor");
  });

  it("dismissing via the close button restores the bar and clears the narrowing", () => {
    const onDismiss = vi.fn();
    render(
      <Shell title="History" search={{ query: "wor", onQueryChange: vi.fn(), onDismiss }}>
        content
      </Shell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
  });

  it("dismissing via Escape has the same effect as the close button", () => {
    const onDismiss = vi.fn();
    render(
      <Shell title="History" search={{ query: "wor", onQueryChange: vi.fn(), onDismiss }}>
        content
      </Shell>,
    );

    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search History" }), {
      key: "Escape",
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
  });

  it("does not collapse the field just because the query became empty by typing", () => {
    const onDismiss = vi.fn();
    render(
      <Shell title="History" search={{ query: "wor", onQueryChange: vi.fn(), onDismiss }}>
        content
      </Shell>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
      target: { value: "" },
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox", { name: "Search History" })).toBeInTheDocument();
  });
});

// The Back affordance's own leading slot: Shell only knows how to render
// whatever ReactNode it's handed here, immediately before the title — the
// slot's existence, not its contents (a real history.back()/navigate(-1)
// decision), is what belongs to Shell. No page fills it in today (issue #75
// removed settings-page.tsx's Back button, the slot's only caller — see
// that ticket's reasoning: with Settings itself now a Nav destination, ADR
// 0018's "an always-reachable destination doesn't need Back" applies to it
// too); the slot itself stays in Shell as a general capability, exercised
// here directly rather than through any current page.
describe("Shell's back slot", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("renders the back slot's contents when passed", () => {
    render(
      <Shell title="Settings" back={<button type="button" aria-label="Back" />}>
        content
      </Shell>,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("renders no back control at all when the prop is omitted", () => {
    render(<Shell title="Settings">content</Shell>);

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });
});

// Issue #159's successor: `messageAction` renders a real, tappable link
// under `message` when a failure has somewhere to go (today, an insecure
// origin pointing at the HTTPS one that can actually store Entries) — a
// plain `<a>`, not a router Link, since the destination is a different
// origin entirely.
describe("Shell's message action link", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("renders messageAction as a real link with the given href", () => {
    render(
      <Shell
        title="Meologue"
        message="meologue can't store Entries over plain HTTP — open this page over HTTPS, or on localhost."
        messageAction={{ href: "https://example.ts.net/", label: "https://example.ts.net/" }}
      >
        content
      </Shell>,
    );

    const link = screen.getByRole("link", { name: "https://example.ts.net/" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://example.ts.net/");
  });

  it("renders no link when message is given without messageAction", () => {
    render(
      <Shell title="Meologue" message="meologue couldn't open its storage. Reloading may help.">
        content
      </Shell>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

// Issue #254: the shared content column's width override, and Todo's
// app-bar-to-in-column-heading swap. jsdom lays nothing out, so none of
// this can confirm the *pixel* values (800px; 26px/700/35px) — only that
// the right classes and the right elements land in the right place. The
// real-browser measurement is covered by apps/e2e/tests/layout.spec.ts,
// not here.
describe("Shell's column width override and hideAppBar (issue #254)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ serverUrl: "" });
    useSyncStatusStore.setState({ lastAttempt: null });
  });

  it("renders the default column classes, byte-for-byte, when columnWidthClassName is omitted", () => {
    render(<Shell title="Meologue">content</Shell>);

    // `getByText` matches by an element's own direct text-node children
    // (dom-testing-library's `getNodeText`), so this returns the content
    // column div itself — its only direct text child is "content".
    const column = screen.getByText("content");
    // Exact className equality, not toHaveClass's subset check — this is
    // the "byte-for-byte identical to before this prop existed" bar the
    // ticket sets for every caller that passes neither new prop.
    expect(column.className).toBe("mx-auto flex w-[97%] flex-col gap-4 px-4 py-4 md:w-[85%]");
  });

  it("uses the override's width classes in place of the default pair when columnWidthClassName is given", () => {
    render(
      <Shell title="Todo" columnWidthClassName="min-[900px]:w-full min-[900px]:max-w-[800px]">
        content
      </Shell>,
    );

    const column = screen.getByText("content");
    expect(column.className).toBe(
      "mx-auto flex flex-col gap-4 px-4 py-4 min-[900px]:w-full min-[900px]:max-w-[800px]",
    );
  });

  it("renders the app bar and no in-column heading when hideAppBar is omitted", () => {
    render(
      <Shell title="Settings" back={<button type="button" aria-label="Back" />}>
        content
      </Shell>,
    );

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    // `back` still renders, but inside the (still-present) app bar, not a
    // second time inside the column.
    expect(screen.getAllByRole("button", { name: "Back" })).toHaveLength(1);
  });

  it("skips the app bar and renders title/back/Sync as an in-column heading row when hideAppBar is set", () => {
    render(
      <Shell title="Inbox" back={<button type="button" aria-label="Back" />} hideAppBar>
        content
      </Shell>,
    );

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();

    const heading = screen.getByRole("heading", { name: "Inbox" });
    expect(heading.tagName).toBe("H1");

    // back and the Sync dot sit in the same row as the heading, inside the
    // scrollable content region rather than a fixed app bar.
    const scrollRegion = screen.getByTestId("shell-scroll-region");
    expect(scrollRegion).toContainElement(heading);
    expect(scrollRegion).toContainElement(screen.getByRole("button", { name: "Back" }));
    expect(scrollRegion).toContainElement(screen.getByTestId("sync-status-indicator"));

    // The heading row precedes the rest of the column's content.
    const column = heading.closest("div")?.parentElement;
    expect(column?.textContent?.indexOf("Inbox")).toBeLessThan(
      column?.textContent?.indexOf("content") ?? -1,
    );
  });

  // Issue #307: before this, `action` was read only inside the `!hideAppBar`
  // branch (the fixed app bar), so Todo — the one caller that sets
  // `hideAppBar` — had no way to add a trailing header action at all; the
  // prop existed but nothing that used `hideAppBar` could reach it. Todo's
  // Search door (todo-page.tsx) is the first caller that needs one.
  it("renders `action` inside the in-column heading row too, when hideAppBar is set", () => {
    render(
      <Shell
        title="Inbox"
        hideAppBar
        action={
          <button type="button" aria-label="Search">
            Search
          </button>
        }
      >
        content
      </Shell>,
    );

    const scrollRegion = screen.getByTestId("shell-scroll-region");
    expect(scrollRegion).toContainElement(screen.getByRole("button", { name: "Search" }));
  });
});

// Issue #304: `TodoCreateFab`'s own slot. Exercised here, against Shell
// directly, the same way the Sync status indicator's ambient rendering is
// (this file's own header comment) — a plain `<button>` stands in for the
// real control since what's under test is Shell's own placement and
// bottom-spacer wiring, not TodoCreateFab (todo-create-fab.test.tsx covers
// that component itself).
describe("Shell's floatingAction slot (issue #304)", () => {
  it("renders nothing extra and adds no spacer when floatingAction is omitted", () => {
    render(<Shell title="Todo">content</Shell>);

    expect(screen.queryByRole("button", { name: "Float" })).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-testid="floating-action-spacer"]'),
    ).not.toBeInTheDocument();
  });

  it("renders floatingAction inside the scroll wrapper, alongside the scroll region rather than inside it", () => {
    render(
      <Shell title="Todo" floatingAction={<button type="button">Float</button>}>
        content
      </Shell>,
    );

    const floatButton = screen.getByRole("button", { name: "Float" });
    expect(floatButton).toBeInTheDocument();
    // Not inside the scrollable region — a floating control inside it would
    // scroll away with the content it's supposed to hang over (shell.tsx's
    // own header comment on the identical constraint for jump-to-newest).
    expect(screen.getByTestId("shell-scroll-region")).not.toContainElement(floatButton);
  });

  it("reserves bottom clearance in the scroll column only when floatingAction is given", () => {
    render(
      <Shell title="Todo" floatingAction={<button type="button">Float</button>}>
        content
      </Shell>,
    );

    const spacer = document.querySelector('[data-testid="floating-action-spacer"]');
    expect(spacer).toBeInTheDocument();
    // Inside the scroll region, unlike floatingAction itself — the spacer's
    // whole job is to scroll away with the content so the list's own last
    // row clears floatingAction's footprint once scrolled fully into view.
    expect(screen.getByTestId("shell-scroll-region")).toContainElement(spacer as HTMLElement);
  });
});
