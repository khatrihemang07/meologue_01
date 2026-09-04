import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TodoNav } from "./todo-nav";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TodoNav />
    </MemoryRouter>,
  );
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
});
