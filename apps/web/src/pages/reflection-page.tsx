import { PROTOCOL_VERSION } from "@meologue/core";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Nav, SettingsLink } from "@/components/nav";
import { QuestionComposer } from "@/components/question-composer";
import { Shell } from "@/components/shell";
import { type ConversationTurn, useConversationStore } from "@/lib/conversation";
import { deviceUtcOffsetMinutes } from "@/lib/entry-day";
import { reflectTransport } from "@/lib/reflect-transport";
import { useSyncEnabled } from "@/lib/settings";

/**
 * How long the in-flight indicator shows "searching" copy before switching
 * to "thinking" copy. A real call is ~7-15s (the chat wrapper's own system
 * prompt costs ~7s before it's even seen the Question — see the ticket
 * brief), so a bare spinner reads as stuck; staging the copy is what tells
 * the reader something is still moving without promising a specific time.
 */
const THINKING_AFTER_MS = 3000;

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
// `grounded` (the server judged its Grounding actually answered the
// Question) renders no note at all; the other two states render a short
// caption in CONTEXT.md's own vocabulary (History, Question, Entries),
// matching the muted-caption styling already used elsewhere on this page.
function GroundingNote({ turn }: { turn: ConversationTurn }) {
  if (turn.grounded) {
    return null;
  }
  return (
    <p className="mr-auto text-xs text-muted-foreground">
      {turn.fallbackUsed
        ? "Nothing in your History matched this Question — this is what you wrote in the last few days."
        : "Nothing in your History matched this Question."}
    </p>
  );
}

function ConversationTurnRow({ turn }: { turn: ConversationTurn }) {
  return (
    <div className="flex flex-col gap-2">
      <AskedQuestion text={turn.question} />
      <GivenAnswer text={turn.answer} />
      <GroundingNote turn={turn} />
    </div>
  );
}

// `/reflect` — the third peer view of History (ADR 0020). Ticket 4 gave
// Reflection its asking-and-answering loop; ticket 5 widened retrieval into
// a three-source fan-out (ADR 0023). Ticket 6 (ADR 0024) is what makes this
// page render an explicit note — independent of the Answer's own wording —
// when the server judged its Grounding didn't answer the Question, so this
// page's own job stays the same as before: post the Question, the
// Conversation so far, and this Device's UTC offset, then render whatever
// comes back, plus a `GroundingNote` per turn. Reflect still gates on Sync
// being on, for the same reason ticket 2 already established: retrieval and
// inference run on the Server, over Entries Sync put there.
export function ReflectionPage() {
  const syncEnabled = useSyncEnabled();
  const turns = useConversationStore((state) => state.turns);
  const addTurn = useConversationStore((state) => state.addTurn);

  // The Question currently in flight, or null when nothing is being asked.
  // Deliberately component-local rather than in the Conversation store: an
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

    const priorTurns = useConversationStore
      .getState()
      .turns.map((turn) => ({ question: turn.question, answer: turn.answer }));

    const result = await reflectTransport({
      protocol_version: PROTOCOL_VERSION,
      question,
      prior_turns: priorTurns,
      // Ticket 5's extraction call resolves phrases like "last week"
      // against this Device's own local day, never the server's clock —
      // see ADR 0016's precedent (Export's per-day grouping) and ADR 0023.
      utc_offset_minutes: deviceUtcOffsetMinutes(),
    });

    setPending(null);

    if (result.ok) {
      addTurn({
        question,
        answer: result.response.answer,
        groundingEntryIds: result.response.grounding_entry_ids,
        grounded: result.response.grounded,
        fallbackUsed: result.response.fallback_used,
      });
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
      action={<SettingsLink />}
      nav={<Nav />}
      pinnedThread={syncEnabled ? { watch: turns.length, forceToNewest: askSignal } : undefined}
      composerSlot={
        syncEnabled ? (
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

      {syncEnabled && turns.length === 0 && pending === null && (
        // No Conversation has started yet — nothing to render but an
        // invitation.
        <p className="text-center text-sm text-muted-foreground">
          Ask a Question about your History to start a Conversation.
        </p>
      )}

      {syncEnabled &&
        turns.map((turn, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns never reorder or get removed — position is a stable identity for this Device's own in-memory Conversation.
          <ConversationTurnRow key={index} turn={turn} />
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
