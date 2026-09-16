/**
 * The `#project` / `@label` autocomplete popup — issue #226's own second
 * half, left unbuilt by the ledger's QA-13/QA-14 rows
 * (`meologue-reference/todoist/parity-ledger.md`): the parser already
 * recognises `#project`/`@label` tokens
 * (`packages/core/src/quick-add/rules.ts`'s `matchProject`/`matchLabel`),
 * but nothing ever showed a picker while typing one. This file is the
 * ProseMirror side of that picker — a plugin that watches the caret for a
 * live `#`/`@` trigger and turns it into a filtered option list;
 * `quick-add-autocomplete-listbox.tsx` is the React-rendered `role="listbox"`
 * this plugin's own state drives, and `task-title-editor.tsx` is where the
 * two are wired together (its own header comment on why a decoration
 * plugin, not a second contenteditable, is how this app builds anything
 * that has to live *inside* the title's own text).
 *
 * **What Todoist's own capture establishes** (`quick-add.md` § "Autocomplete
 * popups", `live-audit-dom/qa-flow-QA-13-14.json`,
 * `live-audit-dom/flow10-QA-14-todoist.json`):
 * - `data-testid="content-editor-suggestions-dropdown"`, `role="listbox"`
 *   with `role="option"` rows, opened the instant `#`/`@` is typed.
 * - `#` lists every Project, filtered as more is typed; `@` lists every
 *   Label the same way. A query that matches nothing shows one fallback row,
 *   *"Project not found.Create <text>"* / *"Label not found.Create <text>"*
 *   (the DOM text runs the two sentences together with no visible
 *   separator — rendered here as two stacked lines for legibility, since
 *   the ledger's own artifact never claims that concatenation is
 *   meaningful, only that it is what got captured).
 * - The composer's own `role` flips from `textbox` to `combobox` while the
 *   popup is open (`qa-flow-QA-13-14.json`'s `role_of_composer_while_open`).
 *
 * **What is NOT established, and where this file makes its own call**
 * (flagged again in `task-title-editor.tsx`'s own integration and in this
 * ticket's report): the exact filter algorithm (substring vs. prefix), the
 * "Inbox first, then a My Projects heading" grouping, and arrow-key
 * navigation itself ("inconclusive" per `quick-add.md`) were never
 * measured. This module filters by a case-insensitive substring match, in
 * whatever order its caller's own Project/Label list is already in, and
 * implements a plain circular ArrowUp/ArrowDown — a standard listbox
 * pattern, not a Todoist measurement.
 */

import type { EditorState, Transaction } from "prosemirror-state";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** The bare shape this module needs from a real Project or Label — issue #229's own `Project`/`Label` types carry far more, but nothing here reads past `id`/`name`. */
export interface AutocompleteEntry {
  readonly id: string;
  readonly name: string;
}

export type AutocompleteSigil = "#" | "@";

/** One rendered row: a real entry, or the "not found" fallback that carries the literal query so `Create <text>` (and the token inserted on selecting it) can show what the reader actually typed. */
export type AutocompleteOptionRow =
  | { readonly kind: "entry"; readonly entry: AutocompleteEntry }
  | { readonly kind: "create"; readonly query: string };

/**
 * Live data + the create hooks, the way `todo-quick-add-recognition.ts`'s
 * own `getOptions` callback stays live via a ref its caller owns
 * (`add-task-form.tsx`'s `optionsRef`) rather than a value captured once —
 * `TaskTitleEditor` reads this through an identical ref internally (its own
 * header comment on why `autocomplete` itself is still a mount-time seed
 * even though what it POINTS to is not), so a caller only has to keep
 * `getProjects`/`getLabels` returning the current list, never re-supply a
 * new plugin.
 *
 * `onCreateProject`/`onCreateLabel` are optional: a caller with no clean
 * create path (this ticket's report names which ones do) simply omits it,
 * and selecting the "Create" row then only inserts the typed token —
 * Todoist's own vocabulary recognises `#brandnewproject` the moment it's
 * typed regardless of whether the Project exists yet (`matchProject` has no
 * such check), so the token is never wrong, only the side effect of minting
 * a real Project/Label is skipped.
 */
export interface QuickAddAutocompleteOptions {
  getProjects: () => readonly AutocompleteEntry[];
  getLabels: () => readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
}

/** The plugin's own public state — what `task-title-editor.tsx` reads on every transaction to decide whether to render the listbox at all. */
export interface AutocompleteState {
  readonly sigil: AutocompleteSigil;
  /** The sigil character's own position — where the inserted token starts, and the anchor `coordsAtPos` renders the popup against. */
  readonly from: number;
  /** The caret's position — where the inserted token ends (exclusive), i.e. `[from, to)` is `sigil + query` as currently typed. */
  readonly to: number;
  readonly query: string;
  readonly options: readonly AutocompleteOptionRow[];
  readonly activeIndex: number;
}

/** `matchProject`/`matchLabel`'s own name pattern (`packages/core/src/quick-add/rules.ts`'s `WORD_NAME_PATTERN`) — kept identical so the popup's own idea of "still typing the name" never disagrees with what the parser will actually recognise once the popup closes. */
const WORD_NAME_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * Finds a live `#`/`@` trigger ending exactly at `caret`, or `null` if the
 * caret isn't sitting right after one. Word-boundary gated on the LEFT of
 * the sigil (start of text, or preceded by whitespace) — not measured
 * against Todoist (the capture only ever typed a sigil into an empty
 * field), but the same boundary `matchProject`'s own regex allows for a
 * `#` following whitespace, and a sensible reading of "you're starting a
 * new token," not continuing a word that merely contains a `#`.
 */
export function findTrigger(
  text: string,
  caret: number,
): { sigil: AutocompleteSigil; from: number; query: string } | null {
  if (caret < 0 || caret > text.length) {
    return null;
  }
  let i = caret;
  while (i > 0 && WORD_NAME_CHAR.test(text[i - 1] as string)) {
    i--;
  }
  const sigilPos = i - 1;
  if (sigilPos < 0) {
    return null;
  }
  const sigilChar = text[sigilPos];
  if (sigilChar !== "#" && sigilChar !== "@") {
    return null;
  }
  const beforeSigil = sigilPos - 1;
  if (beforeSigil >= 0 && !/\s/.test(text[beforeSigil] as string)) {
    return null;
  }
  return { sigil: sigilChar, from: sigilPos, query: text.slice(i, caret) };
}

/** Case-insensitive substring filter — this module's own header comment on why "substring," not a measured Todoist algorithm. */
export function filterEntries(
  entries: readonly AutocompleteEntry[],
  query: string,
): readonly AutocompleteEntry[] {
  if (query === "") {
    return entries;
  }
  const needle = query.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/**
 * The rows a popup shows for one `entries`/`query` pair.
 * - An empty query lists everything, unfiltered (Todoist: "`#` lists real
 *   projects... typing filters" — the listing itself happens before any
 *   filtering starts, and `@` with zero Labels opens genuinely empty per
 *   `flow10-QA-14-todoist.json`'s `optionCountAtBareAt: 0`, not a "Create"
 *   fallback — there is nothing yet to fall back FROM).
 * - A non-empty query with no match falls back to one `"create"` row
 *   (QA-13/QA-14's own fallback text).
 * - A non-empty query with matches lists only those — Todoist's own capture
 *   never shows the fallback row alongside real matches.
 */
export function computeOptionRows(
  entries: readonly AutocompleteEntry[],
  query: string,
): readonly AutocompleteOptionRow[] {
  if (query === "") {
    return entries.map((entry) => ({ kind: "entry", entry }) as const);
  }
  const filtered = filterEntries(entries, query);
  if (filtered.length === 0) {
    return [{ kind: "create", query } as const];
  }
  return filtered.map((entry) => ({ kind: "entry", entry }) as const);
}

/** The literal text inserted on selecting one option — sigil + canonical name + one trailing space, `quick-add.md`'s own recorded example ("e.g. `#Inbox `"). */
export function insertionTextFor(sigil: AutocompleteSigil, name: string): string {
  return `${sigil}${name} `;
}

export const quickAddAutocompletePluginKey = new PluginKey<AutocompleteState | null>(
  "todo-quick-add-autocomplete",
);

interface MoveMeta {
  readonly type: "move";
  readonly activeIndex: number;
}
type AutocompleteMeta = "close" | MoveMeta;

function buildState(
  state: EditorState,
  options: QuickAddAutocompleteOptions,
  previous: AutocompleteState | null,
): AutocompleteState | null {
  if (!state.selection.empty) {
    return null;
  }
  const caret = state.selection.from;
  const text = state.doc.textContent;
  const trigger = findTrigger(text, caret);
  if (trigger === null) {
    return null;
  }
  const entries = trigger.sigil === "#" ? options.getProjects() : options.getLabels();
  const optionRows = computeOptionRows(entries, trigger.query);
  const sameOccurrence =
    previous !== null && previous.sigil === trigger.sigil && previous.from === trigger.from;
  const activeIndex =
    sameOccurrence && previous !== null
      ? Math.min(previous.activeIndex, Math.max(optionRows.length - 1, 0))
      : 0;
  return {
    sigil: trigger.sigil,
    from: trigger.from,
    to: caret,
    query: trigger.query,
    options: optionRows,
    activeIndex,
  };
}

/** Replaces `[state.from, state.to)` — the sigil plus whatever was typed after it — with the canonical token, closes the popup, and (for a "create" row, when the caller supplied the matching hook) fires the create callback. Exported so `task-title-editor.test.tsx` can drive selection directly against a real `EditorView`, the same "build the real thing, not a stand-in" posture `todo-quick-add-recognition.test.ts` already takes. */
export function selectAutocompleteOption(
  view: EditorView,
  state: AutocompleteState,
  options: QuickAddAutocompleteOptions,
): void {
  const row = state.options[state.activeIndex];
  if (row === undefined) {
    return;
  }
  let name: string;
  if (row.kind === "entry") {
    name = row.entry.name;
  } else {
    name = row.query.trim();
    if (name === "") {
      return;
    }
    if (state.sigil === "#") {
      options.onCreateProject?.(name);
    } else {
      options.onCreateLabel?.(name);
    }
  }
  const text = insertionTextFor(state.sigil, name);
  const tr = view.state.tr
    .insertText(text, state.from, state.to)
    .setMeta(quickAddAutocompletePluginKey, "close" satisfies AutocompleteMeta);
  view.dispatch(tr);
}

/** Dispatches the same "close" meta `selectAutocompleteOption`/Escape use — exported for `task-title-editor.tsx`'s own window-independent Escape handling and for tests that want to close the popup without selecting anything. */
export function closeAutocomplete(view: EditorView): void {
  view.dispatch(
    view.state.tr.setMeta(quickAddAutocompletePluginKey, "close" satisfies AutocompleteMeta),
  );
}

/**
 * The plugin itself — `getOptions` is a callback for the identical "read a
 * ref, not a captured value" reason `quickAddRecognitionPlugin` takes one
 * (that file's own doc comment on `getOptions`).
 *
 * Registered ahead of `commitKeymap` in `buildTitlePlugins` (`task-title-
 * editor.tsx`'s own comment on the ordering) so `Enter`/`Tab` are asked
 * here FIRST while a popup is open — otherwise `commitKeymap`'s own `Enter`
 * binding would commit the whole title before this plugin ever saw the
 * keystroke. `Escape` is deliberately handled here too, even though
 * `task-title-editor.tsx`'s own header comment on the Radix trap explains
 * why this alone cannot be trusted inside a `Dialog` — see this module's
 * caller for the rest of that story.
 */
export function quickAddAutocompletePlugin(
  getOptions: () => QuickAddAutocompleteOptions,
): Plugin<AutocompleteState | null> {
  return new Plugin<AutocompleteState | null>({
    key: quickAddAutocompletePluginKey,
    state: {
      init: (): AutocompleteState | null => null,
      apply(tr: Transaction, previous, oldState, newState): AutocompleteState | null {
        const meta = tr.getMeta(quickAddAutocompletePluginKey) as AutocompleteMeta | undefined;
        if (meta === "close") {
          return null;
        }
        if (meta !== undefined) {
          return previous === null ? null : { ...previous, activeIndex: meta.activeIndex };
        }
        if (!tr.docChanged && newState.selection.eq(oldState.selection)) {
          return previous;
        }
        return buildState(newState, getOptions(), previous);
      },
    },
    props: {
      handleKeyDown(view, event) {
        const current = quickAddAutocompletePluginKey.getState(view.state);
        if (current === null || current === undefined) {
          return false;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const len = current.options.length;
          if (len === 0) {
            event.preventDefault();
            return true;
          }
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex = (current.activeIndex + delta + len) % len;
          view.dispatch(
            view.state.tr.setMeta(quickAddAutocompletePluginKey, {
              type: "move",
              activeIndex: nextIndex,
            } satisfies MoveMeta),
          );
          event.preventDefault();
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          if (current.options.length === 0) {
            // Bare `@` with zero Labels (Todoist's own captured state,
            // `flow10-QA-14-todoist.json`): nothing to select, so let the
            // keystroke fall through to its ordinary meaning (submit,
            // move focus) rather than swallow it for no reason.
            return false;
          }
          selectAutocompleteOption(view, current, getOptions());
          event.preventDefault();
          return true;
        }
        if (event.key === "Escape") {
          closeAutocomplete(view);
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });
}
