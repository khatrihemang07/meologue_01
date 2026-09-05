import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useEntrySearch } from "./use-entry-search";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "now",
    updatedAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

function renderUseEntrySearch(
  search: (query: string) => Promise<Entry[]>,
  query: string,
  fallback: Entry[],
) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(({ query }) => useEntrySearch(search, query, fallback), {
    wrapper,
    initialProps: { query },
  });
}

describe("useEntrySearch", () => {
  it("returns null without calling search when the query is empty", () => {
    const search = vi.fn(async () => []);

    const { result } = renderUseEntrySearch(search, "", []);

    expect(result.current).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it("returns null without calling search when the query is whitespace-only", () => {
    const search = vi.fn(async () => []);

    const { result } = renderUseEntrySearch(search, "   ", []);

    expect(result.current).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it("resolves to the search results, trimmed", async () => {
    const found = [entry({ id: "a", body: "recurring task" })];
    const search = vi.fn(async () => found);

    const { result } = renderUseEntrySearch(search, "  recur  ", []);

    await waitFor(() => expect(result.current).toEqual(found));
    expect(search).toHaveBeenCalledWith("recur");
  });

  it("falls back to the given list while the first search for a query is in flight", () => {
    const fallback = [entry({ id: "full", body: "everything" })];
    const search = vi.fn(() => new Promise<Entry[]>(() => {}));

    const { result } = renderUseEntrySearch(search, "recur", fallback);

    expect(result.current).toEqual(fallback);
  });

  it("keeps showing the previous search's results while the next query is in flight", async () => {
    const firstResults = [entry({ id: "a", body: "recurring task" })];
    let resolveSecond: (entries: Entry[]) => void = () => {};
    const search = vi
      .fn<(query: string) => Promise<Entry[]>>()
      .mockResolvedValueOnce(firstResults)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    const { result, rerender } = renderUseEntrySearch(search, "recur", []);
    await waitFor(() => expect(result.current).toEqual(firstResults));

    rerender({ query: "recurr" });

    // Still showing the first query's results — not empty, not the fallback.
    expect(result.current).toEqual(firstResults);

    const secondResults = [entry({ id: "b", body: "recurring theme" })];
    resolveSecond(secondResults);
    await waitFor(() => expect(result.current).toEqual(secondResults));
  });
});
