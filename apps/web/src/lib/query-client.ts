import { SYNC_INTERVAL_MS } from "@meologue/core";
import { QueryClient } from "@tanstack/react-query";

// One instance for the whole app (ADR superseding 0009): provided above the
// router in main.tsx, so it survives every route including Settings, and
// imported directly here by module-scope code (use-history.ts's continuous
// sync loop, entry-store-layout.tsx's queryFn) that runs outside any
// component's lifecycle and so has no React context to read it from.
export const queryClient = new QueryClient({
  defaultOptions: {
    // Every query and mutation in this app reads or writes the local Entry
    // store (ADR 0001 — local-first) — opening it, listing it, upserting a
    // Sent Entry. None of that needs network, but TanStack Query's default
    // `networkMode: "online"` pauses queries and mutations alike whenever
    // the browser reports itself offline, on the assumption that every
    // fetch needs a connection. Left at the default, sending an Entry while
    // offline would silently stall instead of writing locally, defeating
    // the entire point of local-first. The one operation that genuinely
    // needs network — `sync()` — isn't itself a query or mutation (it's a
    // plain async call inside use-history.ts's sync loop), so it isn't
    // affected by this and still fails/retries normally when offline.
    queries: {
      networkMode: "always",
      // Before issue #79 there was no `staleTime`, so every query was
      // stale the instant it resolved and `refetchOnWindowFocus` (default
      // true) ran on every focus. That was harmless while History was one
      // small list; it stopped being harmless once History became a
      // paginated useInfiniteQuery (use-history.ts).
      //
      // SYNC_INTERVAL_MS is reused rather than a new made-up number: it is
      // already this app's answer to "how fresh does local data need to
      // stay", applied here to a different trigger (focus) than the one it
      // usually governs (the timer in use-sync-loop.ts).
      //
      // This alone was not enough for the Entries query — any absence
      // longer than the staleTime still refetches every held page — so
      // that query turns `refetchOnWindowFocus` off outright and leans on
      // the sync loop's own bounded refresh instead. See its own comment.
      staleTime: SYNC_INTERVAL_MS,
    },
    mutations: { networkMode: "always" },
  },
});
