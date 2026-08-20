import { PROTOCOL_VERSION } from "@meologue/core";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Nav, SettingsLink } from "@/components/nav";
import { QuestionComposer } from "@/components/question-composer";
import { Shell } from "@/components/shell";
import { type ConversationTurn, useConversationStore } from "@/lib/conversation";
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

function ConversationTurnRow({ turn }: { turn: ConversationTurn }) {
  return (
    <div className="flex flex-col gap-2">
      <AskedQuestion text={turn.question} />
      <GivenAnswer text={turn.answer} />
    </div>
  );
}

// `/reflect` — the third peer view of History (ADR 0020). This ticket is
// the first to give Reflection its asking-and-answering loop: a Question
// typed here comes back as an Answer grounded in the Entries retrieval
// found (ticket 4 — vector search on the Question alone; later tickets add
// a date-range retriever and a disclosed fallback on top of this). Reflect
// still gates on Sync being on, for the same reason ticket 2 already
// established: retrieval and inference run on the Server, over Entries
// Sync put there.
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
    });

    setPending(null);

    if (result.ok) {
      addTurn({
        question,
        answer: result.response.answer,
        groundingEntryIds: result.response.grounding_entry_ids,
        grounded: result.response.grounded,
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
