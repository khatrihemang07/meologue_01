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
 * `reflection-page.tsx` batches every Grounding id across the whole
 * Conversation into a single `getEntries` lookup (EntryStoreOutletContext,
 * per EntryStore.getMany) and passes the *result* down as `entries`, rather
 * than this component reading the store itself — and, since issue #79,
 * rather than the page handing this component the whole (paginated) local
 * `entries` array to scan. `entries` here is deliberately not "every Entry
 * this Device has": it's exactly the Entries the page already resolved for
 * this Conversation's Grounding ids, so `find` below only ever has to
 * search a small, relevant set.
 *
 * `groundingOutcome(turn)` is what the summary label keys off, per ADR
 * 0024 — not whether `groundingEntryIds` is empty, since both the real-
 * Grounding case and the disclosed-fallback case can be non-empty. Getting
 * this backwards would label a fallback as Grounding, which is exactly the
 * falsehood CONTEXT.md's Grounding entry forbids ("a Reflection that
 * invents a past the user did not live").
 *
 * Issue #96: `groundingOutcome` can also come back `"digest"` now, read off
 * `turn.digestSource` — set only for a turn this browser session just
 * watched a `read_digest` tool call surface a real Digest for, from the
 * live `tool_execution_end` event's own `details`
 * (`reflect-live-run.ts::applyReflectEvent`), not from a separate batched
 * `getEntries` lookup the way the Entries case below still is. Before this,
 * a Digest-only Answer left `groundingEntryIds` empty (`read_digest`
 * deliberately populates no `entry_ids` — a Digest's Grounding belongs to
 * the Digest, not to this one tool call) and this component returned
 * `null`: the user saw an Answer with no disclosure at all, indistinguishable
 * from one this component had nothing to say about. This is what makes "an
 * Answer drawn from a Digest" a distinct, honest thing the interface says,
 * rather than silence — see the digest branch in the render below.
 */
import type { Entry } from "@meologue/core";
import { EntryRow } from "@/components/entry-row";
import { type ConversationTurn, groundingOutcome } from "@/lib/conversation";

interface GroundingDisclosureProps {
  /** The completed turn to disclose Grounding for — carries `groundingEntryIds`, `grounded` and `fallbackUsed` together, rather than unbundling them into three separate props. */
  turn: ConversationTurn;
  /** The Grounding Entries the page already resolved for this Conversation (`getEntries`, issue #79's regression fix) — see the module comment for why this is not this Device's whole local `entries`. */
  entries: Entry[];
  /**
   * Whether the page's Grounding lookup is still in flight. While true, an
   * id with no matching Entry in `entries` yet renders a neutral loading
   * placeholder instead of "This Entry hasn't reached this Device yet" —
   * that message is only honest once the lookup has actually settled and
   * still found nothing, per CONTEXT.md's Grounding honesty rule. Before
   * issue #79, `entries` was always the whole local store already in hand
   * synchronously, so there was no in-between moment for this to matter;
   * a fetched-by-id lookup has one.
   */
  loading: boolean;
  syncEnabled: boolean;
}

function summaryLabel(count: number, outcome: ReturnType<typeof groundingOutcome>): string {
  const noun = count === 1 ? "Entry" : "Entries";
  if (outcome === "grounded") {
    return `Grounded in ${count} ${noun}`;
  }
  // Every remaining outcome that reaches this function ("disclosedFallback"
  // and the defensive "nothingFound"/"digest" below) shares this wording:
  // ADR 0024's fallback ids are the last few days of Entries, not Grounding
  // the server judged relevant, and this must never say "Grounded" once
  // `grounded` is false. "nothingFound" and "digest" can't actually reach
  // this function in practice — the guards in the render below return
  // before it's ever called for either — but the wording stays correct
  // regardless, since a defensive branch that lies about what it would say
  // is worse than a redundant one.
  return `${count} recent ${noun}`;
}

/** The period label a Digest-sourced disclosure shows — "day"/"week"/"month" plus its date range, collapsed to one date when the Digest is a single day. */
function digestRangeLabel(source: NonNullable<ConversationTurn["digestSource"]>): string {
  return source.periodStart === source.periodEnd
    ? source.periodStart
    : `${source.periodStart} to ${source.periodEnd}`;
}

export function GroundingDisclosure({
  turn,
  entries,
  loading,
  syncEnabled,
}: GroundingDisclosureProps) {
  const { groundingEntryIds, digestSource } = turn;
  const outcome = groundingOutcome(turn);

  // A Digest is a written summary, not a set of Entries — there is nothing
  // to expand into a list of rows, so this renders as a plain caption
  // (matching GroundingNote's own styling just above it in
  // reflection-page.tsx) rather than a <details>/<summary> with nothing
  // underneath it. `groundingEntryIds` is irrelevant here: a Digest-only
  // Answer usually has none at all (see this module's own doc comment).
  if (outcome === "digest" && digestSource !== undefined) {
    return (
      <p className="mr-auto max-w-[85%] text-xs text-muted-foreground">
        Answered from the {digestSource.period} Digest for {digestRangeLabel(digestSource)}.
      </p>
    );
  }

  if (groundingEntryIds.length === 0) {
    return null;
  }

  return (
    <details className="mr-auto max-w-[85%] text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        {summaryLabel(groundingEntryIds.length, outcome)}
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
              ) : loading ? (
                // The page's lookup hasn't settled yet — see `loading`'s own
                // doc comment for why this can't just fall through to the
                // "hasn't reached this Device yet" branch below.
                <p className="py-1.5 text-xs italic text-muted-foreground">Loading…</p>
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
