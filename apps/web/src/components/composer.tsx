import type { Entry } from "@meologue/core";
import { ArrowUp, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { normalizeEntryBody } from "@/lib/entry-text";
import { isSubmitChord } from "@/lib/submit-chord";

interface ComposerProps {
  onSend: (body: string) => void;
  /**
   * Sending before the store finishes its async open would look identical
   * to a normal Send but silently never persist (ticket 21) — the disabled
   * state guards that window rather than trusting callers not to send early.
   */
  disabled?: boolean;
  /**
   * ADR 0028: when set, the Composer edits this Entry instead of composing
   * a new one. The Composer is where editing happens rather than an inline
   * editor on the row itself — it's already docked, already grows with
   * content, and already survives the Android keyboard and safe areas
   * (tickets 51, 56); an inline text box on a History row would be a second
   * input surface that has to relearn all three from scratch for no
   * benefit. CONTEXT.md names Composer after the *view*, not the action it
   * performs there, so "the Composer, editing" doesn't strain that
   * vocabulary the way a second, separately-named editor would.
   *
   * Owned by the page (composer-page.tsx), not the Composer itself — same
   * split as `onSend`/`disabled` above — because which Entry (if any) is
   * being edited has to survive independently of whatever's mid-composition
   * here, and a page-level `useState<Entry | null>` is the simplest thing
   * that can hold that.
   */
  editingEntry?: Entry | null;
  /** Commits the edit — Send, while `editingEntry` is set. Required together with `editingEntry`; see the page for what happens after (clearing `editingEntry`, which is what ends edit mode here). */
  onCommitEdit?: (id: string, body: string) => void;
  /** Escape, or the visible Cancel control below — leaves edit mode without committing anything. */
  onCancelEdit?: () => void;
}

export function Composer({
  onSend,
  disabled = false,
  editingEntry = null,
  onCommitEdit,
  onCancelEdit,
}: ComposerProps) {
  const [value, setValue] = useState("");

  // Whatever was mid-composition the instant edit mode started (ADR 0028) —
  // restored when edit mode ends, whether by Cancel or by a successful
  // commit, so starting an edit never costs the reader a draft they hadn't
  // sent yet. A ref, not state: it's written and read at the edges of edit
  // mode, never rendered itself, and putting it in state would mean an
  // extra render on every edit-mode transition for a value nothing displays.
  const draftBeforeEditRef = useRef("");
  // The previous render's `editingEntry.id` (or null), so the effect below
  // can tell "just started editing," "still editing the same Entry" (e.g. a
  // keystroke bumping some unrelated prop) and "just stopped editing" apart
  // — `editingEntry` alone can't distinguish the middle case from the first.
  const previousEditingIdRef = useRef<string | null>(null);

  useEffect(() => {
    const currentId = editingEntry?.id ?? null;
    if (currentId === previousEditingIdRef.current) {
      return;
    }
    if (currentId !== null) {
      if (previousEditingIdRef.current === null) {
        // Entering edit mode: stash the live draft (read via the functional
        // updater so this doesn't need `value` in the dependency array —
        // this effect must only run on `editingEntry` changing, not on
        // every keystroke) and seed the field with the Entry's own body.
        setValue((current) => {
          draftBeforeEditRef.current = current;
          return editingEntry?.body ?? "";
        });
      } else {
        // Switching which Entry is being edited without cancelling first —
        // the History context menu allows this (nothing closes the menu's
        // Edit choice for a second row). Reseed from the new Entry; the
        // stashed pre-edit draft is untouched, so it's still what Cancel
        // restores.
        setValue(editingEntry?.body ?? "");
      }
    } else {
      // Left edit mode — Cancel, or the page cleared `editingEntry` after a
      // successful commit. Either way, restore whatever was mid-composition
      // before, per this component's own doc comment on `editingEntry`.
      setValue(draftBeforeEditRef.current);
      draftBeforeEditRef.current = "";
    }
    previousEditingIdRef.current = currentId;
  }, [editingEntry]);

  const send = () => {
    if (disabled) {
      return;
    }
    const body = normalizeEntryBody(value);
    if (body === null) {
      // Editing to empty is refused, exactly like an empty new Send — same
      // rule, same helper, not reimplemented for this second case.
      return;
    }
    if (editingEntry) {
      onCommitEdit?.(editingEntry.id, body);
      return;
    }
    // Unchanged from before ADR 0028: the raw (untrimmed) `value`, not
    // the normalized `body` above — sendEntry (use-history.ts) does its own
    // normalizeEntryBody() call, so this only needed `body` to decide
    // whether to send at all.
    onSend(value);
    setValue("");
  };

  const cancelEdit = () => {
    onCancelEdit?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Issue #76: plain Enter is no longer Send on any platform — it falls
    // through and lets the textarea insert its own newline, the same as
    // every other unhandled key. Only the platform-specific chord
    // (submit-chord.ts) sends; letting Enter through with no
    // preventDefault() is what makes multi-line composition possible at
    // all, since Shift+Enter was previously the *only* way to get a
    // newline in here.
    if (isSubmitChord(event)) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "Escape" && editingEntry) {
      event.preventDefault();
      cancelEdit();
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
    // edge to own, at every width. It was briefly gated to `md` and up,
    // because Shell's persistent `nav` was ordered after this element and
    // owned the narrow window's bottom edge; ADR 0036 retired that nav, so
    // there is nothing below this any more and the gate would now leave a
    // phone's gesture bar unaccounted for. `--safe-bottom` (set by
    // `chat-shell-layout.tsx`) is `env(safe-area-inset-bottom)` normally and
    // 0 while a keyboard is up, since the home indicator is behind it.
    <div className="shrink-0 border-t border-border bg-background [padding-bottom:var(--safe-bottom)]">
      {editingEntry && (
        // The visible half of "this is an edit, not a new Send" (ADR 0028).
        // Escape (handleKeyDown above) is the keyboard half of the edit
        // indicator. Same proportional column as the input row below so
        // its edges line up.
        <div className="mx-auto flex w-[97%] items-center justify-between px-4 pt-2 text-xs text-muted-foreground md:w-[85%]">
          <span>Editing Entry</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={cancelEdit}
              aria-label="Cancel edit"
              className="flex items-center gap-0.5 rounded-md px-1 py-0.5 underline underline-offset-2 hover:text-foreground"
            >
              <X aria-hidden="true" className="size-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
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
