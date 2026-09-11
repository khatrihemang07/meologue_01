import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Issue #223 added Upcoming to todo-sidebar.tsx's own list (the wide
  // breakpoint's replacement for this bar) but never to this one — the
  // defect this test now holds shut the way chat-shell-layout.test.tsx's
  // own NAV-03 row holds the bottom bar's reachability below 900px: by a
  // test, not by an assertion left to whoever edits VIEWS next.
  it("offers Upcoming as a real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Upcoming" })).toHaveAttribute(
      "href",
      "/todo/upcoming",
    );
  });

  // Issue #171's own proof of ADR 0049's prediction a second time — see
  // todo-nav.tsx's own comment on VIEWS.
  it("offers Projects as a third real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      "/todo/projects",
    );
  });

  it("marks Projects current while viewing a single Project's own screen too", () => {
    renderAt("/todo/projects/some-project-id");

    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  });

  // Issue #185's own proof of ADR 0049's prediction a third time — see
  // todo-nav.tsx's own comment on VIEWS.
  it("offers Filters as a fifth real link", () => {
    renderAt("/todo/inbox");

    expect(screen.getByRole("link", { name: "Filters" })).toHaveAttribute("href", "/todo/filters");
  });

  it("marks Filters current while viewing a single Filter's own screen too", () => {
    renderAt("/todo/filters/some-filter-id");

    expect(screen.getByRole("link", { name: "Filters" })).toHaveAttribute("aria-current", "page");
  });

  // Issue #223's second half: TodoSidebar takes over this bar's own role
  // at the wide breakpoint, and this component's own header comment
  // explains why both can't stay mounted at once (two identically-named
  // "Todo" nav landmarks). This is the complement of that ticket's
  // load-bearing narrow-viewport test (chat-shell-layout.test.tsx) — this
  // one proves the wide side of the same claim.
  describe("at the wide breakpoint", () => {
    afterEach(removeMatchMedia);

    it("renders nothing at all", () => {
      installWideMatchMedia();

      renderAt("/todo/inbox");

      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });
  });
});
