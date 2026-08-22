import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { Shell } from "./shell";

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
