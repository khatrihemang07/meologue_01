import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AddTaskFormProps {
  onAdd: (content: string) => void;
  disabled: boolean;
}

/**
 * A plain text field, deliberately — issue #170's quick-add parser
 * (`#project`, `%label`, natural-language dates, and the rest of the
 * grammar the shared programme brief names) is its own ticket, and this is
 * not a first draft of that UI to be thrown away once it lands. Typing
 * `#groceries` here today creates a Task literally named "#groceries";
 * nothing about that is broken, it simply isn't parsed yet, exactly the
 * same honesty `entry-text.ts`'s own plain-text handling has everywhere
 * else in this app before a dialect grows a new mark.
 */
export function AddTaskForm({ onAdd, disabled }: AddTaskFormProps) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim() === "") {
      return;
    }
    onAdd(value);
    setValue("");
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 border-t border-border p-3">
      <Input
        type="text"
        placeholder="Add a Task"
        aria-label="Add a Task"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
      />
      <Button type="submit" disabled={disabled || value.trim() === ""}>
        Add
      </Button>
    </form>
  );
}
