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
    <div className="flex flex-col gap-3">
      <Textarea
        placeholder="What's on your mind?"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      <Button className="self-end" onClick={send} disabled={disabled}>
        Send
      </Button>
    </div>
  );
}
