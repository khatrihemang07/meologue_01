import type { Entry } from "@meologue/core";
import { PROTOCOL_VERSION } from "@meologue/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { Bubble } from "@/components/entry-bubble";
import { GroundingDisclosure } from "@/components/grounding-disclosure";
import { inlineProse } from "@/components/inline-prose";
import { QuestionComposer } from "@/components/question-composer";
import { NewSessionLink, SessionsLink } from "@/components/reflect-actions";
import { ServerUnreachableBanner } from "@/components/server-unreachable-banner";
import { Shell } from "@/components/shell";
import {
  type ConversationTurn,
  conversationTurnFromWire,
  groundingOutcome,
} from "@/lib/conversation";
import { deviceUtcOffsetMinutes } from "@/lib/entry-day";
import { clearLastSessionId, readLastSessionId, writeLastSessionId } from "@/lib/last-session";
import { modelsTransport } from "@/lib/models-transport";
import { groundingEntriesQueryKey, MODELS_QUERY_KEY } from "@/lib/query-keys";
import { applyReflectEvent, initialLiveRunState, type LiveRunState } from "@/lib/reflect-live-run";
import { reflectTransport } from "@/lib/reflect-transport";
import { type SessionResult, sessionsTransport } from "@/lib/sessions-transport";
import { refreshCapabilities, useServerReachable, useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

/**
 * What this page keeps of a fetched Session, once mapped off the wire — the
 * `SessionResult` union re-shaped so a successful fetch carries exactly
 * what this page renders (`title` is fetched but not currently shown; kept
 * for a future page title without a second round trip) rather than the raw
 * `WireSessionResponse`. Living here, not in `lib/sessions-transport.ts`,
 * because "what the query cache holds" is this page's own concern — the
 * transport's job ends at handing back the wire shape.
 */
type SessionQueryData =
  | { ok: true; snapshot: { title: string; turns: ConversationTurn[] } }
  | { ok: false; reason: "not-found" | "unreachable" };

function sessionQueryKey(sessionId: string) {
  return ["session", sessionId] as const;
}

async function fetchSession(sessionId: string): Promise<SessionQueryData> {
  const result: SessionResult = await sessionsTransport(sessionId);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    snapshot: {
      title: result.session.title,
      // `digestSource` for a restored turn comes straight off the wire
      // (`WireSessionTurn.digest_source`) — see `conversationTurnFromWire`'s
      // own doc comment.
      turns: result.session.turns.map((turn) => conversationTurnFromWire(turn)),
    },
  };
}

// A Question and its Answer render through the same `Bubble` Composer's
// Entries do (ADR 0036). None of the three is the same *thing* — CONTEXT.md
// is explicit that a Question is not an Entry and an Answer is not an Entry
// — but they are the same shape in a thread, and keeping two hand-written
// copies of that shape is how the two destinations start disagreeing about
// what "outgoing" looks like.
//
// This is also where the side asymmetry earns its keep most: Reflect is the
// genuinely two-sided destination, and before it a Question and its Answer
// were told apart by a saturated fill on one of them alone.
// Issue #140: the one place an Answer's prose turns into rendered content.
// Both the settled Answer (`GivenAnswer`, below) and the still-streaming one
// (`LiveRunView`) call this rather than interpolating their own string —
// before this they were two separate elements rendering the same prose,
// so formatting one and not the other would have made the text visibly
// reflow the instant streaming ended. Each keeps its own outer element
// (a `Bubble` for the settled Answer, a positioned `<p>` while streaming,
// since the two sit in different layouts) — only the prose *inside* that
// element is shared, which is the part that has to agree.
function answerProse(text: string): ReactNode {
  return inlineProse(text);
}

// Neither the Question nor the Answer has a Search query to highlight (that
// only ever applies to an Entry read back through History), so both call
// `inlineProse`/`answerProse` with no query.
function AskedQuestion({ text }: { text: string }) {
  return (
    <Bubble side="out" groupedWithPrevious>
      {inlineProse(text)}
    </Bubble>
  );
}

function GivenAnswer({ text }: { text: string }) {
  return (
    <Bubble side="in" className="whitespace-pre-wrap">
      {answerProse(text)}
    </Bubble>
  );
}

// An explicit note per turn, independent of the Answer's own wording — the
// point of ticket 6 (docs/adr/0024) is that the user can tell a real Answer
// from a confident wrong one without trusting how the model phrased itself.
// "grounded" (the tools returned at least one Entry) renders no note at
// all; the other outcomes each render a short caption in CONTEXT.md's own
// vocabulary (History, Question, Entries), matching the muted-caption
// styling already used elsewhere on this page. The outcome itself comes
// from `groundingOutcome` (lib/conversation.ts) — shared with
// grounding-disclosure.tsx's `summaryLabel` so the caption here and the
// expander label below it can never disagree about what happened.
//
// Issue #103: "neverLooked" gets its own caption, distinct from
// "nothingFound" — before `toolCalled` existed on the wire, a run that
// answered without ever checking the History rendered exactly the same as
// one that checked and genuinely found nothing, which is what let a
// confidently wrong "I can't access your journal" hide behind an ordinary,
// unremarkable-looking caption. The two are different situations and now
// read as different sentences.
//
// Issue #99 removed "disclosedFallback" from `GroundingOutcome` entirely —
// the fixed pipeline's disclosed fallback has no equivalent in the
// tool-calling loop that replaced it, so there is no third caption left to
// choose between; "neverLooked" and "nothingFound" are the only outcomes
// that ever reach the return below.
function GroundingNote({ turn }: { turn: ConversationTurn }) {
  const outcome = groundingOutcome(turn);
  // "digest" (issue #96) gets no note here either: GroundingDisclosure's
  // own line already says the Answer came from a Digest, and this note's
  // wording ("Nothing in your History matched...") would flatly contradict
  // that — it exists for the outcomes where nothing usable was found or
  // never checked, not for one where something was, just not raw Entries.
  if (outcome === "grounded" || outcome === "digest") {
    return null;
  }
  return (
    <p className="mr-auto text-xs text-muted-foreground">
      {outcome === "neverLooked"
        ? "This Question was answered without checking your History."
        : "Nothing in your History matched this Question."}
    </p>
  );
}

// The disclosure (ticket 7) renders beneath GroundingNote, not instead of
// it: the note explains *why* (in prose, independent of the Answer's own
// wording), the disclosure shows *what* (the actual Entries, collapsed
// behind a summary) — see grounding-disclosure.tsx.
function ConversationTurnRow({
  turn,
  groundingEntries,
  groundingEntriesLoading,
  syncEnabled,
}: {
  turn: ConversationTurn;
  groundingEntries: Entry[];
  groundingEntriesLoading: boolean;
  syncEnabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <AskedQuestion text={turn.question} />
      <GivenAnswer text={turn.answer} />
      {/*
        Everything an Answer carries underneath it, sharing the Answer's own
        geometry (#128). `pr-[12%]` is the incoming bubble's own inset and
        `pl-3` is its own horizontal padding, so these lines start under the
        Answer's first character and end where the Answer ends. Before this
        they were `mr-auto max-w-[85%]`: flush against the pane's left edge,
        three pixels out of step with the words they describe, and 85% of a
        width the bubble had not used since ADR 0036 gave it a side.

        One wrapper rather than the same two classes written on each of the
        three, so a fourth caption cannot arrive misaligned.
      */}
      <div className="flex flex-col gap-1 pr-[12%] pl-3">
        {/* Issue #98: "reading a Conversation back shows which model produced
            which part" — shown for every turn, not only on a change, so a
            limit hit under one model is never mistaken for one under
            whichever model replaced it (this ticket's own acceptance
            criterion, server/src/reflect.rs's ReflectResponse.model doc
            comment). */}
        <p className="text-muted-foreground text-xs">{turn.model}</p>
        <GroundingNote turn={turn} />
        <GroundingDisclosure
          turn={turn}
          entries={groundingEntries}
          loading={groundingEntriesLoading}
          syncEnabled={syncEnabled}
        />
      </div>
    </div>
  );
}

// Issue #96: replaces the old bare "Searching your Entries…"/"Thinking…"
// staged copy with the harness's actual progress — each step names what
// was searched and how much came back (`reflect-live-run.ts`'s own
// labels), in the order the events arrived in, and the Answer grows live
// underneath once the model starts producing it.
//
// Accessibility: only the steps list is `aria-live` — a screen reader
// announces each step as it's added (at most a handful per Question, one
// per tool call, plus the odd "Thinking…"), which is the progress this
// ticket asks to be announced. The Answer paragraph below it carries no
// `aria-live` at all, deliberately: `message_update` can fire many times a
// second on a streaming model, and a live region re-announcing on every
// delta would read the Answer out character by character — exactly what
// this ticket asks *not* to happen. A screen reader still reaches the
// finished Answer normally once the turn commits into the Conversation
// below (`GivenAnswer`, an ordinary static paragraph, not a live region
// either) — this component only covers the in-flight moment before that.
function LiveRunView({ liveRun }: { liveRun: LiveRunState }) {
  const { steps, answer, answering, thinking } = liveRun;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1" aria-live="polite">
        {steps.map((step) => (
          <li key={step.id} className="text-sm text-muted-foreground">
            {step.label}
          </li>
        ))}
        {thinking && !answering && <li className="text-sm text-muted-foreground">Thinking…</li>}
      </ul>
      {answering && (
        <p className="mr-auto max-w-[85%] whitespace-pre-wrap text-sm text-foreground">
          {answerProse(answer)}
        </p>
      )}
    </div>
  );
}

// `/reflect` — the third peer view of History (ADR 0020) — and
// `/reflect/:sessionId`, added by ADR 0025: a Session (and the Conversation
// inside it) is now held by the Server, not this page. With no `sessionId`
// this is a fresh Session (an empty Conversation, nothing fetched); with
// one, the Conversation comes from a TanStack Query fetch of `GET
// /v1/sessions/:id` (ADR 0013 — every store read goes through TanStack
// Query, and a Session read is no different). Asking with no `sessionId` is
// what creates a Session (ADR 0025's "a null id on an ask *is* the
// create") — on success this page navigates to the new Session's URL with
// `replace: true`, so Back doesn't bounce the user through an empty
// `/reflect`. The just-answered turn is appended straight into the query
// cache (`queryClient.setQueryData`) rather than waiting for a refetch, so
// it renders immediately either way. Reflect still gates on Sync being on,
// for the same reason ticket 2 already established: retrieval and
// inference run on the Server, over Entries Sync put there.
//
// Issue #80 reverses part of ADR 0025 on purpose: the Device now remembers
// the last Session id shown here (`last-session.ts`, a sessionStorage
// backup — the same shape `use-history-search.ts` already uses for
// Search), so leaving for Composer and coming back resumes the same
// Conversation instead of starting a new one every time. The id in the URL
// still wins whenever one is present — an explicit `/reflect/<id>` is never
// second-guessed by the memory, only a *bare* `/reflect` ever consults it —
// so ADR 0025's "the URL is the only state" still holds for anything that
// actually has a URL; the memory only fills in for the one case that
// doesn't (a bare `/reflect`), which is exactly the gap this ticket exists
// to close.
export function ReflectionPage() {
  const syncEnabled = useSyncEnabled();
  // Issue #133: the last known reachability of the configured Server —
  // `false` only once a real request has actually failed at the network
  // level (`server-request.ts`'s shared `serverRequest`, which
  // `reflectTransport` and `sessionsTransport` both funnel through), never
  // a pre-emptive probe this page runs on its own. Drives two things below:
  // the Question input drops out of `composerSlot` (issue #133's "read yes,
  // write no"), and a persistent `ServerUnreachableBanner` replaces what
  // `handleAsk`'s own failure branch used to toast for this same reason.
  const serverReachable = useServerReachable();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // Snapshot of whatever `last-session.ts` remembered, taken once at this
  // mount rather than read live wherever it's needed below. Two effects
  // below (the resume, and the deleted-elsewhere redirect) both need to
  // know what was remembered *coming into* this mount, and a live read
  // would risk seeing this same mount's own writes instead — e.g. the
  // deleted-elsewhere effect asking "is this 404 for the Session we would
  // have resumed to" after some other effect had already written a
  // different id. A remount happens on every route change between
  // `/reflect` and `/reflect/:sessionId` (they're sibling `<Route>`s, not
  // nested — see App.tsx), so a fresh snapshot is exactly what each of
  // those transitions needs.
  const [rememberedSessionId] = useState(() => readLastSessionId());
  // Issue #79 regression fix: `useEntryStore()`'s `entries` array is only
  // whatever pages of History `useHistory`'s infinite query has loaded so
  // far (History's own scroll window), not the whole local store — a
  // Grounding id can name an Entry this Device genuinely has without it
  // being in that window. `getEntries` (EntryStoreOutletContext, backed by
  // EntryStore.getMany) is a direct by-id lookup that bypasses paging
  // entirely, so this page resolves Grounding ids through it instead.
  const { getEntries } = useEntryStore();

  // The Question currently in flight, or null when nothing is being asked.
  // Deliberately component-local rather than in the query cache: an
  // in-flight Question isn't a Conversation turn yet (CONTEXT.md: a
  // Conversation is Questions *and Answers*), and navigating away mid-ask
  // is Reflection's page-level concern, not the Conversation's own data.
  //
  // Declared ahead of `sessionQuery` below (rather than beside the rest of
  // this page's state further down) because `sessionQuery`'s own `enabled`
  // needs to read it — see that query's own comment on why.
  const [pending, setPending] = useState<string | null>(null);

  const sessionQuery = useQuery({
    // `sessionId ?? ""` rather than a "none" sentinel: `enabled` below already
    // means this query never runs without one, so the key only has to be
    // *distinct*, not meaningful — and an empty string can never collide with
    // a real Session id the way a readable sentinel eventually could. The
    // non-null assertion is safe for the same reason `enabled` makes the
    // fetch safe: neither runs while `sessionId` is undefined.
    queryKey: sessionQueryKey(sessionId ?? ""),
    // biome-ignore lint/style/noNonNullAssertion: guarded by `enabled` below.
    queryFn: () => fetchSession(sessionId!),
    // No sessionId → no query, empty Conversation (ADR 0025): a fresh
    // Session doesn't exist on the Server yet, so there is nothing to fetch
    // until the first ask creates one.
    //
    // Issue #131: also gated on no ask being in flight. `handleAsk` below
    // now mints a fresh Session's id and navigates to its URL *before*
    // dispatching the request — which means `sessionId` can already name a
    // row the Server hasn't created yet (`resolve_session` creates it
    // synchronously once the POST arrives, not before). Fetching eagerly
    // here would race that POST: a `GET` that lands first 404s, and if
    // that response arrives *after* `handleAsk`'s own optimistic
    // `queryClient.setQueryData` write, it would silently overwrite the
    // just-answered Turn with "not found." Waiting for `pending` to clear
    // sidesteps the race entirely rather than trying to out-time it — by
    // then the ask has already settled, so either the optimistic write
    // already holds the answered Turn (success) or the row genuinely
    // exists with no Turns yet (failure — `resolve_session` still minted
    // it), and either way this fetch is safe.
    enabled: sessionId !== undefined && pending === null,
  });

  const sessionData = sessionId === undefined ? undefined : sessionQuery.data;
  const turns = sessionData?.ok ? sessionData.snapshot.turns : [];

  // Issue #98: the models the Server can actually reach right now, offered
  // to `QuestionComposer`'s own picker. Degrades to an empty array (no
  // picker at all) on any failure — a Server that predates the route, or
  // one whose wrapper is unreachable (`modelsTransport`'s own doc comment)
  // — the same "unknown becomes off" posture `useSyncEnabled` already takes
  // for a missing Server URL (ADR 0011), applied here to a missing model
  // list instead. Not gated on `syncEnabled`/a Session existing: the picker
  // is meaningful for a brand-new `/reflect` too, which is exactly where
  // "start a Conversation on a chosen model" (issue #98's first acceptance
  // criterion) has to be offered.
  const modelsQuery = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const result = await modelsTransport();
      return result.ok ? result.models : [];
    },
  });
  const models = modelsQuery.data ?? [];

  // Whatever model this Conversation is already on — the last Turn's own
  // `model`, or `undefined` for a brand-new one (`QuestionComposer`'s own
  // picker then shows "Server default", which is exactly right: nothing
  // has been asked yet, so nothing has resolved a model at all).
  const currentModel = turns.at(-1)?.model;

  // Issue #79 regression fix: every Grounding id across the whole
  // Conversation, resolved in one batched lookup rather than one per
  // rendered turn — sorted and deduplicated so the query key
  // (groundingEntriesQueryKey) is stable across re-renders that don't
  // actually change the id set, and so two turns that happen to share an
  // id don't fetch it twice. Recomputed from `turns`, so a follow-up ask
  // that appends a turn with a new id naturally produces a new key and a
  // fresh fetch — no invalidation wiring needed.
  const groundingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const turn of turns) {
      for (const id of turn.groundingEntryIds) {
        ids.add(id);
      }
    }
    return [...ids].sort();
  }, [turns]);

  const groundingEntriesQuery = useQuery({
    queryKey: groundingEntriesQueryKey(groundingIds),
    queryFn: () => getEntries(groundingIds),
    // No ids yet (a fresh Reflection, or every turn so far had empty
    // Grounding) → nothing to look up. Mirrors sessionQuery's own
    // `enabled` reasoning just above: don't fetch when there's nothing to
    // fetch.
    enabled: groundingIds.length > 0,
  });
  const groundingEntries = groundingEntriesQuery.data ?? [];
  // Only true while an id genuinely needs resolving — not merely because
  // the query is `enabled: false` with no ids, which TanStack Query also
  // reports as `isPending`. Read by GroundingDisclosure so it can show a
  // neutral "loading" placeholder instead of the "hasn't reached this
  // Device yet" message while a genuinely-local id just hasn't resolved
  // yet — showing that message before the lookup has even run would be
  // exactly the false claim CONTEXT.md's Grounding entry forbids, even if
  // only for the moment before the query settles.
  const groundingEntriesLoading = groundingIds.length > 0 && groundingEntriesQuery.isPending;

  const notFound =
    sessionData !== undefined && !sessionData.ok && sessionData.reason === "not-found";
  const unreachable =
    sessionData !== undefined && !sessionData.ok && sessionData.reason === "unreachable";
  const loadingSession = sessionId !== undefined && sessionQuery.isPending;
  // The remembered Session was deleted — from this Device or another one,
  // it doesn't matter which (ADR 0025: every Device reaches the same
  // Sessions). Distinguished from an ordinary not-found (e.g. a stale
  // bookmark, or a link to a Session that was never the remembered one) by
  // comparing against `rememberedSessionId`'s mount-time snapshot: only a
  // 404 for *that specific* id is "the user did nothing wrong, quietly
  // start fresh" territory (issue #80's acceptance criteria) — a 404 for
  // some other id is a real "this Conversation could not be found," and
  // still renders that message exactly as it did before this ticket.
  const deletedElsewhere =
    notFound && rememberedSessionId !== null && sessionId === rememberedSessionId;

  // Issue #96: replaces the old two-phase "Searching your Entries…" /
  // "Thinking…" copy staged on a bare timer — the harness now reports real
  // progress as it happens (`reflect-live-run.ts`), so there is no longer
  // a guessed delay to stage anything against. Reset to
  // `initialLiveRunState` at the start of every ask (`handleAsk`).
  const [liveRun, setLiveRun] = useState<LiveRunState>(initialLiveRunState);
  const [notSupported, setNotSupported] = useState(false);
  const [restore, setRestore] = useState({ question: "", signal: 0 });
  // Issue #85: seeded `undefined`, not `0` — `use-pinned-scroll.ts` guards
  // its own forced-jump effect with `forceToNewest === undefined`, so a
  // seed of `0` (a real, distinct value) defeated that guard and forced an
  // extra synchronous layout pass on every mount, on top of the `watch`
  // effect already doing the same jump. `composer-page.tsx`'s `sendSignal`
  // carries the identical fix (issue #81) for the identical defect; this is
  // that same shape, not a new approach — see issue #85's own writeup for
  // why `(count ?? 0) + 1`, not `count + 1`, is the trap: seeding
  // `undefined` means a plain `count + 1` on the very next ask is `NaN`,
  // and `Object.is(NaN, NaN)` is `true`, so React's dependency check would
  // treat that second ask as unchanged and silently stop scrolling.
  const [askSignal, setAskSignal] = useState<number | undefined>(undefined);
  // Aborts the in-flight `/v1/reflect` stream on unmount — navigating away
  // mid-Answer must not leave a connection open, or call `setState` on a
  // component that's no longer mounted.
  //
  // Issue #110: this used to also fire ~50-100ms after a genuine first
  // mount, for a reason that had nothing to do with navigation —
  // EntryStoreLayout (entry-store-layout.tsx) briefly rendered a different
  // element type at this page's exact position in the tree once the Entry
  // store finished opening, which React reconciles by tearing the old
  // subtree down and mounting a fresh one, aborting whatever `/v1/reflect`
  // request had just started. Fixed at that layout, not here: this cleanup
  // was always doing the right thing on a real unmount, it just used to run
  // on a spurious one too.
  const activeAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => activeAbortRef.current?.abort();
  }, []);

  // Issue #80's resume: a bare `/reflect` mount (no `sessionId`) redirects
  // to the remembered Session instead of staying empty, unless this
  // navigation explicitly asked not to (`NewSessionLink` above sets
  // `state.freshSession` for exactly that). `replace: true` keeps this out
  // of history, the same reasoning `use-history-search.ts`'s own
  // sessionStorage restore already uses for the identical shape of
  // problem — a bare URL, and a previous visit's state to restore into it
  // before the next paint the user notices.
  //
  // Mount-only by design, matching `use-history-search.ts`'s own restore
  // effect: this must run once when a bare `/reflect` is first reached,
  // not re-run merely because `location.state`'s object identity happens
  // to change on a render this effect itself didn't cause.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only — see comment above.
  useEffect(() => {
    if (sessionId !== undefined) {
      return;
    }
    const state = location.state as { freshSession?: boolean } | null;
    if (state?.freshSession) {
      return;
    }
    if (rememberedSessionId !== null) {
      navigate(`/reflect/${rememberedSessionId}`, { replace: true });
    }
  }, []);

  // Issue #80's deleted-elsewhere case: the Session this Device would have
  // resumed to no longer exists. Not something the user did wrong — ADR
  // 0025 made Sessions shared across every Device, so "deleted from
  // somewhere else" is an ordinary thing to discover — so this clears the
  // memory and lands back on a fresh, empty Reflection silently, with
  // nothing surfaced (see `deletedElsewhere`'s own comment above for how
  // this is told apart from an ordinary not-found). Clearing *before*
  // navigating is what stops this from looping: `rememberedSessionId` is a
  // mount-time snapshot, so the redirect below lands on a *new* mount with
  // a *fresh* snapshot — read from storage this effect already emptied —
  // rather than the same stale id bouncing forever. `state.freshSession` on
  // the redirect is redundant insurance for the same reason (the resume
  // effect above would already find nothing to resume to) but costs
  // nothing and says the intent plainly.
  useEffect(() => {
    if (!deletedElsewhere) {
      return;
    }
    clearLastSessionId();
    navigate("/reflect", { replace: true, state: { freshSession: true } });
  }, [deletedElsewhere, navigate]);

  // Keeps the memory in step with whichever Session was actually fetched
  // and opened successfully — not only the ones asked into from this page.
  // Without this, opening a Session from `sessions-page.tsx` (or a direct
  // link) without ever asking a follow-up Question would leave the old
  // memory in place, so a later bare `/reflect` would resume to the
  // *previous* Conversation instead of the one just read.
  useEffect(() => {
    if (sessionId !== undefined && sessionData?.ok) {
      writeLastSessionId(sessionId);
    }
  }, [sessionId, sessionData]);

  async function handleAsk(question: string, model?: string) {
    setNotSupported(false);
    setPending(question);
    setLiveRun(initialLiveRunState);
    // Issue #85's fix, applied to the increment too: `(count ?? 0) + 1`,
    // never a bare `count + 1` — see `askSignal`'s own doc comment above
    // for why a plain increment off an `undefined` seed breaks the second
    // ask, not the first.
    setAskSignal((count) => (count ?? 0) + 1);

    // Issue #131, ADR 0038: the Device mints a fresh Session's id itself
    // now, rather than learning it only from a successful `agent_end` —
    // the same "the Device generates the id, the Server upserts on it"
    // shape an Entry already uses (`server/src/sync.rs`'s own `on conflict
    // (id) do update`). Both the memory write and the navigate happen
    // *before* `reflectTransport` is even called: this is what makes a
    // leave-mid-Question survivable — the URL and `last-session.ts`
    // already point at the right Session however this request ends,
    // instead of only once it succeeds. A follow-up ask on an already-open
    // Session has nothing to mint; `sessionId` from the URL already names
    // it.
    const effectiveSessionId = sessionId ?? crypto.randomUUID();
    writeLastSessionId(effectiveSessionId);
    if (sessionId === undefined) {
      // `replace` so Back doesn't bounce through the empty `/reflect` this
      // Conversation started from — the same reasoning the old
      // after-success navigate below this used to be carried (issue #80).
      navigate(`/reflect/${effectiveSessionId}`, { replace: true });
    }

    const controller = new AbortController();
    activeAbortRef.current = controller;

    const result = await reflectTransport(
      {
        protocol_version: PROTOCOL_VERSION,
        question,
        session_id: effectiveSessionId,
        // Ticket 5's extraction call resolves phrases like "last week"
        // against this Device's own local day, never the server's clock —
        // see ADR 0016's precedent (Export's per-day grouping) and ADR 0023.
        utc_offset_minutes: deviceUtcOffsetMinutes(),
        // Issue #98: `undefined` (the picker left on "Server default", or
        // every ask before this ticket) becomes `null` on the wire — "stay
        // on whatever this Conversation is already on," never "reset to the
        // default" (`WireReflectRequest.model`'s own doc comment,
        // server/src/reflect.rs).
        model: model ?? null,
      },
      {
        signal: controller.signal,
        onEvent: (event) => {
          setLiveRun((state) => applyReflectEvent(state, event));
        },
      },
    );

    activeAbortRef.current = null;
    setPending(null);

    if (result.ok) {
      // Issue #105: `digestSource`, like every other field here, now comes
      // straight off `result.response` — `ReflectResponse` itself carries
      // `digest_source`, computed once server-side
      // (`sessions::DigestSourceTracker`), so there is no longer a live,
      // client-derived value to thread through separately (see
      // `conversationTurnFromWire`'s own doc comment on why that used to
      // exist and why it doesn't any more).
      const turn = conversationTurnFromWire({ question, ...result.response });
      const key = sessionQueryKey(result.response.session_id);
      // Append straight into the cache rather than waiting for a refetch —
      // the turn the user just got an Answer to must render on this render,
      // not after a second round trip to `GET /v1/sessions/:id`.
      queryClient.setQueryData<SessionQueryData>(key, (previous) => ({
        ok: true,
        snapshot: {
          title: result.response.title,
          turns: [...(previous?.ok ? previous.snapshot.turns : []), turn],
        },
      }));

      // Reaffirms what the pre-dispatch write above already recorded — a
      // no-op in the ordinary case where the Server echoed back exactly
      // the id this Device sent, kept anyway so a follow-up ask on an
      // already-open Session (which mints nothing new above) still updates
      // the memory the same way issue #80 always relied on it doing.
      writeLastSessionId(result.response.session_id);
    } else if (result.reason === "aborted") {
      // Issue #131: this call's own `signal` fired — today that only
      // happens because this page unmounted (leaving Reflect mid-Question,
      // `activeAbortRef`'s own cleanup above), which means every `setState`
      // below would already be a no-op on a dead component. Handled as its
      // own branch anyway, not folded into the network-failure one below,
      // because the point isn't "this happens to do nothing here" — it's
      // that a deliberate cancellation must never toast or restore a
      // Question, on principle, independent of whether the component
      // happens to still be mounted to notice. Before this reason existed,
      // an abort reached the same `catch-all` toast every genuine outage
      // did, which is what let leaving the screen report the reader's own
      // navigation as a Server failure (issue #131's own report).
    } else {
      // A Question that failed goes back into the composer rather than
      // vanishing. Losing what someone wrote is the wrong failure mode
      // anywhere, and especially here: the Question is the user's own words,
      // and unlike an Entry it was never written down anywhere else.
      //
      // Issue #96: a run that streams open and then fails
      // (`agent_end {"status": "error"}`, `reason: "agent-error"`) reaches
      // this same branch as a plain network failure — the stream reached
      // the Server fine; the run itself didn't finish one. Either way
      // issue #102's guarantee holds: nothing was persisted, so
      // `liveRun`'s reset above (and never writing into the query cache
      // here) is what keeps this from ever rendering a Turn for it.
      setRestore((previous) => ({ question, signal: previous.signal + 1 }));
      if (result.reason === "not-supported") {
        setNotSupported(true);
      } else if (result.reason === "agent-error") {
        toast.error("Reflection couldn't answer that. Try again.");
      } else {
        // Issue #133: `result.reason` here is `"unreachable"` (the only
        // other member of `ReflectResult`'s failure union — see
        // `reflect-transport.ts`), and by the time this branch runs
        // `serverReachable` above has already flipped `false`: the very
        // `serverRequest` call that produced this failure is what set it,
        // synchronously, before `reflectTransport` ever returned. The
        // persistent `ServerUnreachableBanner` this page now renders for
        // that state replaces the toast a plain network failure used to
        // get — a toast fades and has to repeat itself on every retry; the
        // banner stays until the Server actually answers again.
      }

      // Issue #131: undo the pre-dispatch mint above — unlike "aborted"
      // (the run might still complete on the Server after the Device gave
      // up, so its id is worth keeping), every reason that reaches this
      // branch is known for certain: nothing is ever going to appear under
      // `effectiveSessionId`. `not-supported` and a plain `unreachable`
      // never got past `resolve_session` at all; `agent-error` did, but
      // only ever produced an empty, Turn-less row no client can see
      // anyway (`docs/adr/0025`'s own guarantee, kept by
      // `sessions::list_sessions`). Reverting leaves this exactly where a
      // failed ask always used to leave it — back on a bare `/reflect`,
      // remembering whatever this Device actually had open before this
      // ask, not the mint this ask made and never got to use. Only
      // reachable when this ask itself did the minting (`sessionId ===
      // undefined`): a follow-up on an already-open Session never
      // navigated or overwrote the memory above, so there is nothing here
      // to undo.
      if (sessionId === undefined) {
        if (rememberedSessionId !== null) {
          writeLastSessionId(rememberedSessionId);
        } else {
          clearLastSessionId();
        }
        navigate("/reflect", { replace: true });
      }
    }
  }

  return (
    <Shell
      title="Reflect"
      // SessionsLink (issue #75: Settings moved into the persistent Nav's
      // fourth destination, so it's no longer a second app-bar action
      // alongside Sessions here) plus NewSessionLink (issue #80) — a
      // deliberate way to start over now that a bare `/reflect` resumes
      // the last Conversation instead of always being empty.
      action={
        <>
          <NewSessionLink />
          <SessionsLink />
        </>
      }
      back={<BackToChats />}
      pinnedThread={syncEnabled ? { watch: turns.length, forceToNewest: askSignal } : undefined}
      // Issue #133: also gated on `serverReachable` — "read yes, write no."
      // Old Sessions and whatever's already in `turns` stay fully readable
      // below regardless; only the ability to ask something new goes away
      // while the Server isn't answering, replaced by the persistent
      // `ServerUnreachableBanner` this page renders instead of letting a
      // reader type a Question that's certain to fail.
      composerSlot={
        syncEnabled && !notFound && serverReachable ? (
          <QuestionComposer
            onAsk={handleAsk}
            disabled={pending !== null}
            restore={restore}
            models={models}
            currentModel={currentModel}
          />
        ) : undefined
      }
    >
      {!syncEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to use Reflection.
        </p>
      )}

      {syncEnabled && !serverReachable && (
        // Issue #133: replaces the toast `handleAsk`'s failure branch used
        // to show for a plain network failure — this stays on screen for
        // as long as `serverReachable` does, rather than fading after one
        // render, and offers a way back in instead of just naming the
        // problem. `Retry` re-probes via `refreshCapabilities()`, the same
        // background check `main.tsx` runs at boot and Settings runs on
        // every Save; a successful probe flips `serverReachable` back to
        // `true`, which brings the Question input straight back.
        <ServerUnreachableBanner
          message="Couldn't reach Reflection. Check your Server and try again."
          onRetry={() => {
            refreshCapabilities();
          }}
        />
      )}

      {syncEnabled && notFound && !deletedElsewhere && (
        // A plain, honest message rather than a blank page or a crash (ADR
        // 0025) — this Session was deleted, or the Server URL now points
        // somewhere that never held it. Excludes `deletedElsewhere`
        // (issue #80): that case redirects to a fresh `/reflect` on the
        // very next effect flush, silently — rendering this message first
        // would flash an error the user did nothing to cause.
        <p className="text-center text-sm text-muted-foreground">
          This Conversation could not be found.
        </p>
      )}

      {/*
        Issue #133: no separate "couldn't load this Conversation" message
        here any more — a failed session fetch is exactly the kind of
        request failure that flips `serverReachable` false (both go through
        `sessionsTransport` → `serverRequest`), so the
        `ServerUnreachableBanner` rendered above already covers this case,
        persistently and with a Retry, rather than a second, one-off
        paragraph saying the same thing next to it. `unreachable` itself is
        still read below, to keep this session's own empty state (no turns,
        no invitation) from rendering while its fetch has failed.
      */}
      {syncEnabled &&
        !notFound &&
        !unreachable &&
        !loadingSession &&
        turns.length === 0 &&
        pending === null && (
          // No Conversation has started yet — nothing to render but an
          // invitation.
          <p className="text-center text-sm text-muted-foreground">
            Ask a Question about your History to start a Conversation.
          </p>
        )}

      {syncEnabled &&
        !notFound &&
        !unreachable &&
        turns.map((turn, index) => (
          <ConversationTurnRow
            // biome-ignore lint/suspicious/noArrayIndexKey: turns never reorder or get removed — position is a stable identity for one render of this Conversation.
            key={index}
            turn={turn}
            groundingEntries={groundingEntries}
            groundingEntriesLoading={groundingEntriesLoading}
            syncEnabled={syncEnabled}
          />
        ))}

      {syncEnabled && pending !== null && (
        <div className="flex flex-col gap-2">
          <AskedQuestion text={pending} />
          <LiveRunView liveRun={liveRun} />
        </div>
      )}

      {syncEnabled && notSupported && (
        <p className="text-center text-sm text-muted-foreground">
          This Server doesn't support Reflection yet.
        </p>
      )}
    </Shell>
  );
}
