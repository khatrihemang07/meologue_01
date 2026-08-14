import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useEntryStore as UseEntryStore } from "./entry-store-layout";

const { createDriver } = vi.hoisted(() => ({ createDriver: vi.fn() }));
vi.mock("@/platform/sqlite-driver", () => ({ createDriver }));

// entryStorePromise is memoized at module scope by design (ADR 0001) — a
// Device opens its store exactly once. Each test here needs a fresh module
// instance, or the second test would just observe the first test's
// already-settled promise. Both modules are re-imported together so the
// StorageUnavailableError instance and entry-store-layout's own `instanceof`
// check come from the same fresh module registry.
async function importFresh() {
  vi.resetModules();
  const [layout, errors] = await Promise.all([
    import("./entry-store-layout"),
    import("@/lib/entry-store-errors"),
  ]);
  return { ...layout, ...errors };
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
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<fresh.EntryStoreLayout />}>
          <Route path="/" element={<Probe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  return fresh;
}

describe("EntryStoreLayout", () => {
  beforeEach(() => {
    createDriver.mockReset();
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
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<fresh.EntryStoreLayout />}>
            <Route path="/" element={<Probe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "disabled:true message:meologue can't store Entries here — try a non-private window over HTTPS or localhost.",
        ),
      ).toBeInTheDocument(),
    );
  });
});
