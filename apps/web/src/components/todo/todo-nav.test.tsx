import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TODO_SIDEBAR_QUERY, WIDE_LAYOUT_QUERY } from "@/hooks/use-wide-layout";
import { TodoNav } from "./todo-nav";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TodoNav />
    </MemoryRouter>,
  );
}

// Mirrors use-wide-layout.test.ts's own stand-in ("jsdom implements no
// matchMedia at all") — every test above renders with no stub at all,
// which use-wide-layout.ts's own default (narrow) already covers; this is
// the one test in this file that needs the query to answer wide.
function installWideMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches: true,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

// Query-aware, unlike the blunt stand-in above: this component now reads
// `TODO_SIDEBAR_QUERY` (1200px), a narrower query than `WIDE_LAYOUT_QUERY`
// (900px) — the owner's amendment to ADR 0076 moved `TodoNav`'s own
// hand-off point to 1200px along with `TodoSidebar`'s. Proving the 900-
// 1199px band specifically needs a stub that can answer differently for
// each query, which `installWideMatchMedia` above (true for everything)
// cannot do.
function installMatchMediaAt(wide: boolean, sidebarWide: boolean) {
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

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("TodoNav", () => {
  it("scopes its landmark to Todo, not the app", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("navigation")).toHaveAccessibleName("Todo");
  });

  it("offers Inbox as a real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute("href", "/todo/inbox");
  });

  it("marks Inbox current while it's the open view", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  });

  // Issue #169's own proof of ADR 0049's prediction — see todo-nav.tsx's
  // own comment on VIEWS.
  it("offers Today as a second real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Today" })).toHaveAttribute("href", "/todo/today");
  });

  it("marks Today current while it's the open view, and Inbox no longer current", () => {
    renderAt("/todo/today");

    expect(screen.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
  });

  it("offers Upcoming as a real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Upcoming" })).toHaveAttribute(
      "href",
      "/todo/upcoming",
    );
  });

  it("offers Browse as a fourth real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/todo/browse");
  });

  it("marks Browse current while it's the open view", () => {
    renderAt("/todo/browse");

    expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("aria-current", "page");
  });

  it("no longer offers Projects or Filters as rows of their own", () => {
    renderAt("/todo/inbox");

    expect(screen.queryByRole("link", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("sizes every row to Todoist's own measured 80 CSS px item height", () => {
    renderAt("/todo/inbox");

    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("h-20");
    }
  });

  it("paints the active pill behind the icon only, with the label in a different ink", () => {
    renderAt("/todo/inbox");

    const activeLink = screen.getByRole("link", { name: "Inbox" });
    const [pill, label] = activeLink.children;

    expect(pill?.className).toContain("bg-[color:var(--td-nav-active-pill)]");
    const icon = pill?.firstElementChild;
    expect(icon?.getAttribute("class")).toContain("text-[color:var(--td-nav-active-icon)]");
    expect(label?.className).toContain("text-[color:var(--td-nav-active-label)]");
    // The two tokens actually differ — otherwise this would be one ink,
    // not the two distinct reds the live device shows.
    expect(icon?.getAttribute("class")).not.toContain("--td-nav-active-label");
  });

  it("leaves an inactive row's pill unpainted, icon and label sharing one ink", () => {
    renderAt("/todo/inbox");

    const inactiveLink = screen.getByRole("link", { name: "Today" });
    const [pill, label] = inactiveLink.children;

    expect(pill?.className).not.toContain("bg-[color:var(--td-nav-active-pill)]");
    const icon = pill?.firstElementChild;
    expect(icon?.getAttribute("class")).toContain("text-[color:var(--td-nav-inactive)]");
    expect(label?.className).toContain("text-[color:var(--td-nav-inactive)]");
  });

  // Issue #223's second half: TodoSidebar takes over this bar's own role
  // at the wide breakpoint, and this component's own header comment
  // explains why both can't stay mounted at once (two identically-named
  // "Todo" nav landmarks). This is the complement of that ticket's
  // load-bearing narrow-viewport test (chat-shell-layout.test.tsx) — this
  // one proves the wide side of the same claim.
  describe("at the sidebar breakpoint (1200px)", () => {
    afterEach(removeMatchMedia);

    it("renders nothing at all", () => {
      installWideMatchMedia();

      renderAt("/todo/inbox");

      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });
  });

  // The owner's amendment to ADR 0076: TodoNav's own hand-off point moved
  // from 900px to 1200px along with TodoSidebar's, so the 900-1199px band
  // — wide enough for the chat list pane, not yet wide enough for the
  // sidebar — is a real gap TodoNav has to keep covering that it used to
  // hand off at 900px. This is the regression this component's own
  // breakpoint move could most plausibly get wrong: answering `wide` (900)
  // instead of `sidebarWide` (1200) would make this bar disappear here too.
  describe("in the 900-1199px band (wide, not yet sidebar-wide)", () => {
    afterEach(removeMatchMedia);

    it("keeps rendering", () => {
      installMatchMediaAt(true, false);

      renderAt("/todo/inbox");

      expect(screen.getByRole("navigation")).toHaveAccessibleName("Todo");
    });

    it("still offers Browse", () => {
      installMatchMediaAt(true, false);

      renderAt("/todo/inbox");

      expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/todo/browse");
    });
  });
});
