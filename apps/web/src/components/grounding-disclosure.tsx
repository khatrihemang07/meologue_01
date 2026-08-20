/**
 * A per-turn expander (ticket 7) showing the Entries an Answer was actually
 * built from — the only way to tell a confident wrong Answer from a right
 * one by eye, since the two read identically otherwise. Collapsed by
 * default behind a native <details>/<summary>: keyboard-accessible and
 * screen-reader-correct with no state to manage, and the repo has no
 * collapsible primitive of its own to reach for instead.
 *
 * Pure, like every other component under `components/` (`history.tsx` is
 * the repo's own precedent): pages own data access, components take props.
 * `reflection-page.tsx` calls `useEntryStore()` once and passes `entries`
 * down, rather than this component calling it once per rendered turn.
 *
 * `groundingOutcome(turn)` is what the summary label keys off, per ADR
 * 0024 — not whether `groundingEntryIds` is empty, since both the real-
 * Grounding case and the disclosed-fallback case can be non-empty. Getting
 * this backwards would label a fallback as Grounding, which is exactly the
 * falsehood CONTEXT.md's Grounding entry forbids ("a Reflection that
 * invents a past the user did not live").
 */
import type { Entry } from "@meologue/core";
import { EntryRow } from "@/components/entry-row";
import { type ConversationTurn, groundingOutcome } from "@/lib/conversation";

interface GroundingDisclosureProps {
  /** The completed turn to disclose Grounding for — carries `groundingEntryIds`, `grounded` and `fallbackUsed` together, rather than unbundling them into three separate props. */
  turn: ConversationTurn;
  /** This Device's own Entries, from the page's single `useEntryStore()` call — see the module comment. */
  entries: Entry[];
  syncEnabled: boolean;
}

function summaryLabel(count: number, outcome: ReturnType<typeof groundingOutcome>): string {
  const noun = count === 1 ? "Entry" : "Entries";
  if (outcome === "grounded") {
    return `Grounded in ${count} ${noun}`;
  }
  // Both remaining outcomes ("disclosedFallback" and the defensive
  // "nothingFound" below) share this wording: ADR 0024's fallback ids are
  // the last few days of Entries, not Grounding the server judged
  // relevant, and this must never say "Grounded" once `grounded` is false.
  // "nothingFound" can't actually reach this function — the empty-ids guard
  // below returns before `summaryLabel` is ever called for it — but the
  // wording stays correct regardless, since a defensive branch that lies
  // about what it would say is worse than a redundant one.
  return `${count} recent ${noun}`;
}

export function GroundingDisclosure({ turn, entries, syncEnabled }: GroundingDisclosureProps) {
  const { groundingEntryIds } = turn;

  if (groundingEntryIds.length === 0) {
    return null;
  }

  return (
    <details className="mr-auto max-w-[85%] text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        {summaryLabel(groundingEntryIds.length, groundingOutcome(turn))}
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
