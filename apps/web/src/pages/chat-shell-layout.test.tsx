import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoNav } from "@/components/todo/todo-nav";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
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

    // TodoNav itself: a real link only it renders (TodoSidebar's own
    // "Projects" is a heading over a Project tree, never a link with this
    // exact accessible name — todo-sidebar.tsx's own header comment).
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      "/todo/projects",
    );
    // No sidebar-only content anywhere — proves the pane block
    // (`{wide && …}` in chat-shell-layout.tsx) didn't render at all,
    // rather than rendering and simply losing a race.
    expect(screen.queryByText("Add task")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Chats" })).not.toBeInTheDocument();
  });
});

const { openEntryStoreMock } = vi.hoisted(() => ({
  openEntryStoreMock: vi.fn(),
}));

// TodoSidebar's own header comment: it reads the Entry store the same
// sibling-of-the-Outlet way settings-page.tsx does, via
// `entryStoreQueryOptions` directly — mocked here exactly as
// todo-sidebar.test.tsx and settings-page.test.tsx both already do, so
// mounting it (via ChatShellLayout's own lazy import) needs no real
// SqliteDriver.
vi.mock("@/pages/entry-store-layout", () => ({
  entryStoreQueryOptions: queryOptions({
    queryKey: ENTRY_STORE_QUERY_KEY,
    queryFn: openEntryStoreMock,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
  }),
}));

function renderWideShell(initialPath: string) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<ChatShellLayout />}>
            <Route path="/todo/inbox" element={<div>Todo destination</div>} />
            <Route path="/composer" element={<div>Composer destination</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The other half of issue #223's own brief: at the wide breakpoint, the
 * one existing pane shows `TodoSidebar` under `/todo/*` and `ChatListPane`
 * everywhere else — never both, never neither, never a second pane
 * alongside the first.
 */
describe("at the wide breakpoint, the one pane's content", () => {
  afterEach(removeMatchMedia);

  it("is ChatListPane outside /todo/*", () => {
    installMatchMedia(true);

    renderWideShell("/composer");

    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
  });

  it("is TodoSidebar, not ChatListPane, under /todo/*", async () => {
    installMatchMedia(true);
    openEntryStoreMock.mockResolvedValue({
      taskStore: { list: () => Promise.resolve([]) },
      projectStore: { listProjects: () => Promise.resolve([]) },
      filterStore: { list: () => Promise.resolve([]) },
    });

    renderWideShell("/todo/inbox");

    // Real timers throughout this file (no `vi.useFakeTimers()`) —
    // `React.lazy`'s own dynamic import resolving, `entryStoreQueryOptions`'s
    // promise, and the three dependent Tasks/Projects/Filters queries it
    // unlocks all settle over several real microtask/timer hops TanStack
    // Query schedules internally; `findByRole` polls for exactly that,
    // where fake timers would freeze it (todo-sidebar.test.tsx's own
    // header comment records trying that first). A longer-than-default
    // timeout: this is the one test in the suite actually paying for
    // `React.lazy`'s own dynamic `import()`, which the default 1000ms
    // sometimes outruns even though the resolution itself never fails.
    const todoSidebarNav = await screen.findByRole(
      "navigation",
      { name: "Todo" },
      { timeout: 5000 },
    );

    expect(todoSidebarNav).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Chats" })).not.toBeInTheDocument();
  });
});
