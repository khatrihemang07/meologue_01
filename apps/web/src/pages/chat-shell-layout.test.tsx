import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoNav } from "@/components/todo/todo-nav";
import { TODO_SIDEBAR_QUERY, WIDE_LAYOUT_QUERY } from "@/hooks/use-wide-layout";
import { ChatShellLayout } from "./chat-shell-layout";

/**
 * Issue #223's own seam: `data-surface="todo"` is the ENTIRE mechanism
 * index.css's `[data-surface="todo"]` scope keys off, so a route-driven test
 * here is what stands in for "Todoist's palette applies inside Todo and
 * nowhere else" — a CSS selector matching has no observable effect in jsdom
 * (no styles are ever computed), but the attribute it matches against is a
 * plain, assertable fact.
 *
 * **It is asserted on `documentElement`, not on this component's own div,
 * and that distinction is the point.** The attribute first lived on the div,
 * and this test passed for it — while every Radix overlay in Todo rendered
 * completely unthemed, because a Portal mounts into `document.body`, outside
 * that div entirely. Measured live, the task detail dialog came back
 * `insideScope: false`, painted in the app's own palette and set in Geist.
 * The test could not see it: jsdom computes no styles, so "the attribute is
 * on the element I chose" was never the same claim as "the scope reaches the
 * thing being painted".
 *
 * The default (narrow) layout is exercised deliberately: `useWideLayout`
 * reads `false` unless a test stubs `matchMedia` otherwise
 * (`src/test/setup.ts`'s own default), so `ChatListPane` never mounts here
 * and this test never has to satisfy its own dependencies (`ChatList`,
 * `SyncStatusIndicator`) just to read one attribute off an ancestor `<div>`
 * neither of them touches.
 */
function renderShell(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<ChatShellLayout />}>
          <Route path="/todo/inbox" element={<div>Todo</div>} />
          <Route path="/composer" element={<div>Composer</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatShellLayout's data-surface attribute", () => {
  it("is present on documentElement, and reads 'todo', on a /todo/* route", () => {
    renderShell("/todo/inbox");

    expect(document.documentElement).toHaveAttribute("data-surface", "todo");
  });

  it("is absent — not merely empty — on a non-Todo route", () => {
    renderShell("/composer");

    expect(document.documentElement).not.toHaveAttribute("data-surface");
  });

  it("is cleared when the shell unmounts, so it cannot outlive Todo", () => {
    const { unmount } = renderShell("/todo/inbox");
    expect(document.documentElement).toHaveAttribute("data-surface", "todo");

    unmount();

    expect(document.documentElement).not.toHaveAttribute("data-surface");
  });
});

/** Mirrors use-wide-layout.test.ts's own stand-in ("jsdom implements no matchMedia at all"). */
function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/**
 * Issue #223's own load-bearing constraint: below the wide breakpoint,
 * nothing about Todo's own layout changes. `TodoNav` is the REAL
 * component here, not a stand-in — the claim under test is specifically
 * that it keeps rendering unaffected while `ChatShellLayout`'s own pane
 * logic (this file's other describe blocks) does something different one
 * breakpoint up, and a stub `<div>` could never fail that in a way worth
 * catching.
 */
describe("below the wide breakpoint (no matchMedia stub — use-wide-layout.ts's own narrow default)", () => {
  afterEach(removeMatchMedia);

  it("renders no pane at all, and TodoNav's bottom bar still renders in the Outlet", () => {
    render(
      <MemoryRouter initialEntries={["/todo/inbox"]}>
        <Routes>
          <Route element={<ChatShellLayout />}>
            <Route path="/todo/inbox" element={<TodoNav />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // TodoNav itself: a real link only it renders. Since ADR 0084 the bar
    // carries Inbox/Today/Upcoming/Browse, and Browse is the one
    // destination TodoSidebar has no row for at all — the sidebar lists
    // Browse's own contents (Search, Filters & Labels, Reporting,
    // Projects) directly instead. So "Browse" is the unambiguous tell that
    // the bar rendered and the sidebar did not.
    expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/todo/browse");
    // No sidebar-only content anywhere — proves the pane block
    // (`{wide && …}` in chat-shell-layout.tsx) didn't render at all,
    // rather than rendering and simply losing a race.
    expect(screen.queryByText("Add task")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Chats" })).not.toBeInTheDocument();
  });
});

/**
 * The owner overruled ADR 0076 (issue #223's own brief for this pane no
 * longer holds): at the wide breakpoint, the one existing pane is always
 * `ChatListPane` now — `/todo/*` included, never swapped for `TodoSidebar`.
 * `TodoSidebar` is `todo-page.tsx`'s own concern, mounted as a second
 * column inside Todo's own subtree only above 1200px
 * (`todo-page.test.tsx` covers that half); nothing about it is this file's
 * to prove any more, since `chat-shell-layout.tsx` no longer imports it at
 * all.
 */
describe("at the wide breakpoint, the one pane's content", () => {
  afterEach(removeMatchMedia);

  it("is ChatListPane outside /todo/*", () => {
    installMatchMedia(true);

    renderShell("/composer");

    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
  });

  // Replaces this describe block's own former "is TodoSidebar, not
  // ChatListPane, under /todo/*" — that assertion was ADR 0076's decision,
  // now overruled; this is its replacement, not a weakened version of it.
  it("is ChatListPane under /todo/* too, not TodoSidebar", () => {
    installMatchMedia(true);

    renderShell("/todo/inbox");

    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
  });
});

function installBandMatchMedia(wide: boolean, sidebarWide: boolean) {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((query: string) => ({
      matches:
        (query === WIDE_LAYOUT_QUERY && wide) || (query === TODO_SIDEBAR_QUERY && sidebarWide),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

/**
 * The band the owner's amendment to ADR 0076 creates: wide enough for the
 * chat list pane (`WIDE_LAYOUT_QUERY`, 900px) but not yet wide enough for
 * Todo's own sidebar (`TODO_SIDEBAR_QUERY`, 1200px, `todo-nav.tsx`'s own
 * header comment on why `TodoNav`'s own breakpoint moved here with it).
 * `TodoNav` is the real component, not a stand-in, mirroring the below-
 * the-wide-breakpoint describe block's own reasoning above — the claim
 * under test is specifically that it still covers this band now that its
 * own hand-off point moved.
 */
describe("in the 900-1199px band (wide, not yet sidebar-wide)", () => {
  afterEach(removeMatchMedia);

  it("shows the chat list pane and TodoNav's bottom bar, with no TodoSidebar", () => {
    installBandMatchMedia(true, false);

    render(
      <MemoryRouter initialEntries={["/todo/inbox"]}>
        <Routes>
          <Route element={<ChatShellLayout />}>
            <Route path="/todo/inbox" element={<TodoNav />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
    // TodoNav itself: a real link only it renders. Since ADR 0084 the bar
    // carries Inbox/Today/Upcoming/Browse, and Browse is the one
    // destination TodoSidebar has no row for at all — the sidebar lists
    // Browse's own contents (Search, Filters & Labels, Reporting,
    // Projects) directly instead. So "Browse" is the unambiguous tell that
    // the bar rendered and the sidebar did not.
    expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/todo/browse");
    // Exactly one "Todo" nav landmark, not two — the duplicate-landmark
    // defect ADR 0076's own Decision section names (todo-nav.tsx's own
    // header comment) is exactly what a second one here would be.
    expect(screen.getAllByRole("navigation", { name: "Todo" })).toHaveLength(1);
  });
});
