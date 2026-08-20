import { ArrowUp } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface QuestionComposerProps {
  onAsk: (question: string) => void;
  /** While a Question is in flight — a new one can't be asked until the Answer (or a failure) comes back. */
  disabled?: boolean;
  /**
   * A Question that never reached an Answer, handed back so the user doesn't
   * lose what they wrote. `signal` is what triggers the restore rather than
   * the text itself, so asking the same Question twice and failing twice
   * still puts it back the second time.
   */
  restore?: { question: string; signal: number };
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
export function QuestionComposer({ onAsk, disabled = false, restore }: QuestionComposerProps) {
  const [value, setValue] = useState("");

  // Only ever fires on a *new* failure (a changed signal), so it can't fight
  // the user for control of the field while they're typing a replacement.
  const restoreSignal = restore?.signal ?? 0;
  const restoreQuestion = restore?.question ?? "";
  useEffect(() => {
    if (restoreSignal > 0) {
      setValue(restoreQuestion);
    }
  }, [restoreSignal, restoreQuestion]);

  const ask = () => {
    const question = value.trim();
    if (disabled || question === "") {
      return;
    }
    onAsk(question);
    setValue("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ask();
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-background [padding-bottom:env(safe-area-inset-bottom)]">
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
