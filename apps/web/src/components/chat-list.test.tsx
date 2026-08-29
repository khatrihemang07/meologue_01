import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ChatList } from "./chat-list";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatList />
    </MemoryRouter>,
  );
}

describe("ChatList", () => {
  // Inherited from the retired `nav.test.tsx`: the count is the assertion,
  // not the membership. ADR 0018 bounded it to Material 3's three-to-five
  // and every ADR since has kept it there — including ADR 0036, which
  // declined to add a fifth row for Reflect's Sessions.
  it("offers exactly four destinations", () => {
    renderAt("/");

    expect(within(screen.getByRole("navigation")).getAllByRole("link")).toHaveLength(4);
  });

  it("gives every row a real href rather than a placeholder", () => {
    renderAt("/");

    expect(screen.getByRole("link", { name: /Composer/ })).toHaveAttribute("href", "/composer");
    expect(screen.getByRole("link", { name: /Reflect/ })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("href", "/digest");
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings");
  });

  // What ADR 0036 owes the accessibility tree in place of the persistent
  // `<nav>` it retired: a real href (above) and a current marker (here).
  it("marks the open destination, and only that one, as current", () => {
    renderAt("/digest");

    expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Composer/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /Reflect/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /Settings/ })).not.toHaveAttribute("aria-current");
  });

  // `/digest/:period/:date` is still the Digest destination, which is why
  // only Composer carries `end`. A reader deep in a Digest should not see
  // the list claim nothing is open.
  it("keeps a destination marked current from a route nested under it", () => {
    renderAt("/digest/day/2026-08-27");

    expect(screen.getByRole("link", { name: /Digest/ })).toHaveAttribute("aria-current", "page");
  });

  // Composer is the one destination with `end`, so an unrelated route must
  // not light it up the way a prefix match would.
  it("does not mark Composer current from another destination", () => {
    renderAt("/settings");

    expect(screen.getByRole("link", { name: /Composer/ })).not.toHaveAttribute("aria-current");
  });

  it("scopes its landmark to the list rather than announcing app-wide navigation", () => {
    renderAt("/");

    expect(screen.getByRole("navigation")).toHaveAccessibleName("Chats");
  });

  // The ragged-right-edge defect: a row allowed to run full width while its
  // neighbours clip. Every summary gets the same treatment, Settings' too.
  it("truncates every row's summary, including the one with no timestamp", () => {
    renderAt("/");

    const summaries = screen
      .getAllByRole("link")
      .map((link) => link.querySelector("span > span:last-child"));
    expect(summaries).toHaveLength(4);
    for (const summary of summaries) {
      expect(summary).toHaveClass("truncate");
    }
  });
});
