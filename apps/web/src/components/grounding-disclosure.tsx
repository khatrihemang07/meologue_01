/**
 * A per-turn expander (ticket 7) showing the Entries an Answer was actually
 * built from — the only way to tell a confident wrong Answer from a right
 * one by eye, since the two read identically otherwise. Collapsed by
 * default behind a native <details>/<summary>: keyboard-accessible and
 * screen-reader-correct with no state to manage, and the repo has no
 * collapsible primitive of its own to reach for instead.
 *
 * `grounded` is what the summary label keys off, per ADR 0024 — not whether
 * `groundingEntryIds` is empty, since both the real-Grounding case and the
 * disclosed-fallback case can be non-empty. Getting this backwards would
 * label a fallback as Grounding, which is exactly the falsehood CONTEXT.md's
 * Grounding entry forbids ("a Reflection that invents a past the user did
 * not live").
 */
import { EntryRow } from "@/components/entry-row";
import { useEntryStore } from "@/pages/entry-store-layout";

interface GroundingDisclosureProps {
  /** The Entry ids the server returned for this turn, in server (chronological) order — see ConversationTurn.groundingEntryIds. */
  groundingEntryIds: string[];
  /** Whether the server judged this turn's Grounding actually answers the Question — see ConversationTurn.grounded. */
  grounded: boolean;
  /** Whether these ids are the disclosed fallback (last few days) rather than judged Grounding — see ConversationTurn.fallbackUsed. */
  fallbackUsed: boolean;
  syncEnabled: boolean;
}

function summaryLabel(count: number, grounded: boolean, fallbackUsed: boolean): string {
  const noun = count === 1 ? "Entry" : "Entries";
  if (grounded) {
    return `Grounded in ${count} ${noun}`;
  }
  if (fallbackUsed) {
    // ADR 0024: these ids are the last few days of Entries, not Grounding
    // the server judged relevant — label them as recent Entries, never as
    // Grounding.
    return `${count} recent ${noun}`;
  }
  // Defensive only: ADR 0024 leaves `groundingEntryIds` empty whenever
  // `grounded` and `fallbackUsed` are both false (an empty fallback window
  // spends no extra call, so there's nothing to disclose), and this
  // function already isn't called in that case (see the empty-ids guard
  // below). If it's ever reached anyway, the recent-Entries wording is
  // still the only safe choice — it must never say "Grounded" once
  // `grounded` is false.
  return `${count} recent ${noun}`;
}

export function GroundingDisclosure({
  groundingEntryIds,
  grounded,
  fallbackUsed,
  syncEnabled,
}: GroundingDisclosureProps) {
  // The Device's own Entry store, not a fetch — Entry ids are minted on the
  // creating Device and preserved through Sync, so this Device's local copy
  // (if it has one yet) is the same Entry the server meant. `/reflect` is a
  // child of EntryStoreLayout (app.tsx), so this hook is always satisfied
  // wherever this component actually renders.
  const { entries } = useEntryStore();

  if (groundingEntryIds.length === 0) {
    return null;
  }

  return (
    <details className="mr-auto max-w-[85%] text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        {summaryLabel(groundingEntryIds.length, grounded, fallbackUsed)}
      </summary>
      <div className="mt-1 divide-y divide-border rounded-md border border-border px-2">
        {groundingEntryIds.map((id) => {
          const entry = entries.find((candidate) => candidate.id === id);
          return (
            <div key={id}>
              {entry ? (
                // No search query of its own (EntryRow's query defaults to
                // "") — Reflection has no Search query to highlight against.
                <EntryRow entry={entry} syncEnabled={syncEnabled} />
              ) : (
                // Sync can be behind, and a Device can hold less than the
                // Server does (CONTEXT.md: History). An id with no local
                // Entry is disclosed, not silently dropped — dropping it
                // would make the count above lie about what's shown.
                <p className="py-1.5 text-xs italic text-muted-foreground">
                  This Entry hasn't reached this Device yet.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
