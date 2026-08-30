import type { Entry } from "@meologue/core";
import { ArrowUp, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { entrySnippet } from "@/components/entry-row";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { deviceUtcOffsetMinutes, entryDayKey, formatDaySeparator } from "@/lib/entry-day";
import { normalizeEntryBody } from "@/lib/entry-text";
import { parseReferenceDate } from "@/lib/inline-markdown";
import { isSubmitChord } from "@/lib/submit-chord";
import { cn } from "@/lib/utils";

/**
 * The two brackets that open a Reference (ADR 0042) — this file's own copy
 * of the literal `inline-markdown.ts`'s `referenceParser` looks for, kept
 * here rather than imported because that file exports no such constant
 * (its own scanner reads character codes, not a string) and this is the
 * only other place that needs it.
 */
const REFERENCE_TRIGGER = "[[";

/** How many recent days, and how many searched Entries, the picker shows at once — enough to be useful, small enough to stay a glance rather than a second History. */
const MAX_DATE_SUGGESTIONS = 5;
const MAX_ENTRY_SUGGESTIONS = 5;

/**
 * Where the inline `[[` picker (issue #144) is anchored, and what it's
 * currently narrowed to.
 *
 * `start` is the index in `value` immediately AFTER the triggering `[[` —
 * everything from there to the caret is `query`. Recomputed from scratch on
 * every keystroke (`derivePicker` below) rather than patched incrementally:
 * the alternative is a state machine that has to separately handle typing,
 * backspacing past the brackets, and the caret moving away, and deriving it
 * fresh from `value` and the caret position is what makes all three the
 * same code path instead of three.
 */
interface ReferencePickerState {
  start: number;
  query: string;
}

/**
 * `query` narrows to dates when it could still become a valid
 * `[[YYYY-MM-DD]]` — digits and dashes only, including the empty string
 * (freshly typed `[[`, before anything narrows it either way) — and to an
 * Entry search otherwise. There is no third "ambiguous" state: the moment a
 * letter or space appears, the query cannot be a date any more (`parseReferenceDate`
 * demands exactly four digits, a dash, two digits, a dash, two digits), so
 * a query that will only ever describe an Entry search is exactly the
 * complement of this.
 */
function isDateModeQuery(query: string): boolean {
  return /^[0-9-]*$/.test(query);
}

/**
 * The picker's own state transition, given the textarea's latest value and
 * caret position. Pure and stateless on purpose — `handleChange` below is
 * its only caller, and keeping every rule here (rather than split across
 * onChange, onKeyDown and a closing effect) is what makes "when is the
 * picker open" answerable by reading one function.
 *
 * - No picker yet: opens one exactly when the two characters immediately
 *   before the caret are the trigger — "immediately after a freshly typed
 *   `[[`", per the ticket, not merely "a `[[` exists somewhere earlier in
 *   the line".
 * - A picker already open: stays open only while the caret is still at or
 *   after `start` AND the two characters immediately before `start` are
 *   still the trigger — either condition failing means the reader moved
 *   the caret away or backspaced through one of the brackets, and the
 *   picker has nothing left to be anchored to.
 * - A query that picks up a `]` or a newline closes the picker without
 *   opening a new one: a `]` means the reader is closing the mark by hand
 *   (typing `]]` themselves is always still possible; the picker simply
 *   stops shadowing it), and a newline means whatever was being typed
 *   inside the brackets was abandoned for a new line of prose.
 */
function derivePicker(
  text: string,
  caret: number,
  previous: ReferencePickerState | null,
): ReferencePickerState | null {
  if (previous === null) {
    if (caret >= 2 && text.slice(caret - 2, caret) === REFERENCE_TRIGGER) {
      return { start: caret, query: "" };
    }
    return null;
  }
  if (
    caret < previous.start ||
    text.slice(previous.start - 2, previous.start) !== REFERENCE_TRIGGER
  ) {
    return null;
  }
  const query = text.slice(previous.start, caret);
  if (query.includes("]") || query.includes("\n")) {
    return null;
  }
  return { start: previous.start, query };
}

/**
 * Candidate days for the picker's date mode: the typed text itself, if it's
 * already a complete, real calendar date (`parseReferenceDate` — the exact
 * same validator the renderer uses, so nothing the picker offers could ever
 * render as a dead Reference later), followed by whichever of the loaded
 * recent Entries' own days contain the typed digits, newest first and
 * de-duplicated. With an empty query every recent day qualifies, which is
 * "offer recent days" for the picker's very first frame, right after `[[`.
 */
function buildDateSuggestions(
  query: string,
  recentEntries: readonly Entry[],
  offsetMinutes: number,
): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();

  const typed = parseReferenceDate(query);
  if (typed !== null) {
    suggestions.push(typed);
    seen.add(typed);
  }

  for (const candidate of recentEntries) {
    if (suggestions.length >= MAX_DATE_SUGGESTIONS) {
      break;
    }
    const day = entryDayKey(candidate.createdAt, offsetMinutes);
    if (day === null || seen.has(day)) {
      continue;
    }
    if (query !== "" && !day.includes(query)) {
      continue;
    }
    seen.add(day);
    suggestions.push(day);
  }

  return suggestions;
}

type PickerItem = { kind: "date"; date: string } | { kind: "entry"; entry: Entry };

function pickerItemKey(item: PickerItem): string {
  return item.kind === "date" ? `date:${item.date}` : `entry:${item.entry.id}`;
}

function pickerItemMark(item: PickerItem): string {
  // `[[YYYY-MM-DD]]` and `[[e:<id>]]` (ADR 0042) — built here rather than
  // imported, since inline-markdown.ts has no reason to export a
  // constructor for the marks it only ever parses.
  return item.kind === "date" ? `[[${item.date}]]` : `[[e:${item.entry.id}]]`;
}

/**
 * The imperative half of ComposerProps — issue #144's "Refer" action
 * (entry-actions.tsx, via composer-page.tsx) needs to put a Reference into
 * whichever textarea is live right now, and that can't be a plain prop:
 * unlike `onSend`/`editingEntry`, there is no piece of data the page could
 * hand down that means "and now insert this" without composer-page.tsx
 * also tracking a one-shot command has been consumed. A ref exposing a
 * single imperative method is the standard escape hatch for exactly this
 * shape of "an ancestor occasionally needs to reach into a stateful
 * descendant," and it costs nothing when unused, which the inline `[[`
 * picker's own insertion path is (it lives entirely inside this component
 * and works directly against `value`).
 */
export interface ComposerHandle {
  /**
   * Inserts `text` at the current caret, replacing any active selection —
   * the same primitive `<input>`/`<textarea>` typing itself uses. Works
   * identically whether this Composer is composing a new Entry or editing
   * one (ADR 0028): both live in the same `value` state and the same
   * textarea, so there is nothing here that has to branch on `editingEntry`
   * to "target the right place" — there is only ever one place.
   */
  insertAtCursor: (text: string) => void;
}

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
  /**
   * Recent Entries, in the store's own newest-first order — issue #144's
   * inline `[[` picker draws its date suggestions from these (the days
   * they fall on), rather than this component calling `useEntryStore()`
   * itself the way `entry-row.tsx`'s Reference renderers do. Those renderers
   * already sit inside every page that shows an Entry's body, so reaching
   * for the outlet context costs them nothing; `composer.test.tsx`'s own
   * harnesses render a bare `<Composer>` with no Router/Outlet above it at
   * all; and `onSend`/`editingEntry` above already establish that this
   * component takes what it needs as props, not hooks it reaches for on
   * its own. composer-page.tsx passes its own `entries` (already loaded via
   * `useEntryStore()`) straight through. Optional, and defaulting to
   * nothing offered, because no existing harness has any reason to supply
   * it until it actually exercises the picker.
   */
  recentEntries?: Entry[];
  /**
   * Text search across History (ADR 0014/0035) — issue #144's picker calls
   * this to find an Entry Reference's target by words typed. The very same
   * `search` composer-page.tsx already gets from `useEntryStore()`; see
   * `recentEntries`' own comment for why it arrives as a prop rather than a
   * second hook call in here. Optional for the same reason.
   */
  searchEntries?: (query: string) => Promise<Entry[]>;
  ref?: Ref<ComposerHandle>;
}

async function noopSearchEntries(): Promise<Entry[]> {
  return [];
}

export function Composer({
  onSend,
  disabled = false,
  editingEntry = null,
  onCommitEdit,
  onCancelEdit,
  recentEntries,
  searchEntries,
  ref,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // The inline `[[` picker's own state (issue #144) — see
  // ReferencePickerState's own comment. `null` means closed.
  const [picker, setPicker] = useState<ReferencePickerState | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Entries matched by `searchEntries`, for whichever query last resolved —
  // kept separate from `picker` because it arrives asynchronously and a
  // stale response must never overwrite a newer one (the `cancelled` flag
  // below is what enforces that), where `picker` itself is always exactly
  // as current as the last keystroke.
  const [entryResults, setEntryResults] = useState<Entry[]>([]);

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
    // Whatever the picker was anchored to belonged to the value this Entry
    // transition just replaced wholesale — its `start` index almost
    // certainly no longer points at a `[[` in the new text at all.
    setPicker(null);
  }, [editingEntry]);

  const dateMode = picker !== null && isDateModeQuery(picker.query);

  const offsetMinutes = deviceUtcOffsetMinutes();
  const dateSuggestions =
    picker !== null && dateMode
      ? buildDateSuggestions(picker.query, recentEntries ?? [], offsetMinutes)
      : [];

  // Issue #144: searches History for the picker's text-mode query. A plain
  // effect with a `cancelled` closure, not a TanStack Query call like
  // `use-entry-search.ts`'s own `useEntrySearch` — that hook needs a
  // `QueryClientProvider` ancestor, which every existing `composer.test.tsx`
  // harness (and every render of this component before this ticket) has
  // never needed to stand up, and sharing its cache with History's own
  // search box would mean the picker's own transient, one-off lookups sit
  // in the same cache entries as the reader's actual Search — two
  // different questions ("what does this word match, once, right now" vs.
  // "narrow the thread to this") that happen to call the same store method.
  useEffect(() => {
    if (picker === null || dateMode) {
      setEntryResults([]);
      return;
    }
    const trimmed = picker.query.trim();
    if (trimmed === "") {
      setEntryResults([]);
      return;
    }
    let cancelled = false;
    const search = searchEntries ?? noopSearchEntries;
    search(trimmed).then((results) => {
      if (!cancelled) {
        setEntryResults(results.slice(0, MAX_ENTRY_SUGGESTIONS));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [picker, dateMode, searchEntries]);

  const items: PickerItem[] =
    picker === null
      ? []
      : dateMode
        ? dateSuggestions.map((date) => ({ kind: "date" as const, date }))
        : entryResults.map((entry) => ({ kind: "entry" as const, entry }));
  const clampedHighlight = items.length === 0 ? -1 : Math.min(highlightIndex, items.length - 1);
  const todayKey = entryDayKey(new Date().toISOString(), offsetMinutes) ?? "";

  /**
   * Splices `text` into `value` between `start` and `end` (an empty range
   * for a plain caret insertion), then puts the real caret right after it.
   *
   * `flushSync` wraps the state update rather than letting it batch
   * normally: `setSelectionRange` right after has to run against the
   * textarea's OWN already-updated `value` — a native element's selection
   * cannot be placed past the end of whatever text it currently holds, so
   * setting it against the stale, pre-update DOM (what an unflushed,
   * batched update would still show) would just clamp to the old, shorter
   * length instead of landing where the inserted text ends. This is the
   * one piece of DOM state (an `<textarea>`'s own caret) React does not
   * own or reconcile, so it is the one piece this file ever reaches past
   * React for.
   *
   * `el.focus()` before setting the range is what makes choosing a
   * suggestion by clicking still work: the click already moved focus onto
   * that `<button>`, and a caret position set on an unfocused textarea is
   * silently discarded by every browser.
   */
  const commitInsertion = useCallback((start: number, end: number, text: string) => {
    const el = textareaRef.current;
    const nextCaret = start + text.length;
    flushSync(() => {
      setValue((current) => `${current.slice(0, start)}${text}${current.slice(end)}`);
    });
    if (el) {
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    }
  }, []);

  function chooseItem(item: PickerItem) {
    if (picker === null) {
      return;
    }
    // Drops the triggering `[[` itself (`picker.start - 2`) along with
    // whatever was typed after it, and replaces the whole span with the
    // completed mark — never a raw uuid: `pickerItemMark` builds
    // `[[e:<id>]]`/`[[YYYY-MM-DD]]`, and nothing in this file, or in the
    // list rendered below, ever shows an id as text a reader would read.
    commitInsertion(picker.start - 2, picker.start + picker.query.length, pickerItemMark(item));
    setPicker(null);
  }

  // The "Refer" action (entry-actions.tsx, via composer-page.tsx) reaches
  // in through this — see ComposerHandle's own comment for why it has to
  // be imperative at all. `insertAtCursor` reads the *current* selection
  // off the DOM node rather than assuming the caret sits at the end of
  // `value`: a reader who chose Refer after clicking back into the middle
  // of a longer draft should get the Reference where their caret actually
  // was, and a real `<textarea>` keeps that position even while unfocused
  // (opening EntryActionsSheet blurs it), which is exactly the state this
  // reads.
  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor(text: string) {
        const el = textareaRef.current;
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? start;
        commitInsertion(start, end, text);
      },
    }),
    [value, commitInsertion],
  );

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

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setValue(nextValue);
    const caret = event.target.selectionStart ?? nextValue.length;
    setPicker((previous) => derivePicker(nextValue, caret, previous));
    setHighlightIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Checked first, and unconditionally: Cmd/Ctrl+Enter must still Send
    // no matter what the picker is doing (issue #144's own requirement) —
    // closing the picker here rather than leaving it for `send()`'s own
    // `setValue("")` is what stops a picker anchored into the just-cleared
    // draft from reopening against whatever the reader types next.
    if (isSubmitChord(event)) {
      event.preventDefault();
      setPicker(null);
      send();
      return;
    }
    if (picker !== null) {
      if (event.key === "Escape") {
        // Closes the picker without inserting anything (issue #144) and
        // swallows the keystroke entirely — deliberately not falling
        // through to the `editingEntry` Escape below in the same press.
        // Cancelling an edit is still one more Escape away; a single
        // keystroke should not both close a list AND leave edit mode, two
        // unrelated things happening on the one press a reader meant for
        // only the picker they're looking at.
        event.preventDefault();
        setPicker(null);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length > 0) {
          setHighlightIndex((index) => (index + 1) % items.length);
        }
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length > 0) {
          setHighlightIndex((index) => (index - 1 + items.length) % items.length);
        }
        return;
      }
      // Plain Enter selects the highlighted suggestion instead of its usual
      // job (send, or insert a newline) — conventional for an open
      // autocomplete list, and safe to claim here specifically because the
      // real Send chord was already handled above, before this block ever
      // runs. Shift+Enter is excluded for the same reason `isSubmitChord`
      // excludes it everywhere else: it's the browser's own "definitely a
      // newline" gesture. With nothing to select (no matches yet), Enter
      // is left alone and falls through to its ordinary newline behaviour
      // below — a picker with an empty list has nothing this keystroke
      // could commit to.
      const highlighted = clampedHighlight >= 0 ? items[clampedHighlight] : undefined;
      if (event.key === "Enter" && !event.shiftKey && highlighted) {
        event.preventDefault();
        chooseItem(highlighted);
        return;
      }
    }
    // Issue #76: plain Enter is no longer Send on any platform — it falls
    // through and lets the textarea insert its own newline, the same as
    // every other unhandled key. Only the platform-specific chord
    // (submit-chord.ts) sends; letting Enter through with no
    // preventDefault() is what makes multi-line composition possible at
    // all, since Shift+Enter was previously the *only* way to get a
    // newline in here.
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
        {/* `relative` anchors the picker (issue #144) to the field itself
            rather than to the whole docked bar, and `min-w-0` keeps this
            wrapper from fighting the Send button for width the way an
            unconstrained flex child would. */}
        <div className="relative min-w-0 flex-1">
          {picker !== null && (
            // Opens upward (`bottom-full`), never down: the Composer is
            // docked to the bottom of the screen (this component's own
            // outer comment), so a list opening below the field would be
            // fighting the keyboard, the safe area, or simply the bottom of
            // the window for room it doesn't have.
            <div
              role="listbox"
              aria-label={dateMode ? "Days" : "Entries"}
              className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full max-w-xs overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
            >
              {items.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {dateMode ? "No matching day" : "No matching Entry"}
                </p>
              ) : (
                items.map((item, index) => (
                  <button
                    key={pickerItemKey(item)}
                    type="button"
                    role="option"
                    aria-selected={index === clampedHighlight}
                    // Mouse hover moves the highlight to match, the same
                    // convention a native `<select>` or menu follows — a
                    // reader who switches from keyboard narrowing to
                    // pointing at an item should see the same item Enter
                    // would have picked.
                    onMouseEnter={() => setHighlightIndex(index)}
                    onClick={() => chooseItem(item)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm",
                      index === clampedHighlight
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                  >
                    {item.kind === "date" ? (
                      <>
                        <span className="font-medium">
                          {formatDaySeparator(item.date, todayKey)}
                        </span>
                        <span className="text-xs text-muted-foreground">{item.date}</span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium">
                          {(() => {
                            const day = entryDayKey(item.entry.createdAt, offsetMinutes);
                            return day === null
                              ? "An earlier Entry"
                              : formatDaySeparator(day, todayKey);
                          })()}
                        </span>
                        {/* The Entry's own opening words, never its id
                            (ADR 0042: an id names nothing a reader can
                            use) — the same `entrySnippet` entry-row.tsx's
                            own chip preview uses, so a picker candidate and
                            the chip it becomes once inserted read the same
                            way. */}
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {entrySnippet(item.entry.body)}
                        </span>
                      </>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            placeholder="What's on your mind?"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            // ui/textarea.tsx already sizes to content via field-sizing:
            // content; min-h/max-h here are what turn that unbounded growth
            // into ticket 51's "one line, grows to about five, then scrolls."
            // Sending clears `value`, and field-sizing shrinks the box back to
            // min-h on its own — no row-count state to track.
            //
            // `leading-6` and an exact max-height, rather than `max-h-36`:
            // the ceiling has to be a whole number of lines plus the padding
            // and border, or the field clips its own last line horizontally
            // through the glyphs at full height. 36 (144px) was not — it left
            // a third of a sixth line showing. Pinning the line box at 24px
            // also stops the count changing between the base and `md` font
            // sizes, which is why it is set here rather than inherited.
            // 5 lines x 24px + 16px padding + 2px border = 138px.
            //
            // The focus ring is gated to hover-capable devices. `:focus-visible`
            // always matches a focused text field per spec, so on a phone
            // tapping the Composer painted a 3px ring around it — a
            // browser-shaped artefact on a surface that should look like a
            // chat input. Gating on `(hover: hover)` mirrors the same
            // pointer-capability split `entry-actions.tsx` already makes.
            className="min-h-11 max-h-[8.625rem] w-full resize-none overflow-y-auto rounded-3xl leading-6 focus-visible:ring-0 [@media(hover:hover)]:focus-visible:ring-3"
          />
        </div>
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
          // Empty is not sendable — `send` already refuses it (entry-text.ts
          // rejects a blank draft), so a Send that looks live over an empty
          // field is the button lying about what it will do.
          disabled={disabled || value.trim() === ""}
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </Button>
      </div>
    </div>
  );
}
