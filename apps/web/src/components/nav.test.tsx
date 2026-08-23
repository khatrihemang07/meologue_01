import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Nav } from "./nav";

// Issue #75's central acceptance criterion: the nav carries exactly four
// destinations — Composer, Reflect, Digest, Settings — with no History
// entry and no fifth destination either. Page-level tests (composer-page,
// reflection-page, settings-page) each assert their own subset of this
// same list against the page they render; this is the one place that pins
// down the *whole* set, independent of which page happens to be current.
describe("Nav", () => {
  it("renders exactly four destinations: Composer, Reflect, Digest, Settings", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Nav />
      </MemoryRouter>,
    );

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Composer",
      "Reflect",
      "Digest",
      "Settings",
    ]);
  });

  it("points each destination at its own route", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Nav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Digest" })).toHaveAttribute("href", "/digest");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // No History destination at all (issue #75, not a rename or a redirect):
  // the Composer already renders the identical History component with the
  // identical props, so a reader looking for a "History" link in the nav
  // should find none, not a renamed or relocated one.
  it("has no History destination", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Nav />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "History" })).not.toBeInTheDocument();
  });
});
