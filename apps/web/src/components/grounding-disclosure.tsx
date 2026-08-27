/**
 * A per-turn expander (ticket 7) showing the Entries a tool call returned
 * and the model read while answering — the only way to see what was behind
 * an Answer by eye, since a confident wrong Answer and a right one
 * otherwise read identically. Collapsed by default behind a native
 * <details>/<summary>: keyboard-accessible and screen-reader-correct with
 * no state to manage, and the repo has no collapsible primitive of its own
 * to reach for instead.
 *
 * Deliberately does *not* claim these Entries are what the Answer was
 * "actually built from" (carry-over #2 on issue #99 — see `summaryLabel`'s
 * own doc comment for the live contradiction that wording produced): the
 * Server cannot know that under the loop, only that a tool call returned
 * them and the model had them in its own context. What the Answer actually
 * rests on is left to the Answer's own words.
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
 * `groundingOutcome(turn)` is what the render below branches on — a Digest
 * gets its own caption (no Entries to expand into a list), an empty
 * `groundingEntryIds` renders nothing at all, and anything else is a real
 * list of Entries the tools returned. Issue #99 removed the one case that
 * used to make this more than a length check on `groundingEntryIds` — the
 * fixed pipeline's disclosed fallback, which could carry a non-empty
 * `groundingEntryIds` under a `grounded: false` verdict, and needed
 * `groundingOutcome` to tell that apart from real Grounding rather than
 * label it "Grounded". The loop has no such fallback; every non-empty
 * `groundingEntryIds` this component sees now really is what the tools
 * returned.
 *
 * Issue #96: `groundingOutcome` can also come back `"digest"`, read off
 * `turn.digestSource` — computed once, server-side, by
 * `sessions::DigestSourceTracker` (`server/src/reflect.rs::run_reflect_stream_inner`)
 * and carried on the wire the same way for both a turn this browser session
 * just watched answered (`ReflectResponse.digest_source`) and one restored
 * from a fetched Session (`WireSessionTurn.digest_source`) — see
 * `conversation.ts::conversationTurnFromWire`. Before issue #96, a
 * Digest-only Answer left `groundingEntryIds` empty (`read_digest`
 * deliberately populates no `entry_ids` — a Digest's Grounding belongs to
 * the Digest, not to this one tool call) and this component returned
 * `null`: the user saw an Answer with no disclosure at all, indistinguishable
 * from one this component had nothing to say about. This is what makes "an
 * Answer drawn from a Digest" a distinct, honest thing the interface says,
 * rather than silence — see the digest branch in the render below.
 *
 * Issue #105: `digestSource` itself used to be looser than this — set the
 * moment *any* `read_digest` call in a run found something, even if the
 * Answer that followed was actually built from an unrelated tool's Entries
 * instead. This component trusts `digestSource` outright (the check below
 * is only ever "is it set," never a re-derivation), which is exactly why
 * that laxness was a bug: the fix is entirely upstream, in what the Server
 * puts on the wire in the first place — see `DigestSourceTracker`'s own
 * doc comment for the rule.
 */
import type { Entry } from "@meologue/core";
import { EntryRow } from "@/components/entry-row";
import { type ConversationTurn, groundingOutcome } from "@/lib/conversation";

interface GroundingDisclosureProps {
  /** The completed turn to disclose Grounding for — carries `groundingEntryIds`, `toolCalled` and `digestSource` together, rather than unbundling them into three separate props. */
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

/**
 * "N Entries returned" is the only wording this ever produces — the one
 * outcome `groundingOutcome` can return with a non-empty `groundingEntryIds`
 * (`"neverLooked"`/`"nothingFound"` both require it empty by construction,
 * and `"digest"` is handled by its own branch in the render below, before
 * this is ever called). No `outcome` parameter to switch on: issue #99
 * removed the one case (the fixed pipeline's disclosed fallback) that used
 * to make this anything but a length check — see this module's own doc
 * comment.
 *
 * Deliberately not "Grounded in N Entries" any more (carry-over #2 on issue
 * #99, caught live on the Sandbox): CONTEXT.md's Grounding entry defines
 * Grounding as the Entries an Answer was *actually built from* — a claim
 * this component has no way to verify under the loop. `groundingEntryIds`
 * is simply what a tool call returned and the model read; since issue #92
 * removed the similarity floor, `similar_entries` returns its top-k for
 * every Question, including one about a topic absent from the journal, so
 * a non-empty list here is now the *common* case, not evidence the Answer
 * used any of it. Observed live: "What did I think of the football match?"
 * correctly answered "I couldn't find a journal entry about a football
 * match..." while this label still said "Grounded in 10 Entries" directly
 * beneath it — asserting a relationship between the Answer and those
 * Entries that the Server cannot actually know. "N Entries returned"
 * states only the fact this component does know: a tool call found this
 * many and the model saw them. Whether the Answer actually rests on any of
 * them is left to the Answer's own words, exactly as CONTEXT.md's
 * don't-invent rule already asks of everything else here.
 */
function summaryLabel(count: number): string {
  const noun = count === 1 ? "Entry" : "Entries";
  return `${count} ${noun} returned`;
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
        {summaryLabel(groundingEntryIds.length)}
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
