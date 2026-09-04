import type { Filter } from "@meologue/core";
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
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function renderFiltersView(filters: Filter[]) {
  return render(
    <MemoryRouter>
      <FiltersView filters={filters} />
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
