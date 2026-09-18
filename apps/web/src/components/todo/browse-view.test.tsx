import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BrowseView } from "./browse-view";

function renderBrowse() {
  return render(
    <MemoryRouter initialEntries={["/todo/browse"]}>
      <BrowseView />
    </MemoryRouter>,
  );
}

describe("BrowseView", () => {
  it("scopes its own landmark to Browse", () => {
    renderBrowse();

    expect(screen.getByRole("navigation", { name: "Browse" })).toBeInTheDocument();
  });

  it("links Search to /todo/search", () => {
    renderBrowse();

    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", "/todo/search");
  });

  it("links Filters & Labels to /todo/filters", () => {
    renderBrowse();

    expect(screen.getByRole("link", { name: "Filters & Labels" })).toHaveAttribute(
      "href",
      "/todo/filters",
    );
  });

  it("links Reporting to /todo/activity", () => {
    renderBrowse();

    expect(screen.getByRole("link", { name: "Reporting" })).toHaveAttribute(
      "href",
      "/todo/activity",
    );
  });

  it("links Projects to /todo/projects", () => {
    renderBrowse();

    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      "/todo/projects",
    );
  });

  // The live Todoist screen this rebuilds also carries a profile header, a
  // "Try Pro for free" promo, "Add a team", "Browse templates" and "Help &
  // resources" — none of which name a real meologue surface
  // (browse-view.tsx's own header comment). Proven absent, not just
  // un-added, so a future row added by copying the live screen too
  // literally gets caught here.
  it("builds no row for a Todoist surface meologue has no equivalent for", () => {
    renderBrowse();

    expect(screen.queryByText(/Try Pro/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add a team/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Browse templates/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Help/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Manage projects/i })).not.toBeInTheDocument();
  });

  it("exposes exactly four rows", () => {
    renderBrowse();

    expect(screen.getAllByRole("link")).toHaveLength(4);
  });
});
