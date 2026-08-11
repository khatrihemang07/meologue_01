import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { normalizeEntryBody } from "@/lib/entry-text";

interface ComposerProps {
  onSend: (body: string) => void;
}

export function Composer({ onSend }: ComposerProps) {
  const [value, setValue] = useState("");

  const send = () => {
    if (normalizeEntryBody(value) === null) {
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
      />
      <Button className="self-end" onClick={send}>
        Send
      </Button>
    </div>
  );
}
