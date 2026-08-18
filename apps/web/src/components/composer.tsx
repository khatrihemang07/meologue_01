import { ArrowUp } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { normalizeEntryBody } from "@/lib/entry-text";

interface ComposerProps {
  onSend: (body: string) => void;
  /**
   * Sending before the store finishes its async open would look identical
   * to a normal Send but silently never persist (ticket 21) — the disabled
   * state guards that window rather than trusting callers not to send early.
   */
  disabled?: boolean;
}

export function Composer({ onSend, disabled = false }: ComposerProps) {
  const [value, setValue] = useState("");

  const send = () => {
    if (disabled || normalizeEntryBody(value) === null) {
      return;
    }
    onSend(value);
    setValue("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    // Docked to Shell's composerSlot (ticket 51, #49's Discord layout) rather
    // than scrolling with the rest of the page: a full-bleed bar so its
    // border/background reach the window edge, with the same proportional
    // reading column as Shell's content region nested inside (ADR 0019) so
    // the field lines up with History above it — the two percentages must
    // stay identical or the field stops agreeing with the thread. Its own
    // safe-area padding is what the stand-in on Shell's scroll region
    // existed to cover before this ticket gave the Composer a real bottom
    // edge to own.
    <div className="shrink-0 border-t border-border bg-background [padding-bottom:env(safe-area-inset-bottom)]">
      <div className="mx-auto flex w-[97%] items-end gap-2 px-4 py-2.5 md:w-[85%]">
        <Textarea
          placeholder="What's on your mind?"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          // ui/textarea.tsx already sizes to content via field-sizing:
          // content; min-h/max-h here are what turn that unbounded growth
          // into ticket 51's "one line, grows to about five, then scrolls."
          // Sending clears `value`, and field-sizing shrinks the box back to
          // min-h on its own — no row-count state to track.
          className="min-h-11 max-h-36 resize-none overflow-y-auto rounded-3xl"
        />
        <Button
          aria-label="Send"
          size="icon-lg"
          // Ticket 51 replaces the labelled rectangle with an icon button;
          // aria-label keeps "Send" as the accessible name the e2e suite and
          // composer.test.tsx already query by. size-11 (44px) meets the
          // platform tap-target minimum the icon-lg token alone (36px)
          // doesn't reach.
          className="size-11 shrink-0 self-end rounded-full"
          onClick={send}
          disabled={disabled}
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </Button>
      </div>
    </div>
  );
}
