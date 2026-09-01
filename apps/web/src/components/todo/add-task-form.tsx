/**
 * Todo's add field (issue #170) — the third of this app's live-token
 * surfaces, after composer-picker.ts's `[[` picker and composer-slash.ts's
 * `/` menu (both read for calibration before writing this). It borrows
 * their exact shape — derive everything fresh from the current text on
 * every keystroke, never patch state incrementally — but not their
 * plumbing: both of those live inside a ProseMirror document
 * (composer-editor.ts's plugins reconstruct "flat text plus a caret
 * index" from a real `Node`/`Selection` for them), where this is a plain
 * `<input>`. Building a second ProseMirror document just for one field
 * would cost this component ADR 0044's whole reason jsdom can test the
 * Composer only through that reconstruction; a native `<input>`, plus a
 * purely visual backdrop (see the JSX below), needs none of it and stays
 * directly testable through `fireEvent.change`.
 *
 * Before issue #170 this was a plain text field on purpose — see git
 * history for the header comment this replaces, which explained that
 * typing "#groceries" here created a Task literally named "#groceries"
 * and that this was fine, not a bug, until the parser existed. It does
 * now: this field parses as you type (quick-add-highlight.ts), highlights
 * every recognised token in place, and lets a click demote one back to
 * plain text — the safety valve 170-brief.md's own Part D calls "not
 * optional polish" for an eager parser (Todoist's own documented false
 * positive, "Create **monthly** report" becoming a monthly recurrence, is
 * exactly the failure mode this exists to catch).
 */
import type { QuickAddOptions } from "@meologue/core";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { localDayKey } from "@/components/date-picker-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type DemotedSignature,
  highlightSegments,
  parseWithDemotions,
  QUICK_ADD_HIGHLIGHT_CLASS,
  tokenAtOffset,
  tokenSignature,
} from "@/lib/quick-add-highlight";
import { type QuickAddTaskFields, taskFieldsFromQuickAdd } from "@/lib/quick-add-task";
import { useSettingsStore } from "@/lib/settings";
import { cn } from "@/lib/utils";

export interface AddTaskFormProps {
  /**
   * Already-resolved Task fields (quick-add-task.ts) except `labelIds` —
   * resolving a `%label` name to an id needs a LabelStore round trip
   * (use-labels.ts's `resolveLabelIds`), which this component has no
   * reason to know about; todo-page.tsx's own caller is what awaits that
   * and reconciles `fields.date` against the view's inherited date before
   * it ever calls `addTask`.
   */
  onAdd: (fields: QuickAddTaskFields) => void;
  disabled: boolean;
}

// The box-model classes `Input`'s own default className already carries
// (h-8, rounded-lg, the border width, the padding, the text size) —
// repeated here, with a transparent border and background instead of
// `border-input`/`bg-transparent`, so the backdrop's text starts at
// exactly the same pixel `Input`'s real text does. A border of a
// different width (0 vs 1px) between the two layers is a one-pixel drift
// in exactly this spot, invisible until someone compares them side by
// side and then obviously wrong — matching every geometry-relevant class
// here, not just padding, is what keeps that from happening quietly.
const HIGHLIGHT_BOX_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-transparent px-2.5 py-1 text-base md:text-sm";

export function AddTaskForm({ onAdd, disabled }: AddTaskFormProps) {
  const [value, setValue] = useState("");
  // See quick-add-highlight.ts's `parseWithDemotions` for the exact rule
  // this set encodes and why it survives further typing.
  const [demotedSignatures, setDemotedSignatures] = useState<ReadonlySet<DemotedSignature>>(
    new Set(),
  );
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Date-only, matching todo-page.tsx's own `captureDate` (`localDayKey`):
  // every date-rule that reads `now`
  // (../../packages/core/src/quick-add/date-rules.ts) only ever compares
  // or advances whole calendar days, never a time-of-day, so a finer
  // "now" would add nothing this parser could use. Recomputed on every
  // render rather than memoised for the field's lifetime — cheap, and
  // correct across a midnight the field happens to stay open through.
  const options: QuickAddOptions = { now: localDayKey(new Date()), smartDates };
  const result = parseWithDemotions(value, options, demotedSignatures);
  const segments = highlightSegments(value, result.tokens);

  /**
   * Keeps the backdrop scrolled to exactly where the real `<input>` is
   * scrolled. Without it the highlights do not merely drift — they vanish.
   *
   * A native `<input>` auto-scrolls its own text once the line outgrows
   * the field, and the backdrop, being a separate element, does not follow.
   * On the built app a line long enough to overflow showed the *start* of
   * the text highlighted behind the *end* of the text, which in practice
   * meant no highlight visible at all: every recognised token had scrolled
   * out of the painted region. That is the safety valve failing precisely
   * when it matters most — a long line is exactly where an eager parser is
   * most likely to have grabbed a word the reader did not mean, and it is
   * the case a short jsdom fixture can never show, because jsdom lays out
   * nothing and never scrolls anything.
   *
   * Driven from both ends deliberately. `onScroll` catches the browser
   * moving the caret's view (typing past the edge, arrowing, dragging a
   * selection); the layout effect catches a re-render that changed the
   * text under an unchanged scroll position — pasting, or clearing the
   * field on submit — where no scroll event fires at all. Either alone
   * leaves a case where the two layers disagree.
   */
  function syncBackdropScroll() {
    const input = inputRef.current;
    const backdrop = backdropRef.current;
    if (input === null || backdrop === null) {
      return;
    }
    backdrop.scrollLeft = input.scrollLeft;
  }

  // `useLayoutEffect`, not `useEffect`: this runs before the browser
  // paints, so the backdrop never shows one frame at the old offset.
  //
  // No dependency array at all, so it runs after *every* render rather
  // than only when `value`'s identity changed. That is both cheaper to
  // reason about and strictly more correct: the thing that has to stay in
  // step is the input's live `scrollLeft`, which this component does not
  // own and cannot list as a dependency — any render that changes what
  // the field shows can move it. The work is one property read and one
  // property write against two refs, which is not worth guarding.
  useLayoutEffect(syncBackdropScroll);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = taskFieldsFromQuickAdd(value, result, options);
    // A token-only line (typing just "tomorrow" with nothing else) parses
    // to empty `content` — silently doing nothing here mirrors
    // use-tasks.ts's own addTask/renameTask, both of which already treat
    // trimmed-empty as "nothing to add" rather than a Task with no words.
    if (fields.content.trim() === "") {
      return;
    }
    onAdd(fields);
    setValue("");
    setDemotedSignatures(new Set());
  }

  // Demotes whichever token, if any, contains the position a click landed
  // on — read off the real `<input>`'s own `selectionStart`, which the
  // browser has already updated to the click position by the time this
  // handler runs. Not driven by the backdrop's own geometry: the backdrop
  // is `pointer-events-none` and purely visual (this file's own header
  // comment on why a plain `<input>` needs one at all), so it was never a
  // click target to begin with — this is what keeps demotion correct even
  // if the backdrop's highlight has drifted a pixel or two out of true
  // alignment with the real text above it (a risk a different font, a
  // different zoom level, or an IME composition can each cause on their
  // own — see this ticket's own report for what wasn't verified beyond
  // jsdom).
  function handleInputClick(event: ReactMouseEvent<HTMLInputElement>) {
    const offset = event.currentTarget.selectionStart;
    if (offset === null) {
      return;
    }
    const token = tokenAtOffset(result.tokens, offset);
    if (token === undefined) {
      return;
    }
    setDemotedSignatures((previous) => {
      const next = new Set(previous);
      next.add(tokenSignature(token));
      return next;
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 border-t border-border p-3">
      <div className="relative flex-1">
        {/*
          Purely decorative — `aria-hidden`, `pointer-events-none`, and
          every character in it rendered `text-transparent` so only each
          span's own highlight background shows through. The real
          `<input>` below carries the actual, screen-reader-visible text;
          this exists only to paint colour behind it, the identical
          "background rectangles only, real glyphs come from the real
          control" split a syntax-highlighted code field uses, chosen over
          making the real input's own text invisible (which would also
          have to fight the browser's own text-selection and IME
          rendering for that text, not just its colour).
        */}
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={cn(
            HIGHLIGHT_BOX_CLASSES,
            "pointer-events-none absolute inset-0 overflow-hidden",
          )}
        >
          <div className="flex h-full items-center whitespace-pre">
            {segments.map((segment, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are rebuilt fresh from `value`/`result.tokens` on every render (this component's own header comment on why nothing here is patched incrementally) — there is no identity to key on across renders other than position, and React never needs to preserve one span's own DOM node across a full re-derivation like this.
                key={index}
                className={cn("text-transparent", segment.highlighted && QUICK_ADD_HIGHLIGHT_CLASS)}
              >
                {segment.text}
              </span>
            ))}
          </div>
        </div>
        <Input
          ref={inputRef}
          type="text"
          placeholder="Add a Task"
          aria-label="Add a Task"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onScroll={syncBackdropScroll}
          onClick={handleInputClick}
          disabled={disabled}
          className="relative bg-transparent dark:bg-transparent"
        />
      </div>
      <Button type="submit" disabled={disabled || value.trim() === ""}>
        Add
      </Button>
    </form>
  );
}
