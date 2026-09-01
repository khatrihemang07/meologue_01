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
});
