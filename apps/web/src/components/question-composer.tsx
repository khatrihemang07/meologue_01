import type { WireModelInfo } from "@meologue/core";
import { ArrowUp } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isSubmitChord } from "@/lib/submit-chord";

interface QuestionComposerProps {
  /**
   * Issue #98: `model` is `undefined` for "Server default" (the picker's own
   * initial state, and every ask before this ticket) or a chosen model's id
   * — never an empty string, so a caller can pass this straight through to
   * `WireReflectRequest.model` with `model ?? null`, matching how
   * `session_id ?? null` already works.
   */
  onAsk: (question: string, model?: string) => void;
  /** While a Question is in flight — a new one can't be asked until the Answer (or a failure) comes back. */
  disabled?: boolean;
  /**
   * A Question that never reached an Answer, handed back so the user doesn't
   * lose what they wrote. `signal` is what triggers the restore rather than
   * the text itself, so asking the same Question twice and failing twice
   * still puts it back the second time.
   */
  restore?: { question: string; signal: number };
  /**
   * Issue #98: the models the Server can actually reach right now
   * (`GET /v1/models`, discovered at runtime — never hard-coded). Empty (the
   * default, and every case before this ticket: a Server that predates the
   * route, or one whose wrapper is unreachable) renders no picker at all —
   * asking behaves exactly as it always did, with no `model` on the wire.
   */
  models?: WireModelInfo[];
  /**
   * Issue #98: whatever model this Conversation is already on — a fresh
   * `/reflect` has none (`undefined`), an opened one carries its last Turn's
   * own `model` (`reflection-page.tsx`). Read once per value change to point
   * the picker at the model actually in force, the same way `restore`'s own
   * effect below reacts to a changed `signal` rather than fighting the user
   * for control of a field they're actively using.
   */
  currentModel?: string;
}

/**
 * The Reflect page's `composerSlot` — asking a Question, not Sending an
 * Entry. Deliberately its own component rather than reusing `Composer`:
 * the two look alike today, but a Question is a different domain concept
 * from an Entry (CONTEXT.md: a Question "is not an Entry... it is the user
 * interrogating the thoughts they already captured"), and `Composer`'s own
 * `onSend`/disabled-while-store-isn't-ready shape belongs to Entry capture
 * specifically. Sharing a name across both would blur exactly the
 * distinction CONTEXT.md draws.
 */
export function QuestionComposer({
  onAsk,
  disabled = false,
  restore,
  models = [],
  currentModel,
}: QuestionComposerProps) {
  const [value, setValue] = useState("");
  // Issue #98: "" is the picker's own "Server default" option — translated
  // to `undefined` only at the `onAsk` boundary below, so this component's
  // own state never has to special-case two different values meaning the
  // same "no explicit choice" thing.
  const [selectedModel, setSelectedModel] = useState("");

  // Only ever fires on a *new* failure (a changed signal), so it can't fight
  // the user for control of the field while they're typing a replacement.
  const restoreSignal = restore?.signal ?? 0;
  const restoreQuestion = restore?.question ?? "";
  useEffect(() => {
    if (restoreSignal > 0) {
      setValue(restoreQuestion);
    }
  }, [restoreSignal, restoreQuestion]);

  // Points the picker at whichever model this Conversation is actually on
  // whenever that changes — opening a different Session, or this one's
  // first Turn landing and reporting its own model back. Not an
  // every-render sync (a plain `value={currentModel ?? ""}` would fight the
  // user's own in-flight selection the instant a query refetch runs), the
  // same reasoning `restore`'s own effect above already follows.
  useEffect(() => {
    setSelectedModel(currentModel ?? "");
  }, [currentModel]);

  const ask = () => {
    const question = value.trim();
    if (disabled || question === "") {
      return;
    }
    onAsk(question, selectedModel === "" ? undefined : selectedModel);
    setValue("");
  };

  // Issue #76: the Composer and the Question composer send/ask on the
  // identical chord — plain Enter now writes a newline everywhere, the
  // same as it always could with Shift held, and only the
  // platform-specific chord (submit-chord.ts) commits. See composer.tsx's
  // handleKeyDown for the fuller comment; not repeated here since the two
  // components share the same helper rather than duplicating the rule.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitChord(event)) {
      event.preventDefault();
      ask();
    }
  };

  return (
    // Same bottom-edge ownership rule as composer.tsx — see its own comment:
    // below `md`, Shell's `nav` is ordered after this and owns the inset;
    // at `md` and up the nav is a rail and this element is the bottom edge.
    <div className="shrink-0 border-t border-border bg-background md:[padding-bottom:var(--safe-bottom)]">
      {/* Issue #98: no picker at all when the Server offers no models —
          a Server that predates GET /v1/models, or one whose wrapper is
          unreachable right now (`ModelsResponse`'s own doc comment,
          server/src/models.rs) — so asking behaves exactly as it did
          before this ticket rather than showing a picker with nothing to
          offer. */}
      {models.length > 0 && (
        <div className="mx-auto w-[97%] px-4 pt-2 md:w-[85%]">
          <label className="sr-only" htmlFor="reflect-model">
            Model
          </label>
          <select
            id="reflect-model"
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            disabled={disabled}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
          >
            <option value="">Server default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="mx-auto flex w-[97%] items-end gap-2 px-4 py-2.5 md:w-[85%]">
        <Textarea
          placeholder="Ask a Question about your History"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="min-h-11 max-h-36 resize-none overflow-y-auto rounded-3xl"
        />
        <Button
          aria-label="Ask"
          size="icon-lg"
          className="size-11 shrink-0 self-end rounded-full"
          onClick={ask}
          disabled={disabled}
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </Button>
      </div>
    </div>
  );
}
