import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDayHasEntries } from "./use-day-has-entries";

function Harness({
  probe,
  dayKey,
}: {
  probe: ((dayKey: string) => Promise<boolean>) | undefined;
  dayKey: string;
}) {
  const hasEntries = useDayHasEntries(probe, dayKey);
  return <p data-testid="result">{String(hasEntries)}</p>;
}

function renderHarness(probe: ((dayKey: string) => Promise<boolean>) | undefined, dayKey: string) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness probe={probe} dayKey={dayKey} />
    </QueryClientProvider>,
  );
}

describe("useDayHasEntries", () => {
  it("returns undefined while the probe is still resolving", async () => {
    let resolve!: (value: boolean) => void;
    const probe = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolve = res;
        }),
    );

    renderHarness(probe, "2026-08-28");

    expect(screen.getByTestId("result")).toHaveTextContent("undefined");
    resolve(true);
    await screen.findByText("true");
  });

  it("resolves to true once the probe confirms the day has Entries", async () => {
    const probe = vi.fn(async () => true);

    renderHarness(probe, "2026-08-28");

    await screen.findByText("true");
    expect(probe).toHaveBeenCalledWith("2026-08-28");
  });

  it("resolves to false for a day the probe reports empty", async () => {
    const probe = vi.fn(async () => false);

    renderHarness(probe, "2026-08-28");

    await screen.findByText("false");
  });

  // The property use-day-has-entries.ts exists for: however many Reference
  // occurrences resolve the same day at once, the probe runs once, not once
  // per occurrence — TanStack Query's cache, keyed on the day alone
  // (dayHasEntriesQueryKey), is what makes that true.
  it("probes a given day at most once, sharing the answer across every call site for it", async () => {
    const probe = vi.fn(async () => true);
    const queryClient = new QueryClient();

    function TwoOccurrences() {
      const a = useDayHasEntries(probe, "2026-08-28");
      const b = useDayHasEntries(probe, "2026-08-28");
      return (
        <p data-testid="result">
          {String(a)}-{String(b)}
        </p>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TwoOccurrences />
      </QueryClientProvider>,
    );

    await screen.findByText("true-true");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("probes two distinct days separately, each with its own answer", async () => {
    const probe = vi.fn(async (dayKey: string) => dayKey === "2026-08-28");
    const queryClient = new QueryClient();

    function TwoDays() {
      const withEntries = useDayHasEntries(probe, "2026-08-28");
      const empty = useDayHasEntries(probe, "2020-01-01");
      return (
        <p data-testid="result">
          {String(withEntries)}-{String(empty)}
        </p>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TwoDays />
      </QueryClientProvider>,
    );

    await screen.findByText("true-false");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  // `EntryStoreOutletContext.dayHasEntries` is optional (entry-store-
  // layout.tsx's own comment on why) — every page that builds that context
  // with no reason to know about a date Reference simply omits it, and this
  // hook has to treat that the same as "still resolving," not throw or
  // silently call something that doesn't exist.
  it("never calls a probe that isn't there, and stays undefined", () => {
    const queryClient = new QueryClient();

    function NoProbe() {
      const result = useDayHasEntries(undefined, "2026-08-28");
      return <p data-testid="result">{String(result)}</p>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <NoProbe />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("result")).toHaveTextContent("undefined");
  });
});
