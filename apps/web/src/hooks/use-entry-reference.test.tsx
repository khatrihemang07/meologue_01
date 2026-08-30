import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEntryReference } from "./use-entry-reference";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "0192abcd-1234-7890-abcd-0123456789ab",
    deviceId: "device-a",
    body: "the target Entry's body",
    createdAt: "2026-08-18T10:00:00.000Z",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

function Harness({
  probe,
  entryId,
}: {
  probe: ((entryId: string) => Promise<Entry | undefined>) | undefined;
  entryId: string;
}) {
  const target = useEntryReference(probe, entryId);
  return <p data-testid="result">{target === undefined ? "undefined" : target.body}</p>;
}

function renderHarness(
  probe: ((entryId: string) => Promise<Entry | undefined>) | undefined,
  entryId: string,
) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness probe={probe} entryId={entryId} />
    </QueryClientProvider>,
  );
}

describe("useEntryReference", () => {
  it("returns undefined while the probe is still resolving", async () => {
    let resolve!: (value: Entry | undefined) => void;
    const probe = vi.fn(
      () =>
        new Promise<Entry | undefined>((res) => {
          resolve = res;
        }),
    );

    renderHarness(probe, "target-1");

    expect(screen.getByTestId("result")).toHaveTextContent("undefined");
    resolve(entry());
    await screen.findByText("the target Entry's body");
  });

  it("resolves to the Entry once the probe finds it", async () => {
    const target = entry();
    const probe = vi.fn(async () => target);

    renderHarness(probe, target.id);

    await screen.findByText("the target Entry's body");
    expect(probe).toHaveBeenCalledWith(target.id);
  });

  // A TanStack Query queryFn is not allowed to resolve to `undefined` (v5
  // treats that as a bug, not a value) — this hook's own `null` sentinel
  // (its file's doc comment) is what lets `probe` legitimately answer
  // "nothing to find" — a removed Entry, or one that hasn't Synced to this
  // Device yet — without that turning into a thrown error instead of a
  // cached, unresolved answer.
  it("resolves to undefined for a target the probe reports it cannot find", async () => {
    const probe = vi.fn(async () => undefined);

    renderHarness(probe, "gone");

    await screen.findByText("undefined");
    expect(probe).toHaveBeenCalledWith("gone");
  });

  // The property use-entry-reference.ts exists for: however many chips
  // resolve the same target Entry at once, the probe runs once, not once
  // per chip — TanStack Query's cache, keyed on the target's id alone
  // (entryReferenceQueryKey), is what makes that true.
  it("probes a given Entry at most once, sharing the answer across every call site for it", async () => {
    const target = entry();
    const probe = vi.fn(async () => target);
    const queryClient = new QueryClient();

    function TwoOccurrences() {
      const a = useEntryReference(probe, target.id);
      const b = useEntryReference(probe, target.id);
      return (
        <p data-testid="result">
          {a?.body ?? "undefined"}-{b?.body ?? "undefined"}
        </p>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TwoOccurrences />
      </QueryClientProvider>,
    );

    await screen.findByText("the target Entry's body-the target Entry's body");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("probes two distinct Entries separately, each with its own answer", async () => {
    const targetA = entry({ id: "a", body: "entry a" });
    const targetB = entry({ id: "b", body: "entry b" });
    const probe = vi.fn(async (entryId: string) => (entryId === "a" ? targetA : targetB));
    const queryClient = new QueryClient();

    function TwoTargets() {
      const a = useEntryReference(probe, "a");
      const b = useEntryReference(probe, "b");
      return (
        <p data-testid="result">
          {a?.body ?? "undefined"}-{b?.body ?? "undefined"}
        </p>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TwoTargets />
      </QueryClientProvider>,
    );

    await screen.findByText("entry a-entry b");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  // `EntryStoreOutletContext.getEntry` is optional (entry-store-layout.tsx's
  // own comment on why) — every page that builds that context with no
  // reason to know an Entry Reference exists simply omits it, and this hook
  // has to treat that the same as "still resolving," not throw or silently
  // call something that doesn't exist.
  it("never calls a probe that isn't there, and stays undefined", () => {
    const queryClient = new QueryClient();

    function NoProbe() {
      const result = useEntryReference(undefined, "target-1");
      return <p data-testid="result">{result === undefined ? "undefined" : result.body}</p>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <NoProbe />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("result")).toHaveTextContent("undefined");
  });
});
