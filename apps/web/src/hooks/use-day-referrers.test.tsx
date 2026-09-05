import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDayReferrers } from "./use-day-referrers";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-1",
    body: "hello",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    seq: 1,
    syncedAt: "2026-08-29T10:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function Harness({
  probe,
  dayKey,
}: {
  probe: ((dayKey: string) => Promise<Entry[]>) | undefined;
  dayKey: string;
}) {
  const referrers = useDayReferrers(probe, dayKey);
  return <p data-testid="result">{referrers === undefined ? "undefined" : referrers.length}</p>;
}

function renderHarness(probe: ((dayKey: string) => Promise<Entry[]>) | undefined, dayKey: string) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness probe={probe} dayKey={dayKey} />
    </QueryClientProvider>,
  );
}

describe("useDayReferrers", () => {
  it("returns undefined while the probe is still resolving", async () => {
    let resolve!: (value: Entry[]) => void;
    const probe = vi.fn(
      () =>
        new Promise<Entry[]>((res) => {
          resolve = res;
        }),
    );

    renderHarness(probe, "2026-08-28");

    expect(screen.getByTestId("result")).toHaveTextContent("undefined");
    resolve([entry({ id: "a" })]);
    await screen.findByText("1");
  });

  it("resolves to the probe's Entries once it confirms who Refers to this day", async () => {
    const referrers = [entry({ id: "a" }), entry({ id: "b" })];
    const probe = vi.fn(async () => referrers);

    renderHarness(probe, "2026-08-28");

    await screen.findByText("2");
    expect(probe).toHaveBeenCalledWith("2026-08-28");
  });

  it("resolves to an empty list for a day nothing Refers to", async () => {
    const probe = vi.fn(async () => []);

    renderHarness(probe, "2026-08-28");

    await screen.findByText("0");
  });

  it("probes a given day at most once, sharing the answer across every call site for it", async () => {
    const probe = vi.fn(async () => [entry({ id: "a" })]);
    const queryClient = new QueryClient();

    function TwoOccurrences() {
      const a = useDayReferrers(probe, "2026-08-28");
      const b = useDayReferrers(probe, "2026-08-28");
      return (
        <p data-testid="result">
          {a?.length}-{b?.length}
        </p>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TwoOccurrences />
      </QueryClientProvider>,
    );

    await screen.findByText("1-1");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never calls a probe that isn't there, and stays undefined", () => {
    const queryClient = new QueryClient();

    function NoProbe() {
      const result = useDayReferrers(undefined, "2026-08-28");
      return <p data-testid="result">{result === undefined ? "undefined" : result.length}</p>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <NoProbe />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("result")).toHaveTextContent("undefined");
  });
});
