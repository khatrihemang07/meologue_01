import { useQuery } from "@tanstack/react-query";

/**
 * The shape every Reference probe shares (ADR 0042).
 *
 * Resolving a Reference means asking the store a small question — does this
 * day hold any Entry, what Refers to this day, which Entry is this — and
 * rendering the mark as its own literal text until an answer arrives. Three
 * hooks needed exactly that, and each had written out the same `useQuery`
 * skeleton: cache per argument, stay disabled while the probe is unavailable,
 * and hand back `undefined` for "not answered yet".
 *
 * The probe is optional because the store layout supplies it only once the
 * store is open (ADR 0008/0009 keep a Destination rendering beside a store
 * that never opened), so "no probe" and "no answer yet" are the same thing to
 * a caller: render the literal text.
 */
export function useProbeQuery<Argument, Answer>(
  probe: ((argument: Argument) => Promise<Answer>) | undefined,
  queryKey: readonly unknown[],
  argument: Argument,
  /**
   * What the query resolves to when there is no probe. Never actually
   * observed — `enabled` is false in that case, so TanStack Query does not
   * invoke `queryFn` at all — but `queryFn`'s own return type has to be
   * inhabited for the narrowing below.
   *
   * It must not be `undefined`: TanStack Query v5 treats a `queryFn`
   * resolving to `undefined` as a bug and throws rather than caching it,
   * because `undefined` is already its own signal for "no data yet". A caller
   * whose answer is genuinely nullable folds it through `null` instead.
   */
  whenUnavailable: Answer,
): Answer | undefined {
  const query = useQuery({
    queryKey,
    queryFn: () => (probe === undefined ? Promise.resolve(whenUnavailable) : probe(argument)),
    enabled: probe !== undefined,
  });
  return query.data;
}
