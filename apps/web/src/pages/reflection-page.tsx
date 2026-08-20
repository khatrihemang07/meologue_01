import type { Entry } from "@meologue/core";
import { PROTOCOL_VERSION } from "@meologue/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { GroundingDisclosure } from "@/components/grounding-disclosure";
import { Nav, SessionsLink, SettingsLink } from "@/components/nav";
import { QuestionComposer } from "@/components/question-composer";
import { Shell } from "@/components/shell";
import {
  type ConversationTurn,
  conversationTurnFromWire,
  groundingOutcome,
} from "@/lib/conversation";
import { deviceUtcOffsetMinutes } from "@/lib/entry-day";
import { reflectTransport } from "@/lib/reflect-transport";
import { type SessionResult, sessionsTransport } from "@/lib/sessions-transport";
import { useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

/**
 * How long the in-flight indicator shows "searching" copy before switching
 * to "thinking" copy. A real call is ~7-15s (the chat wrapper's own system
 * prompt costs ~7s before it's even seen the Question — see the ticket
 * brief), so a bare spinner reads as stuck; staging the copy is what tells
 * the reader something is still moving without promising a specific time.
 */
const THINKING_AFTER_MS = 3000;

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
      turns: result.session.turns.map(conversationTurnFromWire),
    },
  };
}

function AskedQuestion({ text }: { text: string }) {
  return (
    <p className="ml-auto max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
      {text}
    </p>
  );
}

function GivenAnswer({ text }: { text: string }) {
  return <p className="mr-auto max-w-[85%] whitespace-pre-wrap text-sm text-foreground">{text}</p>;
}

// An explicit note per turn, independent of the Answer's own wording — the
// point of ticket 6 (docs/adr/0024) is that the user can tell a real Answer
// from a confident wrong one without trusting how the model phrased itself.
// "grounded" (the server judged its Grounding actually answered the
// Question) renders no note at all; the other two outcomes render a short
// caption in CONTEXT.md's own vocabulary (History, Question, Entries),
// matching the muted-caption styling already used elsewhere on this page.
// The outcome itself comes from `groundingOutcome` (lib/conversation.ts) —
// shared with grounding-disclosure.tsx's `summaryLabel` so the caption here
// and the expander label below it can never disagree about what happened.
function GroundingNote({ turn }: { turn: ConversationTurn }) {
  const outcome = groundingOutcome(turn);
  if (outcome === "grounded") {
    return null;
  }
  return (
    <p className="mr-auto text-xs text-muted-foreground">
      {outcome === "disclosedFallback"
        ? "Nothing in your History matched this Question — this is what you wrote in the last few days."
        : "Nothing in your History matched this Question."}
    </p>
  );
}

// The disclosure (ticket 7) renders beneath GroundingNote, not instead of
// it: the note explains *why* (in prose, independent of the Answer's own
// wording), the disclosure shows *what* (the actual Entries, collapsed
// behind a summary that also carries the grounded/fallback distinction) —
// see grounding-disclosure.tsx.
function ConversationTurnRow({
  turn,
  entries,
  syncEnabled,
}: {
  turn: ConversationTurn;
  entries: Entry[];
  syncEnabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <AskedQuestion text={turn.question} />
      <GivenAnswer text={turn.answer} />
      <GroundingNote turn={turn} />
      <GroundingDisclosure turn={turn} entries={entries} syncEnabled={syncEnabled} />
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
export function ReflectionPage() {
  const syncEnabled = useSyncEnabled();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The Device's own Entry store, not a fetch — Entry ids are minted on the
  // creating Device and preserved through Sync, so this Device's local copy
  // (if it has one yet) is the same Entry the server meant. Read once here,
  // page-level (history-page.tsx's own convention: pages own data access,
  // components take props — see grounding-disclosure.tsx), rather than once
  // per rendered turn.
  const { entries } = useEntryStore();

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
    enabled: sessionId !== undefined,
  });

  const sessionData = sessionId === undefined ? undefined : sessionQuery.data;
  const turns = sessionData?.ok ? sessionData.snapshot.turns : [];
  const notFound =
    sessionData !== undefined && !sessionData.ok && sessionData.reason === "not-found";
  const unreachable =
    sessionData !== undefined && !sessionData.ok && sessionData.reason === "unreachable";
  const loadingSession = sessionId !== undefined && sessionQuery.isPending;

  // The Question currently in flight, or null when nothing is being asked.
  // Deliberately component-local rather than in the query cache: an
  // in-flight Question isn't a Conversation turn yet (CONTEXT.md: a
  // Conversation is Questions *and Answers*), and navigating away mid-ask
  // is Reflection's page-level concern, not the Conversation's own data.
  const [pending, setPending] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [notSupported, setNotSupported] = useState(false);
  const [restore, setRestore] = useState({ question: "", signal: 0 });
  // Bumped on every ask, mirroring composer-page.tsx's sendSignal: the
  // pinned thread jumps to the newest end unconditionally on Ask, the same
  // rule Send already gets there.
  const [askSignal, setAskSignal] = useState(0);

  useEffect(() => {
    if (pending === null) {
      setThinking(false);
      return;
    }
    const timer = setTimeout(() => setThinking(true), THINKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  async function handleAsk(question: string) {
    setNotSupported(false);
    setPending(question);
    setAskSignal((count) => count + 1);

    const result = await reflectTransport({
      protocol_version: PROTOCOL_VERSION,
      question,
      session_id: sessionId ?? null,
      // Ticket 5's extraction call resolves phrases like "last week"
      // against this Device's own local day, never the server's clock —
      // see ADR 0016's precedent (Export's per-day grouping) and ADR 0023.
      utc_offset_minutes: deviceUtcOffsetMinutes(),
    });

    setPending(null);

    if (result.ok) {
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

      if (sessionId === undefined) {
        // A null session_id on the request is what created this Session
        // (ADR 0025) — `replace` so Back doesn't bounce through the empty
        // `/reflect` this Conversation started from.
        navigate(`/reflect/${result.response.session_id}`, { replace: true });
      }
    } else {
      // A Question that failed goes back into the composer rather than
      // vanishing. Losing what someone wrote is the wrong failure mode
      // anywhere, and especially here: the Question is the user's own words,
      // and unlike an Entry it was never written down anywhere else.
      setRestore((previous) => ({ question, signal: previous.signal + 1 }));
      if (result.reason === "not-supported") {
        setNotSupported(true);
      } else {
        toast.error("Couldn't reach Reflection. Check your Server and try again.");
      }
    }
  }

  return (
    <Shell
      title="Reflect"
      action={
        <>
          <SessionsLink />
          <SettingsLink />
        </>
      }
      nav={<Nav />}
      pinnedThread={syncEnabled ? { watch: turns.length, forceToNewest: askSignal } : undefined}
      composerSlot={
        syncEnabled && !notFound ? (
          <QuestionComposer onAsk={handleAsk} disabled={pending !== null} restore={restore} />
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

      {syncEnabled && notFound && (
        // A plain, honest message rather than a blank page or a crash (ADR
        // 0025) — this Session was deleted, or the Server URL now points
        // somewhere that never held it.
        <p className="text-center text-sm text-muted-foreground">
          This Conversation could not be found.
        </p>
      )}

      {syncEnabled && unreachable && (
        <p className="text-center text-sm text-muted-foreground">
          Couldn't load this Conversation. Check your Server and try again.
        </p>
      )}

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
            entries={entries}
            syncEnabled={syncEnabled}
          />
        ))}

      {syncEnabled && pending !== null && (
        <div className="flex flex-col gap-2">
          <AskedQuestion text={pending} />
          <p className="mr-auto text-sm text-muted-foreground" aria-live="polite">
            {thinking ? "Thinking…" : "Searching your Entries…"}
          </p>
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
