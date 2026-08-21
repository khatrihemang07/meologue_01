import type { EntryStore } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useEntryStore as UseEntryStore } from "./entry-store-layout";

const { createDriver } = vi.hoisted(() => ({ createDriver: vi.fn() }));
vi.mock("@/platform/sqlite-driver", () => ({ createDriver }));

// Stubs @meologue/core's real `open` (which needs a real SqliteDriver to run
// migrations against) so the success-path test below can resolve
// openEntryStore() with a plain in-memory fake.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return { ...actual, open: openMock };
});

function createFakeStore(): EntryStore {
  return {
    list: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

// The Entry store's query is cached at module scope by design (ADR
// superseding 0009) — a Device opens its store exactly once. Each test here
// needs a fresh module registry (so the query-client singleton is a fresh
// QueryClient, with nothing cached from a previous test) and a fresh
// QueryClientProvider bound to that same singleton, or the second test would
// just observe the first test's already-settled query. All three modules
// are re-imported together so the StorageUnavailableError instance and
// entry-store-layout's own `instanceof` check come from the same fresh
// module registry.
async function importFresh() {
  vi.resetModules();
  const [layout, errors, client] = await Promise.all([
    import("./entry-store-layout"),
    import("@/lib/entry-store-errors"),
    import("@/lib/query-client"),
  ]);
  return { ...layout, ...errors, ...client };
}

// Probe is declared once at module scope, satisfying biome's
// useHookAtTopLevel (it flags a fresh function-component-per-test as a
// nested component). Which useEntryStore it calls changes every test, so it
// reads a module-level binding set by renderLayout just before rendering,
// rather than closing over one directly.
let activeUseEntryStore: typeof UseEntryStore;

function Probe() {
  const { disabled, message } = activeUseEntryStore();
  return <p>{`disabled:${disabled} message:${message ?? "none"}`}</p>;
}

async function renderLayout() {
  const fresh = await importFresh();
  activeUseEntryStore = fresh.useEntryStore;

  render(
    <QueryClientProvider client={fresh.queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<fresh.EntryStoreLayout />}>
            <Route path="/" element={<Probe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return fresh;
}

describe("EntryStoreLayout", () => {
  beforeEach(() => {
    createDriver.mockReset();
    openMock.mockReset();
  });

  it("puts a disabled, message-free context on the outlet while the store is opening", async () => {
    createDriver.mockReturnValue(new Promise(() => {}));

    await renderLayout();

    expect(screen.getByText("disabled:true message:none")).toBeInTheDocument();
  });

  it("puts a disabled context with an explicit message on the outlet once opening fails", async () => {
    const fresh = await importFresh();
    // Pre-attached so Node doesn't flag this as an unhandled rejection in
    // the window before EntryStoreLayout's own .then() catches it.
    const rejection = Promise.reject(new fresh.StorageUnavailableError());
    rejection.catch(() => {});
    createDriver.mockReturnValue(rejection);
    activeUseEntryStore = fresh.useEntryStore;

    render(
      <QueryClientProvider client={fresh.queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<fresh.EntryStoreLayout />}>
              <Route path="/" element={<Probe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "disabled:true message:meologue can't store Entries here — try a non-private window over HTTPS or localhost.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("renders Ready once the store opens", async () => {
    createDriver.mockResolvedValue({});
    const store = createFakeStore();
    openMock.mockResolvedValue({ store, deviceId: "device-a" });

    await renderLayout();

    await waitFor(() =>
      expect(screen.getByText("disabled:false message:none")).toBeInTheDocument(),
    );
  });

  // TanStack Query's `retry: false` only governs retries within one fetch
  // attempt — a *new* observer of an already-errored query still refetches
  // on mount by default (`retryOnMount: true`). Without `retryOnMount:
  // false` on this query, this exact round trip reopens the store a second
  // time, spinning up a second Worker against the same OPFS pool lock.
  it("does not reopen the store on a Settings round trip after a failed open", async () => {
    const fresh = await importFresh();
    createDriver.mockRejectedValue(new fresh.StorageUnavailableError());
    activeUseEntryStore = fresh.useEntryStore;

    function renderOnce() {
      return render(
        <QueryClientProvider client={fresh.queryClient}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<fresh.EntryStoreLayout />}>
                <Route path="/" element={<Probe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    const first = renderOnce();
    await waitFor(() => expect(createDriver).toHaveBeenCalledTimes(1));
    first.unmount();

    renderOnce();
    await waitFor(() => expect(screen.getByText(/disabled:true/)).toBeInTheDocument());
    expect(createDriver).toHaveBeenCalledTimes(1);
  });
});
