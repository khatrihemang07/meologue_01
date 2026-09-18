import type { Filter, Label } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { FiltersView } from "./filters-view";

function filter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: "filter-1",
    deviceId: "device-a",
    name: "Due today",
    colour: "#DC4C3E",
    query: "today",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "label-1",
    deviceId: "device-a",
    name: "Family",
    colour: "#369307",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderFiltersView(filters: Filter[], labels: Label[] = []) {
  return render(
    <MemoryRouter>
      <FiltersView filters={filters} labels={labels} />
    </MemoryRouter>,
  );
}

describe("FiltersView", () => {
  it("offers New Filter as a real link to the composer", () => {
    renderFiltersView([]);

    expect(screen.getByRole("link", { name: "New Filter" })).toHaveAttribute(
      "href",
      "/todo/filters/new",
    );
  });

  it("shows an empty message with no Filters yet", () => {
    renderFiltersView([]);

    expect(screen.getByText(/No Filters yet/)).toBeInTheDocument();
  });

  it("carries a My Filters heading above the filter list", () => {
    renderFiltersView([]);

    expect(screen.getByRole("heading", { name: "My Filters", level: 2 })).toBeInTheDocument();
  });

  it("lists every Filter by name, each linking to its own screen", () => {
    renderFiltersView([
      filter({ id: "a", name: "Due today" }),
      filter({ id: "b", name: "Overdue" }),
    ]);

    expect(screen.getByRole("link", { name: "Due today" })).toHaveAttribute(
      "href",
      "/todo/filters/a",
    );
    expect(screen.getByRole("link", { name: "Overdue" })).toHaveAttribute(
      "href",
      "/todo/filters/b",
    );
  });

  it("shows each Filter's own query text", () => {
    renderFiltersView([filter({ query: "#Work & p1" })]);

    expect(screen.getByText("#Work & p1")).toBeInTheDocument();
  });
});

describe("FiltersView — Labels section", () => {
  it("renders with no labels prop at all, unchanged (every pre-#229 caller)", () => {
    render(
      <MemoryRouter>
        <FiltersView filters={[filter()]} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/No Labels yet/)).toBeInTheDocument();
  });

  it("shows an empty message with no Labels yet", () => {
    renderFiltersView([], []);

    expect(screen.getByText(/No Labels yet/)).toBeInTheDocument();
  });

  it("lists every Label by name and colour", () => {
    renderFiltersView([], [label({ id: "a", name: "Family" }), label({ id: "b", name: "Work" })]);

    expect(screen.getByText("Family")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
  });

  it("links to the dedicated Label management screen", () => {
    renderFiltersView([], []);

    expect(screen.getByRole("link", { name: "Manage Labels" })).toHaveAttribute(
      "href",
      "/todo/labels",
    );
  });
});
