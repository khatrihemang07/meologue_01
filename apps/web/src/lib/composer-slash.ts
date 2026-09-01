/**
 * The `/` menu's pure logic (issue #165) — trigger detection, query
 * filtering, and the seven-item ordering the ticket lists — built as its
 * own module rather than folded into composer-picker.ts, per the user's
 * explicit choice recorded on that issue: the `/` menu and the `[[` picker
 * share a SHAPE (an absolutely-positioned dropdown anchored to a trigger
 * character, narrowed by whatever is typed after it) but not a GRAMMAR.
 * The `[[` picker's query can be almost anything — a date, free-text
 * search words, even a literal space — and is closed only by `]` or a
 * newline; the `/` menu's query is always a single command name being
 * typed a few characters at a time, and is closed by the FIRST space,
 * because every item it offers is one or two plain words with no spaces of
 * its own to search past. Merging the two into one state machine would
 * mean branching most of `derivePicker`'s own rules on which trigger
 * opened it — this file is that branch, made real instead of implicit.
 *
 * Mirrors composer-picker.ts's own shape closely on purpose (see this
 * module's function comments for the specific parallels) and, like that
 * file, stays free of ProseMirror types throughout: composer-editor.ts's
 * `slashPlugin` is the only piece of this feature that reconstructs a
 * ProseMirror `Node`/`Selection` into the "flat text plus a caret index"
 * shape `deriveSlashMenu` expects — the same translation `pickerPlugin`
 * already performs for `derivePicker`, and for the identical reason (ADR
 * 0044: jsdom cannot mount an `EditorView` at all, so a module that never
 * imports `prosemirror-*` is a module `composer-slash.test.ts` can
 * exercise directly, with no view in sight).
 */

/** The one character that opens this menu — unlike the `[[` picker's two-character trigger, there is only one to check here, so this constant exists mainly so `deriveSlashMenu` never repeats the literal. */
export const SLASH_TRIGGER = "/";

/**
 * Where the `/` menu is anchored, and what it's currently narrowed to —
 * this menu's own counterpart to composer-picker.ts's
 * `ReferencePickerState`. `start` is the index in `text` immediately AFTER
 * the triggering `/`; everything from there to the caret is `query`.
 * Recomputed from scratch on every keystroke (`deriveSlashMenu` below)
 * rather than patched incrementally, for the same reason
 * `ReferencePickerState`'s own comment gives: deriving fresh from `text`
 * and the caret position makes typing, backspacing past the trigger, and
 * the caret moving away all the same code path instead of three.
 */
export interface SlashMenuState {
  start: number;
  query: string;
}

/**
 * Whether `text[slashIndex]` — which the caller has already confirmed IS
 * the trigger character — sits somewhere this menu is allowed to open: the
 * very start of the block, or immediately after a whitespace character.
 * This is Obsidian's own rule ("type a forward slash at the beginning of a
 * line or after any blank space"), chosen over UpNote's fire-anywhere
 * behaviour deliberately (issue #165's own ticket) — an Entry is fast
 * prose typed at speed, and firing on every `/` would pop this menu open
 * for `and/or`, `w/`, and a bare date like `9/1`, none of which are a
 * command being invoked. `\s` (not a literal `" "` check) so a tab counts
 * too; nothing about the underlying reasoning is specific to the space bar.
 */
function isTriggerPosition(text: string, slashIndex: number): boolean {
  if (slashIndex === 0) {
    return true;
  }
  const before = text[slashIndex - 1];
  return before !== undefined && /\s/.test(before);
}

/**
 * The menu's own state transition, given the current textblock's flat text
 * and caret position — `derivePicker`'s (composer-picker.ts) exact shape,
 * reused for the same reason: pure and stateless, so "when is the menu
 * open" is answerable by reading this one function rather than split
 * across a change handler, a keydown handler, and a closing effect.
 *
 * - No menu yet: opens exactly when the character immediately before the
 *   caret is `/` AND it sits at a legal trigger position
 *   (`isTriggerPosition`) — mid-word never opens it, matching the ticket's
 *   own `and/or` example: typing straight through leaves `and/or` on the
 *   page with no menu ever appearing.
 * - A menu already open: stays open only while the caret is still at or
 *   after `start` AND the character immediately before `start` is still
 *   `/` — either failing means the reader moved the caret away or
 *   backspaced through the trigger itself, and the menu has nothing left
 *   to be anchored to (the same two failure modes `derivePicker` itself
 *   guards against for `[[`).
 * - A query that picks up a space or a newline closes the menu without
 *   opening a new one: every item this menu offers is a single word (or
 *   two, joined with no space of its own — "Bullet list" is matched as one
 *   label, never as two separate query tokens), so a space typed after the
 *   `/` can only mean the reader kept writing ordinary prose past it, the
 *   ticket's own "a space after the `/` dismisses."
 */
export function deriveSlashMenu(
  text: string,
  caret: number,
  previous: SlashMenuState | null,
): SlashMenuState | null {
  if (previous === null) {
    if (caret >= 1 && text[caret - 1] === SLASH_TRIGGER && isTriggerPosition(text, caret - 1)) {
      return { start: caret, query: "" };
    }
    return null;
  }
  if (caret < previous.start || text[previous.start - 1] !== SLASH_TRIGGER) {
    return null;
  }
  const query = text.slice(previous.start, caret);
  if (query.includes(" ") || query.includes("\n")) {
    return null;
  }
  return { start: previous.start, query };
}

/**
 * Strips diacritics and case for a substring comparison. `normalize("NFD")`
 * decomposes an accented character into its base letter plus a separate
 * combining mark (`é` becomes `e` followed by U+0301), and the `replace`
 * that follows drops every combining mark in the U+0300–U+036F block —
 * leaving the bare letters `filterSlashItems` actually compares. That is
 * the entire "accent-insensitive" half of the ticket's filter rule; there
 * is no locale-aware collation involved, because none is needed for seven
 * fixed, ASCII-English labels — this only has to survive a reader typing
 * an accented character by habit or autocorrect, not sort them.
 */
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * The minimal shape `filterSlashItems`/`buildSlashMenuItems` need from a
 * command — satisfied structurally by `ComposerCommand` (composer-commands.ts)
 * with no import of it, or of anything ProseMirror-typed, needed in this
 * file. composer.tsx passes `composerCommands` straight through; this
 * module only ever reads `id`/`label` off whatever it's handed.
 */
export interface SlashMenuCommand {
  id: string;
  label: string;
}

/**
 * Case- and accent-insensitive, unanchored SUBSTRING filtering — `/che`
 * matches "Checklist" (it contains "che"), `/chk` does not, because there
 * is no fuzzy scoring or character-skipping here at all. This is UpNote's
 * own actual behaviour, verified against its shipped bundle for issue
 * #165: its matcher builds a per-character class with no `.*` between
 * characters, i.e. plain substring matching — deliberately not a
 * `/c.*h.*k/`-style fuzzy pattern that would let `chk` skip over the
 * missing `ec` the way a command palette elsewhere in this app or the OS
 * might. An empty query matches every item unchanged — the menu's own
 * first frame, right after a bare `/` — the same "nothing typed yet
 * narrows nothing" rule `buildDateSuggestions` already uses for the `[[`
 * picker's date mode.
 */
export function filterSlashItems<T extends SlashMenuCommand>(
  items: readonly T[],
  query: string,
): T[] {
  if (query === "") {
    return [...items];
  }
  const needle = normalizeForMatch(query);
  return items.filter((item) => normalizeForMatch(item.label).includes(needle));
}

/**
 * The seven items, in the exact order issue #165 lists them — Checklist,
 * Bullet list, Numbered list, Bold, Italic, Code, Reference — which is NOT
 * `composerCommands`' own array order (composer-commands.ts groups marks
 * first, for its toolbar's own layout, and also carries four items — indent,
 * outdent, undo, redo — this menu has no row for at all). Kept here as a
 * list of `id`s only, never as a second copy of any command's behaviour:
 * `buildSlashMenuItems` below is what turns this into actual commands,
 * reaching through the one registry composer-commands.ts already is —
 * the ticket's own explicit "do not reimplement."
 */
export const SLASH_MENU_COMMAND_IDS: readonly string[] = [
  "checklist",
  "bulletList",
  "orderedList",
  "bold",
  "italic",
  "code",
  "reference",
];

/**
 * Looks up `SLASH_MENU_COMMAND_IDS` against `commands` (composer.tsx passes
 * `composerCommands`), preserving THIS list's order rather than the
 * registry's own — the same throw-on-typo pattern composer-commands.ts's
 * own `requireNodeType`/`requireMarkType` already use, so a typo'd id here
 * fails loudly at module load rather than silently dropping a row from the
 * menu with nothing in the UI to explain why. Generic over `T` (rather
 * than importing `ComposerCommand` directly) is what keeps this module
 * free of a ProseMirror-typed import: composer.tsx is the only caller, and
 * it already has real `ComposerCommand`s on hand to pass in.
 */
export function buildSlashMenuItems<T extends SlashMenuCommand>(commands: readonly T[]): T[] {
  const byId = new Map(commands.map((command) => [command.id, command] as const));
  return SLASH_MENU_COMMAND_IDS.map((id) => {
    const command = byId.get(id);
    if (command === undefined) {
      throw new Error(`composerCommands has no "${id}" command for the / menu`);
    }
    return command;
  });
}
