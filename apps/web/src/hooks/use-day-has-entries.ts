import { useProbeQuery } from "@/hooks/use-probe-query";
import { dayHasEntriesQueryKey } from "@/lib/query-keys";

/**
 * Whether `dayKey` holds at least one live Entry (issue #142) — the
 * question a date Reference has to settle before it can render as a link at
 * all (day-has-entries.ts's own `dayHasEntries`, which `probe` wraps —
 * `EntryStoreOutletContext.dayHasEntries`, entry-store-layout.tsx, is the
 * one real implementation).
 *
 * Takes the probe as a plain async function rather than an `EntryStore`
 * itself: this hook has no business knowing the store's shape, only that
 * something can answer "does this day have anything?" — the same
 * arm's-length relationship `groundingEntriesQueryKey`'s own caller
 * (reflection-page.tsx) has with `getEntries`. That also keeps this hook
 * testable with a bare stub function, no store fake required.
 *
 * Keyed on the day alone (`dayHasEntriesQueryKey`), so every Reference to
 * the same day — however many of them appear across History or Grounding —
 * shares one TanStack Query cache entry and `probe` is called at most once
 * per distinct day, not once per occurrence, regardless of how many
 * `useDayHasEntries` call sites are mounted for it at once.
 *
 * `probe` undefined disables the query outright rather than throwing —
 * `EntryStoreOutletContext.dayHasEntries` is itself optional (most of that
 * context's own callers have no reason to supply it), and "cannot resolve
 * this Reference" is exactly the same outcome as "resolution is still in
 * flight" from this hook's own return type: both leave the Reference
 * rendering as its literal text.
 *
 * Returns `undefined` while the answer is still in flight or disabled —
 * deliberately, not merely "loading": inline-prose.tsx's contract is that
 * an unresolved Reference renders as its literal text, upgrading to a link
 * only once something can actually resolve it, the same rule a removed
 * Entry and a malformed mark already follow. Treating "unknown" as "false"
 * here would flash every date Reference as plain text before quietly
 * turning some of them into links, which reads as the page changing under
 * the reader rather than as content resolving.
 */
export function useDayHasEntries(
  probe: ((dayKey: string) => Promise<boolean>) | undefined,
  dayKey: string,
): boolean | undefined {
  return useProbeQuery(probe, dayHasEntriesQueryKey(dayKey), dayKey, false);
}
