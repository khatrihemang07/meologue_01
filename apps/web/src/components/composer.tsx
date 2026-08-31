/**
 * The Composer: where an Entry is written, and — ADR 0028 — where an
 * existing Entry is edited. Issue #155 replaces its `<textarea>` with a
 * ProseMirror `EditorView` holding a live document (issue #154's
 * `entrySchema`), so formatting appears as it's typed instead of only
 * after Send (ADR 0044).
 *
 * `EditorView` is wired up imperatively, in refs, rather than through a
 * React-owned tree of its content: ProseMirror already owns its DOM once
 * mounted (it patches its own `contenteditable` on every transaction), and
 * fighting that with React's own reconciliation over the same nodes is
 * exactly the kind of two-owners bug ADR 0036 already names once ("passed
 * every test and was wrong on screen"). The view is constructed once, in
 * the mount effect below, and never torn down for an ordinary re-render;
 * `handleKeyDownImplRef`/`dispatchTransactionImplRef` are the seam that
 * lets its callbacks see fresh `picker`/`editingEntry`/... closures on
 * every render without reconstructing the view itself — assigned directly
 * in the render body (never read back during the same render), the
 * standard "latest callback" ref pattern.
 *
 * No test in this file renders `<Composer>` any more. jsdom implements no
 * `Range`, no `Selection`, and no meaningful `getBoundingClientRect` — a
 * ProseMirror `EditorView` cannot usefully mount in it, let alone be typed
 * into (ADR 0044 records this, and the corresponding upstream limitation on
 * Android). Everything here that stayed pure moved to its own module
 * instead, where it IS still unit-tested: composer-picker.ts (the `[[`
 * picker's own state machine and suggestion-building) and composer-send.ts
 * (what pressing Send should do, including ADR 0044's dirty-only commit
 * rule). Real typing, caret behaviour, the picker, and list Enter/lift live
 * in apps/e2e/tests/composer.spec.ts instead, against a real browser.
 */
import type { Entry } from "@meologue/core";
import { ArrowUp, X } from "lucide-react";
import { EditorState, Selection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { entrySnippet } from "@/components/entry-row";
import { Button } from "@/components/ui/button";
import {
  buildComposerPlugins,
  listItemNodeView,
  PICKER_DISMISS_META,
  paragraphNodeView,
  pickerPluginKey,
  referenceNodeType,
  referenceNodeView,
} from "@/lib/composer-editor";
import {
  buildDateSuggestions,
  isDateModeQuery,
  MAX_ENTRY_SUGGESTIONS,
  type PickerItem,
  pickerItemKey,
  pickerItemMark,
  type ReferencePickerState,
} from "@/lib/composer-picker";
import { decideSend } from "@/lib/composer-send";
import { deviceUtcOffsetMinutes, entryDayKey, formatDaySeparator } from "@/lib/entry-day";
import { entryDocumentToMarkdown, entryMarkdownToDocument } from "@/lib/entry-document";
import { entrySchema, type ReferenceAttrs } from "@/lib/entry-schema";
import { normalizeEntryBody } from "@/lib/entry-text";
import { parseReferenceDate } from "@/lib/inline-markdown";
import { isSubmitChord } from "@/lib/submit-chord";
import { cn } from "@/lib/utils";

/** The Composer's own placeholder, shown by composer-editor.ts's `placeholderPlugin` and duplicated here as a literal HTML `placeholder` attribute (composer-editor.ts's `buildComposerPlugins`' own EditorView `attributes`) purely so `apps/e2e`'s `getByPlaceholder("What's on your mind?")` keeps finding this field — a `<div>` has no native `placeholder` semantics, but Playwright's own locator matches the bare attribute on any element (verified against playwright-core's `getByAttributeTextSelector`), so setting it costs nothing and keeps every existing e2e helper working unchanged. */
const PLACEHOLDER = "What's on your mind?";

/**
 * The editable root's own Tailwind classes, appended onto ProseMirror's
 * base `"ProseMirror"` class through the `attributes` prop rather than a
 * React `className` — see the mount effect's own comment for why a
 * `className` on the JSX `<div>` below would just be overwritten.
 *
 * `min-h`/`max-h`/`overflow-y-auto` are what turn a `contenteditable`'s
 * natural block growth into "one line, grows to about eight, then
 * scrolls" — there is no `field-sizing: content` equivalent needed here
 * the way the old `<textarea>` needed one, since a `contenteditable`'s own
 * height already tracks its content without it.
 *
 * `leading-6` and an exact max-height, rather than a round Tailwind
 * spacing step: the ceiling has to be a whole number of lines plus the
 * padding and border, or the field clips its own last line horizontally
 * through the glyphs at full height (verified against the previous 5-line
 * ceiling this replaces — 36 (144px) was not a whole-line value and left a
 * third of a sixth line showing). Pinning the line box at 24px also stops
 * the count changing between the base and `md` font sizes.
 * 8 lines x 24px + 16px padding (`py-2`) + 2px border = 210px.
 *
 * The focus ring is gated to hover-capable devices, mirroring
 * entry-actions.tsx's own pointer-capability split — `:focus-visible`
 * always matches a focused text field per spec, so on a phone tapping the
 * Composer would otherwise paint a 3px ring around it, a browser-shaped
 * artefact on a surface that should look like a chat input.
 *
 * `disabled` classes are applied directly (a plain conditional, not a
 * `:disabled` pseudo-class): a `<div>`, unlike a real form control, never
 * matches `:disabled` even with `aria-disabled` set.
 */
function hostClassName(disabled: boolean): string {
  return cn(
    "min-h-11 max-h-[13.125rem] w-full overflow-y-auto rounded-3xl border border-input bg-transparent px-2.5 py-2 leading-6 text-base outline-none transition-colors focus-visible:ring-0 md:text-sm [@media(hover:hover)]:focus-visible:ring-3",
    disabled && "cursor-not-allowed bg-input/50 opacity-50",
  );
}

const DATE_MARK_SHAPE = /^\[\[(\d{4}-\d{2}-\d{2})\]\]$/;
const ENTRY_MARK_SHAPE = /^\[\[e:([0-9a-fA-F-]{36})\]\]$/;

/**
 * The inverse of `pickerItemMark` (composer-picker.ts): recognises the two
 * literal shapes that function — and nothing else in this app — ever
 * produces, and turns one back into the attrs a live `reference` node
 * needs. Used by `insertAtCursor` below, whose only real caller
 * (`composer-page.tsx`'s "Refer" action) always passes exactly
 * `` `[[e:${entry.id}]]` ``. Anything that doesn't match either shape falls
 * back to plain text in `insertAtCursor` itself — this is deliberately not
 * a second Markdown parser (ADR 0044): it recognises two fixed literal
 * templates, not the dialect `inline-markdown.ts` already owns.
 */
function parseReferenceMarkText(raw: string): ReferenceAttrs | null {
  const dateMatch = DATE_MARK_SHAPE.exec(raw);
  if (dateMatch) {
    const date = dateMatch[1];
    if (date !== undefined && parseReferenceDate(date) !== null) {
      return { kind: "date", raw, date, entryId: null };
    }
    return null;
  }
  const entryMatch = ENTRY_MARK_SHAPE.exec(raw);
  if (entryMatch) {
    const entryId = entryMatch[1];
    if (entryId !== undefined) {
      return { kind: "entry", raw, date: null, entryId };
    }
  }
  return null;
}

function referenceAttrsForItem(item: PickerItem): ReferenceAttrs {
  return item.kind === "date"
    ? { kind: "date", raw: pickerItemMark(item), date: item.date, entryId: null }
    : { kind: "entry", raw: pickerItemMark(item), date: null, entryId: item.entry.id };
}

/**
 * The imperative half of ComposerProps — issue #144's "Refer" action
 * (entry-actions.tsx, via composer-page.tsx) needs to put a Reference into
 * whichever editor is live right now, and that can't be a plain prop:
 * unlike `onSend`/`editingEntry`, there is no piece of data the page could
 * hand down that means "and now insert this" without composer-page.tsx
 * also tracking a one-shot command has been consumed. A ref exposing a
 * single imperative method is the standard escape hatch for exactly this
 * shape of "an ancestor occasionally needs to reach into a stateful
 * descendant," and it costs nothing when unused.
 */
export interface ComposerHandle {
  /**
   * Inserts `text` at the current selection, replacing it if non-empty —
   * the ProseMirror-transaction successor to the old `<textarea>`'s own
   * `setSelectionRange` + `flushSync` hack (issue #155 deletes both
   * `insertAtCursor`'s old body and the sibling `commitInsertion` helper it
   * shared with the picker's own insertion path, below). Works identically
   * whether this Composer is composing a new Entry or editing one (ADR
   * 0028): both live in the same `EditorView`, so there is nothing here
   * that has to branch on `editingEntry`.
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
   * a new one. See composer.tsx's own git history for the fuller
   * rationale (unchanged by issue #155): the Composer is where editing
   * happens rather than an inline editor on the row itself.
   *
   * Owned by the page (composer-page.tsx), not the Composer itself.
   */
  editingEntry?: Entry | null;
  /** Commits the edit — Send, while `editingEntry` is set AND the document actually changed (ADR 0044's dirty-only commit rule). Required together with `editingEntry`. */
  onCommitEdit?: (id: string, body: string) => void;
  /** Escape, the visible Cancel control, or Send on an Entry nobody actually edited (ADR 0044) — leaves edit mode without committing anything. */
  onCancelEdit?: () => void;
  /**
   * Recent Entries, in the store's own newest-first order — issue #144's
   * inline `[[` picker draws its date suggestions from these. See
   * composer-picker.ts's `buildDateSuggestions`.
   */
  recentEntries?: Entry[];
  /** Text search across History (ADR 0014/0035) — issue #144's picker calls this to find an Entry Reference's target by words typed. */
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
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Every plugin the editor needs, built exactly once per Composer
  // instance (a lazy `useState` initializer, not a bare call in the render
  // body) — `loadDocument` below reuses this SAME array every time it
  // swaps the document out for a fresh `EditorState`, since plugin state
  // (the picker's, undo history's) is meant to reset on a document swap,
  // but the plugin OBJECTS themselves have no reason to be rebuilt.
  const [plugins] = useState(() => buildComposerPlugins(PLACEHOLDER));

  // Whatever was mid-composition the instant edit mode started (ADR 0028)
  // — restored when edit mode ends, whether by Cancel, Escape, or a
  // successful (dirty) commit. Holds the serialized Markdown, the same
  // representation `onSend`/`onCommitEdit` themselves use, rather than a
  // `Node`: it only ever needs to survive being handed back to
  // `entryMarkdownToDocument` once, and a string is trivially copyable
  // where a `Node` from a specific `EditorState` is not.
  const draftBeforeEditRef = useRef("");
  // The previous render's `editingEntry.id` (or null) — same role as
  // composer.tsx's pre-#155 version: lets the effect below tell "just
  // started editing," "still editing the same Entry" and "just stopped
  // editing" apart.
  const previousEditingIdRef = useRef<string | null>(null);
  // ADR 0044's dirty-only commit rule: true once any transaction since the
  // document was last (re)loaded actually changed it
  // (`transaction.docChanged`) — reset every time `loadDocument` swaps the
  // document out (a fresh compose, or a freshly seeded edit). `send()`
  // reads this through `decideSend` (composer-send.ts) rather than
  // re-deriving it from the doc itself: `docChanged` is the one signal
  // that distinguishes "the reader clicked into the field and back out"
  // from "the reader actually typed something," which comparing the
  // before/after Markdown could not — a normalizing serializer could make
  // an untouched Entry's own round-trip look identical to its original
  // text, or, just as wrongly, look different from it.
  const dirtyRef = useRef(false);

  // Mirrors `normalizeEntryBody(entryDocumentToMarkdown(doc)) === null` —
  // kept as React state (rather than read fresh at render time) because
  // computing it means running the serializer, and the Send button's
  // `disabled` prop needs a value on every render, not just the ones where
  // a transaction happened to fire beforehand.
  const [isEmpty, setIsEmpty] = useState(true);

  // The inline `[[` picker's own state (issue #144) — mirrored from
  // composer-editor.ts's `pickerPlugin`, which derives it fresh from the
  // document and selection on every transaction (see that module's own
  // comment). `null` means closed.
  const [picker, setPicker] = useState<ReferencePickerState | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Entries matched by `searchEntries`, for whichever query last resolved
  // — kept separate from `picker` because it arrives asynchronously and a
  // stale response must never overwrite a newer one (the `cancelled` flag
  // below is what enforces that).
  const [entryResults, setEntryResults] = useState<Entry[]>([]);

  const dateMode = picker !== null && isDateModeQuery(picker.query);
  const offsetMinutes = deviceUtcOffsetMinutes();
  const dateSuggestions =
    picker !== null && dateMode
      ? buildDateSuggestions(picker.query, recentEntries ?? [], offsetMinutes)
      : [];

  // Issue #144: searches History for the picker's text-mode query. See the
  // pre-#155 composer.tsx for why this is a plain effect with a
  // `cancelled` closure rather than a TanStack Query call — unchanged by
  // this ticket.
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
   * Swaps the editor's document out for a fresh one built from `body`,
   * resetting every plugin's own state along with it (the picker closes,
   * undo history starts clean) — used on mount, on every `editingEntry`
   * transition, and after a successful new-Entry Send. Bypasses
   * `dispatchTransaction` entirely (`updateState`, not `dispatch`), so it
   * also owns updating `isEmpty` itself rather than leaving that to the
   * dispatch hook, which only ever sees a `Transaction`.
   *
   * The selection is placed at the END of the freshly seeded document
   * (`Selection.atEnd`), not left to `EditorState.create`'s own default
   * (the very start) — this is what makes `insertAtCursor`'s "Refer"
   * action land after whatever the seeded body already says, matching the
   * pre-#155 `<textarea>`'s own default (`el?.selectionStart ?? value.length`)
   * for a field nothing has explicitly placed a caret into yet.
   */
  const loadDocument = useCallback(
    (view: EditorView, body: string) => {
      const doc = entryMarkdownToDocument(body);
      view.updateState(
        EditorState.create({ schema: entrySchema, doc, plugins, selection: Selection.atEnd(doc) }),
      );
      setIsEmpty(normalizeEntryBody(entryDocumentToMarkdown(doc)) === null);
    },
    [plugins],
  );

  function chooseItem(item: PickerItem) {
    const view = viewRef.current;
    if (view === null || picker === null) {
      return;
    }
    // Drops the triggering `[[` itself (`picker.start - 2`) along with
    // whatever was typed after it, and replaces the whole span with a
    // live `reference` node — never a raw uuid as text: `referenceAttrsForItem`
    // carries the id in the node's own attrs, and nothing in this file, or
    // in the list rendered below, ever shows an id as text a reader would
    // read.
    const from = picker.start - 2;
    const to = picker.start + picker.query.length;
    const node = referenceNodeType.create(referenceAttrsForItem(item));
    view.dispatch(view.state.tr.replaceRangeWith(from, to, node));
    view.focus();
  }

  function closePicker() {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    // See composer-editor.ts's own comment on `PICKER_DISMISS_META` for
    // why this needs to be a meta flag rather than a plain `setPicker(null)`.
    view.dispatch(view.state.tr.setMeta(pickerPluginKey, PICKER_DISMISS_META));
  }

  const send = useCallback(() => {
    const view = viewRef.current;
    if (disabled || view === null) {
      return;
    }
    const rawBody = entryDocumentToMarkdown(view.state.doc);
    const decision = decideSend({
      editingEntryId: editingEntry?.id ?? null,
      rawBody,
      dirty: dirtyRef.current,
    });
    if (decision.kind === "refuseEmpty") {
      return;
    }
    if (decision.kind === "cancelUnchanged") {
      // ADR 0044: nothing to write, so this leaves edit mode exactly the
      // way Cancel does — the page's own `editingEntry` transition below
      // is what actually restores the stashed draft.
      onCancelEdit?.();
      return;
    }
    if (decision.kind === "commit") {
      onCommitEdit?.(decision.id, decision.body);
      return;
    }
    onSend(decision.body);
    loadDocument(view, "");
    dirtyRef.current = false;
  }, [disabled, editingEntry, onCancelEdit, onCommitEdit, onSend, loadDocument]);

  const cancelEdit = useCallback(() => {
    onCancelEdit?.();
  }, [onCancelEdit]);

  // Latest-callback indirection (this file's own module comment) — reassigned
  // every render so the mounted `EditorView`'s `handleKeyDown`/
  // `dispatchTransaction` props always see this render's `picker`,
  // `items`, `editingEntry`, etc. without the view itself ever being
  // rebuilt.
  const handleKeyDownImplRef = useRef<(view: EditorView, event: KeyboardEvent) => boolean>(
    () => false,
  );
  handleKeyDownImplRef.current = (_view, event) => {
    // Checked first, and unconditionally: Cmd/Ctrl+Enter must still Send
    // no matter what the picker is doing (issue #144's own requirement).
    if (isSubmitChord(event)) {
      event.preventDefault();
      send();
      return true;
    }
    if (picker !== null) {
      if (event.key === "Escape") {
        // Closes the picker without inserting anything and swallows the
        // keystroke entirely — deliberately not falling through to the
        // `editingEntry` Escape below in the same press. Cancelling an
        // edit is still one more Escape away.
        event.preventDefault();
        closePicker();
        return true;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length > 0) {
          setHighlightIndex((index) => (index + 1) % items.length);
        }
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length > 0) {
          setHighlightIndex((index) => (index - 1 + items.length) % items.length);
        }
        return true;
      }
      // Plain Enter selects the highlighted suggestion instead of its usual
      // job (send, or split/lift a list item) — conventional for an open
      // autocomplete list, and safe to claim here specifically because the
      // real Send chord was already handled above. Shift+Enter is excluded
      // for the same reason `isSubmitChord` excludes it everywhere else.
      // With nothing to select, Enter is left alone (returns `false`) and
      // falls through to ProseMirror's own list/paragraph handling below —
      // a picker with an empty list has nothing this keystroke could
      // commit to.
      const highlighted = clampedHighlight >= 0 ? items[clampedHighlight] : undefined;
      if (event.key === "Enter" && !event.shiftKey && highlighted) {
        event.preventDefault();
        chooseItem(highlighted);
        return true;
      }
    }
    if (event.key === "Escape" && editingEntry) {
      event.preventDefault();
      cancelEdit();
      return true;
    }
    // Not handled here — falls through to composer-editor.ts's own
    // keymap plugins (list Enter/lift, then baseKeymap's ordinary
    // paragraph split) and, for anything that isn't a keymap binding at
    // all, prosemirror-inputrules' `handleTextInput` (the `**bold**`/`- `/
    // etc. rules).
    return false;
  };

  const dispatchTransactionImplRef = useRef<(tr: Transaction) => void>(() => {});
  dispatchTransactionImplRef.current = (tr) => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    const newState = view.state.apply(tr);
    view.updateState(newState);
    if (tr.docChanged) {
      dirtyRef.current = true;
      setIsEmpty(normalizeEntryBody(entryDocumentToMarkdown(newState.doc)) === null);
    }
    const nextPicker = pickerPluginKey.getState(newState) ?? null;
    if ((nextPicker?.query ?? null) !== (picker?.query ?? null)) {
      setHighlightIndex(0);
    }
    setPicker(nextPicker);
  };

  // The `disabled` prop, readable from the `EditorView`'s own `editable`/
  // `attributes` functions — both are re-invoked on every `updateState`,
  // but nothing forces one when `disabled` changes without a transaction
  // (the store finishing its async open, ticket 21), so the effect below
  // forces a resync explicitly.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Read by the `attributes` function below for the editable root's
  // `aria-label` — kept as a ref, alongside `disabledRef`, rather than a
  // dependency the mount effect closes over, for the same reason: the
  // `EditorView` is built once and its `attributes` function is called
  // fresh by ProseMirror on every `updateState`, so a ref is all a value
  // that changes on ordinary re-renders needs.
  const editingLabelRef = useRef(editingEntry ? "Edit Entry" : "Compose Entry");
  editingLabelRef.current = editingEntry ? "Edit Entry" : "Compose Entry";

  // Mount-only: the `EditorView` is constructed exactly once per Composer
  // instance and lives until unmount — see this file's own module comment
  // for why. `editingEntry`'s own initial value, if somehow already set on
  // first mount, is picked up by the effect below rather than seeded here
  // directly, the same way `useState("")` (this component's pre-#155
  // shape) always started empty regardless of `editingEntry` and let its
  // own effect do the real seeding.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — reconstructing the EditorView on every render would lose focus and undo history for no benefit; every later change reaches it through the ref indirection above or the dedicated effects below.
  useEffect(() => {
    if (hostRef.current === null) {
      return;
    }
    const state = EditorState.create({
      schema: entrySchema,
      doc: entryMarkdownToDocument(""),
      plugins,
    });
    const view = new EditorView(
      { mount: hostRef.current },
      {
        state,
        editable: () => !disabledRef.current,
        nodeViews: {
          paragraph: () => paragraphNodeView(),
          list_item: (node, nodeView, getPos) => listItemNodeView(node, nodeView, getPos),
          reference: (node) => referenceNodeView(node),
        },
        // ProseMirror owns `view.dom`'s attributes outright once mounted
        // (it recomputes and re-applies them from this function on every
        // `updateState`, `class` additively onto its own base "ProseMirror"
        // class, everything else verbatim) — setting any of these instead
        // as a React `className`/`role`/`aria-*` prop on the JSX `<div>`
        // below would just be overwritten the moment the view first
        // renders, so all of it lives here instead.
        attributes: () => ({
          class: hostClassName(disabledRef.current),
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": editingLabelRef.current,
          placeholder: PLACEHOLDER,
          ...(disabledRef.current ? { "aria-disabled": "true" } : {}),
        }),
        handleKeyDown: (currentView, event) => handleKeyDownImplRef.current(currentView, event),
        dispatchTransaction: (tr) => dispatchTransactionImplRef.current(tr),
      },
    );
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Forces `attributes`/`editable` to re-run against the fresh `disabledRef`
  // set just above — `updateState` with the SAME state is ProseMirror's
  // own idiom for "resync view-level props onto the DOM without touching
  // the document." The effect body reads `disabledRef.current`, not
  // `disabled` itself (biome's static analysis can't see that the two move
  // together, so it reads `disabled` as an unused dependency) — but
  // `disabled` genuinely has to stay the dependency: it's the prop change
  // this effect exists to react to, and dropping it (biome's own suggested
  // fix) would mean a store finishing its async open (ticket 21) never
  // resyncs the editable/aria-disabled state at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `disabled` is read through `disabledRef.current`, updated in the render body just above — see the comment above.
  useEffect(() => {
    const view = viewRef.current;
    if (view !== null) {
      view.updateState(view.state);
    }
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    const currentId = editingEntry?.id ?? null;
    if (currentId === previousEditingIdRef.current) {
      return;
    }
    if (currentId !== null) {
      if (previousEditingIdRef.current === null) {
        // Entering edit mode: stash the live draft and seed the field with
        // the Entry's own body.
        draftBeforeEditRef.current = entryDocumentToMarkdown(view.state.doc);
      }
      // Switching which Entry is being edited without cancelling first (the
      // History context menu allows this) reseeds from the new Entry; the
      // already-stashed pre-edit draft is untouched either way, so it's
      // still what Cancel restores.
      loadDocument(view, editingEntry?.body ?? "");
    } else {
      // Left edit mode — Cancel, Escape, an unchanged Send (ADR 0044), or
      // the page cleared `editingEntry` after a successful commit. Either
      // way, restore whatever was mid-composition before.
      loadDocument(view, draftBeforeEditRef.current);
      draftBeforeEditRef.current = "";
    }
    dirtyRef.current = false;
    setPicker(null);
    setHighlightIndex(0);
    previousEditingIdRef.current = currentId;
  }, [editingEntry, loadDocument]);

  // The "Refer" action (entry-actions.tsx, via composer-page.tsx) reaches
  // in through this — see ComposerHandle's own comment for why it has to
  // be imperative at all.
  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor(text: string) {
        const view = viewRef.current;
        if (view === null) {
          return;
        }
        const attrs = parseReferenceMarkText(text);
        const { from, to } = view.state.selection;
        const tr =
          attrs !== null
            ? view.state.tr.replaceRangeWith(from, to, referenceNodeType.create(attrs))
            : view.state.tr.insertText(text, from, to);
        view.dispatch(tr);
        view.focus();
      },
    }),
    [],
  );

  return (
    // Docked to Shell's composerSlot (ticket 51, #49's Discord layout) rather
    // than scrolling with the rest of the page — unchanged by issue #155;
    // see this component's own git history for the fuller layout rationale.
    <div className="shrink-0 border-t border-border bg-background [padding-bottom:var(--safe-bottom)]">
      {editingEntry && (
        // The visible half of "this is an edit, not a new Send" (ADR 0028).
        // Escape (handleKeyDownImplRef above) is the keyboard half of the
        // edit indicator.
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
            // docked to the bottom of the screen, so a list opening below
            // the field would be fighting the keyboard, the safe area, or
            // simply the bottom of the window for room it doesn't have.
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
          {/* The `contenteditable` ProseMirror takes over on mount — see the
              mount effect's own `attributes` function (and `hostClassName`'s
              own comment, above) for why this element carries no
              className/role/aria-* of its own here: ProseMirror recomputes
              and re-applies all of it, on every `updateState`, from that
              function instead. */}
          <div ref={hostRef} />
        </div>
        <Button
          aria-label="Send"
          size="icon-lg"
          // Ticket 51 replaces the labelled rectangle with an icon button;
          // aria-label keeps "Send" as the accessible name the e2e suite
          // already queries by. size-11 (44px) meets the platform
          // tap-target minimum the icon-lg token alone (36px) doesn't reach.
          className="size-11 shrink-0 self-end rounded-full"
          onClick={send}
          disabled={disabled || isEmpty}
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </Button>
      </div>
    </div>
  );
}
