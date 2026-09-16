/**
 * Issue #230's parity fixture: the `CORPUS`-shaped table
 * (`entry-document.test.ts`'s own convention, not a JSON file — there is no
 * JSON-fixture precedent in this repo) that `apps/e2e/tests/composer-parity.spec.ts`
 * replays against a live Composer and that `apps/web/scripts/generate-parity-doc.mjs`
 * renders into `docs/reference/composer-parity.md`.
 *
 * Every row's `expected` is THIS repo's own document, in canonical form —
 * built with the small literal-object helpers below, not derived by
 * round-tripping through `entryMarkdownToCanonical`. That choice was made
 * on purpose, not for convenience: `entryMarkdownToCanonical("- [x] task")`
 * was checked directly against this fixture's own needs and found to leave
 * a stray leading space in the item's text (a `parseEntryMarkdown`/GFM
 * `TaskList` quirk in how much of `[x] ` its own matched range consumes) —
 * a real, separate detail of the STORED-MARKDOWN reading path, unrelated to
 * what a person typing `- [x] ` through `composer-editor.ts`'s own
 * `checkboxInputRule` actually leaves behind. Because this fixture's whole
 * job is comparing what a LIVE keystroke sequence produces, its `expected`
 * values are built directly, so a future quirk in the OTHER path
 * (Markdown parsing) can never silently leak into what this table asserts a
 * keystroke does.
 *
 * `upnote` values, by contrast, DO go through `upnoteHtmlToCanonical`
 * wherever a literal HTML citation exists — copied verbatim from
 * `meologue-reference/upnote-macos-detail.md`/`upnote-android-detail.md`'s own
 * gap-sweep tables, so a row's citation and its assertion are the same
 * text. Android's own gap sweeps are screenshot-only (no on-device HTML
 * column to read, `upnote-android-detail.md`'s own method notes), so an
 * Android-sourced row's `upnote` value is built with the same literal
 * helpers `expected` uses instead — named as such in that row's `source`.
 *
 * `divergence: "none"` means this row is a genuine parity claim: `expected`
 * IS `upnote`, and a live replay that disagrees is this ticket's own kind
 * of red — a real gap, not a documentation exercise. `"deliberate"` means
 * `expected` was built to differ from `upnote` on purpose, with `reason`
 * saying why (ADR 0072 collects the load-bearing ones). `replayable: false`
 * marks a row this suite cannot drive through `composerField`/
 * `pressSequentially` at all — a multi-block selection, a toolbar chord, or
 * a clipboard paste, none of which this repo's own keyboard-only helpers
 * reach — kept in the table anyway because the doc generator still owes a
 * reader the citation and the reasoning, even where no live assertion runs.
 */
import type {
  CanonicalBlock,
  CanonicalBreak,
  CanonicalDocument,
  CanonicalInline,
  CanonicalMarkKind,
} from "./canonical";
import { upnoteHtmlToCanonical } from "./canonical";

// ---------------------------------------------------------------------------
// Keystroke scripts
// ---------------------------------------------------------------------------

export type KeyName =
  | "Enter"
  | "Shift+Enter"
  | "Tab"
  | "Shift+Tab"
  | "Backspace"
  | "Home"
  | "ArrowUp"
  | "ArrowLeft";

export type KeystrokeStep =
  | { readonly kind: "type"; readonly text: string }
  /** `times` repeats the same key press (e.g. `ArrowLeft` ×5 to reach a mid-word caret position); omitted is one press. */
  | { readonly kind: "key"; readonly key: KeyName; readonly times?: number }
  /**
   * A caret move followed by the settle every Backspace/Tab test in
   * `composer.spec.ts` already needs — see that file's own
   * `caretToStartOfLine`: ProseMirror learns about a caret move a task
   * AFTER the keypress that caused it, so a command reading the selection
   * immediately afterward can read a stale one. Only ever used right before
   * a `Backspace`/`Tab` step whose own command depends on the caret
   * actually being at the start of the line.
   */
  | { readonly kind: "settleCaretToLineStart" };

// ---------------------------------------------------------------------------
// Literal canonical-value builders — deliberately not the adapters
// themselves; see this file's own module comment for why.
// ---------------------------------------------------------------------------

function text(value: string, marks: readonly CanonicalMarkKind[] = []): CanonicalInline {
  return { kind: "text", text: value, marks };
}

function oneLine(value: string): readonly (readonly CanonicalInline[])[] {
  return value === "" ? [[]] : [[text(value)]];
}

function proseBlock(
  lines: readonly (readonly CanonicalInline[])[],
  breaks: readonly CanonicalBreak[] = [],
): CanonicalBlock {
  return { kind: "prose", prose: { lines, breaks } };
}

/** A single top-level line of plain prose, no marks. */
function textBlock(value: string): CanonicalBlock {
  return proseBlock(oneLine(value));
}

/** A single, otherwise-empty top-level line — what an emptied-out paragraph (an exited list, a blank note) looks like. */
function emptyBlock(): CanonicalBlock {
  return proseBlock([[]]);
}

interface Item {
  readonly listKind: "bullet" | "ordered";
  readonly level: number;
  readonly checked: boolean | null;
  readonly lines: readonly (readonly CanonicalInline[])[];
  readonly breaks?: readonly CanonicalBreak[];
}

function plainItem(
  listKind: "bullet" | "ordered",
  level: number,
  checked: boolean | null,
  value: string,
): Item {
  return { listKind, level, checked, lines: oneLine(value) };
}

function item(
  listKind: "bullet" | "ordered",
  level: number,
  checked: boolean | null,
  lines: readonly (readonly CanonicalInline[])[],
  breaks: readonly CanonicalBreak[] = [],
): Item {
  return { listKind, level, checked, lines, breaks };
}

function listBlock(items: readonly Item[]): CanonicalBlock {
  return {
    kind: "list",
    items: items.map((i) => ({
      listKind: i.listKind,
      level: i.level,
      checked: i.checked,
      prose: { lines: i.lines, breaks: i.breaks ?? [] },
    })),
  };
}

function doc(...blocks: readonly CanonicalBlock[]): CanonicalDocument {
  return { blocks };
}

// ---------------------------------------------------------------------------
// The fixture table
// ---------------------------------------------------------------------------

export interface ParityRow {
  readonly id: string;
  /** What document state the caret starts in, and what the row demonstrates — prose, for the generated doc. */
  readonly context: string;
  readonly platform?: "macOS" | "android";
  readonly keystrokes: readonly KeystrokeStep[];
  readonly expected: CanonicalDocument;
  readonly upnote: CanonicalDocument;
  readonly divergence: "none" | "deliberate";
  readonly reason?: string;
  /** Defaults to `true`. `false` for a row this suite cannot drive through `composerField`/`pressSequentially` at all. */
  readonly replayable?: boolean;
  readonly screenshots?: readonly string[];
  /** Where this row's own `expected`/`upnote` values are grounded — a doc, a gap-sweep group, an existing test. */
  readonly source: string;
}

const type = (t: string): KeystrokeStep => ({ kind: "type", text: t });
const key = (k: KeyName, times?: number): KeystrokeStep =>
  times === undefined ? { kind: "key", key: k } : { kind: "key", key: k, times };
const settle: KeystrokeStep = { kind: "settleCaretToLineStart" };

export const PARITY_FIXTURE: readonly ParityRow[] = [
  // -------------------------------------------------------------------------
  // List creation — baseline rows establishing the harness agrees with
  // UpNote on the ordinary case, before the Enter/Tab/Backspace rows below
  // probe where it stops agreeing.
  // -------------------------------------------------------------------------
  {
    id: "bullet-marker-creates-list",
    context: "Blank Composer; type a bullet marker, Enter, a second item.",
    keystrokes: [type("- first"), key("Enter"), type("second")],
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "first"), plainItem("bullet", 0, null, "second")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>first</li><li>second</li></ul>"),
    divergence: "none",
    source: "upnote-editor-behaviour.md Lists table ('- ' at block start)",
  },
  {
    id: "numbered-marker-creates-list",
    context: "Blank Composer; type a numbered marker, Enter, a second item.",
    keystrokes: [type("1. first"), key("Enter"), type("second")],
    expected: doc(
      listBlock([plainItem("ordered", 0, null, "first"), plainItem("ordered", 0, null, "second")]),
    ),
    upnote: upnoteHtmlToCanonical("<ol><li>first</li><li>second</li></ol>"),
    divergence: "none",
    source: "upnote-editor-behaviour.md Lists table ('1. ' at block start)",
  },
  {
    id: "checklist-one-step-shortcut-creates-unchecked-item",
    context: "Blank Composer; type UpNote's own one-step checklist trigger, `[] `.",
    keystrokes: [type("[] milk")],
    expected: doc(listBlock([plainItem("bullet", 0, false, "milk")])),
    upnote: upnoteHtmlToCanonical('<ul><li data-checked="false">milk</li></ul>'),
    divergence: "none",
    source:
      "upnote-editor-behaviour.md Lists table ('[] ' at block start -> data-checked=\"false\"); ADR 0045 (this repo's own one-step '[] ' trigger, added to match UpNote's)",
  },

  // -------------------------------------------------------------------------
  // Enter
  // -------------------------------------------------------------------------
  {
    id: "enter-mid-text-splits-item-into-sibling",
    context: "Caret placed between 'alpha' and 'bravo', inside one bullet item's own text.",
    keystrokes: [type("- alphabravo"), key("ArrowLeft", 5), key("Enter")],
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "alpha"), plainItem("bullet", 0, null, "bravo")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>alpha</li><li>bravo</li></ul>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A3 (mid-text Enter -> tail moves to a new sibling item)",
  },
  {
    id: "enter-on-empty-top-level-bullet-item-exits-list",
    context: "A single, always-empty top-level bullet item; Enter on it.",
    keystrokes: [type("- "), key("Enter")],
    expected: doc(emptyBlock()),
    upnote: upnoteHtmlToCanonical("<br>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A1, empty top-level bullet (verified, 2 reads ~9s apart); upnote-android-detail.md Gap sweep Group A, bullet top-level (list closes entirely)",
  },
  {
    id: "enter-on-empty-top-level-numbered-item-exits-list",
    context: "A single, always-empty top-level numbered item; Enter on it.",
    keystrokes: [type("1. "), key("Enter")],
    expected: doc(emptyBlock()),
    upnote: upnoteHtmlToCanonical("<br>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A1, empty top-level numbered; upnote-android-detail.md Gap sweep Group A, numbered top-level",
  },
  {
    id: "enter-on-empty-top-level-checkbox-item-exits-list",
    context: "A single, always-empty top-level checklist item; Enter on it.",
    keystrokes: [type("[] "), key("Enter")],
    expected: doc(emptyBlock()),
    upnote: upnoteHtmlToCanonical("<br>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A1, empty top-level checkbox (checked-ness has no effect on this rule); upnote-android-detail.md Gap sweep Group A, checkbox top-level",
  },
  {
    id: "enter-on-empty-nested-item-outdents-one-level",
    context: "A level-1 (nested) item with no text of its own; Enter on it.",
    keystrokes: [type("- one"), key("Enter"), key("Tab"), key("Enter")],
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "one"), plainItem("bullet", 0, null, "")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>one</li><li><br></li></ul>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A2 (empty nested item -> Enter -> outdents ONE level, stays in the list) — general rule, applied here at a minimal 2-item depth rather than quoting one of A2's own deeper table rows verbatim",
  },
  {
    id: "enter-after-checked-item-yields-unchecked-item",
    context:
      "A checked checklist item's own text, cursor at the end; Enter, then a second item's text.",
    keystrokes: [type("- [x] milk"), key("Enter"), type("bread")],
    expected: doc(
      listBlock([plainItem("bullet", 0, true, "milk"), plainItem("bullet", 0, false, "bread")]),
    ),
    upnote: upnoteHtmlToCanonical(
      '<ul><li data-checked="true">milk</li><li data-checked="false">bread</li></ul>',
    ),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A1-checked/A6 note ('completion is not inherited'); existing apps/e2e/tests/composer.spec.ts 'Enter after a ticked checklist item's text produces an UNticked new item'",
  },

  // -------------------------------------------------------------------------
  // Shift+Enter — the ticket's own known-broken row
  // -------------------------------------------------------------------------
  {
    id: "shift-enter-in-bullet-item-is-soft-break-not-new-item",
    context: "Caret at the end of a bullet item's text; Shift+Enter, then more text.",
    keystrokes: [type("- alpha"), key("Shift+Enter"), type("bravo")],
    expected: doc(
      listBlock([item("bullet", 0, null, [[text("alpha")], [text("bravo")]], ["soft"])]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>alpha<br>bravo</li></ul>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A6 (Shift+Enter inside a bullet item -> <br> inside the SAME <li>, verified at the raw byte/hex level)",
  },
  {
    id: "shift-enter-in-checkbox-item-is-soft-break-not-new-item",
    context: "Caret at the end of an unchecked checkbox item's text; Shift+Enter, then more text.",
    keystrokes: [type("- [ ] alpha"), key("Shift+Enter"), type("bravo")],
    expected: doc(
      listBlock([item("bullet", 0, false, [[text("alpha")], [text("bravo")]], ["soft"])]),
    ),
    upnote: upnoteHtmlToCanonical('<ul><li data-checked="false">alpha<br>bravo</li></ul>'),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group A7 (Shift+Enter inside a checkbox item -> <br> inside the same <li>, data-checked untouched)",
  },
  {
    id: "shift-enter-outside-list-is-a-soft-break",
    context:
      "Plain prose, no list — the contrasting case: Shift+Enter is already correct here, so this row is expected to stay green while the two above stay red.",
    keystrokes: [type("alpha"), key("Shift+Enter"), type("bravo")],
    expected: doc(proseBlock([[text("alpha")], [text("bravo")]], ["soft"])),
    upnote: upnoteHtmlToCanonical("alpha<br>bravo"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Block model table (Shift+Enter = <br> inside the current block); ADR 0069",
  },

  {
    id: "enter-outside-list-splits-into-a-new-block",
    context:
      "Plain prose, no list. Enter ends the block and starts a sibling one \u2014 the counterpart to Shift+Enter above, and the row ADR 0069 exists to make true.",
    keystrokes: [type("alpha"), key("Enter"), type("bravo")],
    expected: doc(proseBlock([[text("alpha")], [text("bravo")]], ["block"])),
    upnote: upnoteHtmlToCanonical("<div>alpha</div><div>bravo</div>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Block model table (`alpha` \u23ce `bravo` \u2192 <div>alpha</div><div>bravo</div>, byte-verified); ADR 0069, which supersedes ADR 0066's soft-break Enter",
  },
  {
    id: "enter-twice-outside-list-leaves-exactly-one-blank-block",
    context:
      "Two Enters in prose. UpNote's block separator carries no margin of its own, so this is one blank line \u2014 not the two that ADR 0066 was written to stop.",
    keystrokes: [type("alpha"), key("Enter", 2), type("bravo")],
    expected: doc(proseBlock([[text("alpha")], [], [text("bravo")]], ["block", "block"])),
    upnote: upnoteHtmlToCanonical("<div>alpha</div><div><br></div><div>bravo</div>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Block model table (`alpha` \u23ce \u23ce `bravo`, byte-verified); ADR 0069",
  },

  // -------------------------------------------------------------------------
  // Tab — the ticket's other known-broken row
  // -------------------------------------------------------------------------
  {
    id: "tab-indents-item-with-a-preceding-sibling",
    context:
      "Caret in the SECOND item of a 2-item list, which has a preceding sibling to sink under.",
    keystrokes: [type("- top"), key("Enter"), type("mid"), key("Tab")],
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "top"), plainItem("bullet", 1, null, "mid")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>top</li><ul><li>mid</li></ul></ul>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group B1 (Tab indents the whole item, caret position within it doesn't matter); existing apps/e2e/tests/composer.spec.ts 'Tab indents a list item, up to three levels deep'",
  },
  {
    id: "tab-on-first-item-of-list-also-nests",
    context:
      "Caret moved back to the FIRST item of a 2-item list, which has NO preceding sibling to sink under.",
    keystrokes: [type("- alpha"), key("Enter"), type("bravo"), key("ArrowUp"), settle, key("Tab")],
    expected: doc(
      listBlock([plainItem("bullet", 1, null, "alpha"), plainItem("bullet", 0, null, "bravo")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><ul><li>alpha</li></ul><li>bravo</li></ul>"),
    divergence: "none",
    source:
      "upnote-editor-behaviour.md Lists table ('Tab on the first item of a list | also nests, producing <ul><ul><li>…'); upnote-android-detail.md Gap sweep Group D (matches macOS exactly); shape of the resulting orphan nested <ul> follows Group B4's own 3-item indent-together pattern — this exact 2-item combination is a minimal reproduction, not a literal table row",
  },
  {
    id: "tab-on-plain-prose-inserts-an-em-space",
    context:
      "Plain prose, no list. UpNote's Tab outside a list is not a focus move and not a tab character \u2014 it inserts one U+2003 EM SPACE and the caret continues in the same block.",
    keystrokes: [type("ab"), key("Tab"), type("cd")],
    expected: doc(textBlock("ab\u2003cd")),
    upnote: upnoteHtmlToCanonical("ab\u2003cd"),
    divergence: "none",
    source:
      "upnote-macos-detail.md \u00a7 'Tab on plain (non-list) text inserts a literal U+2003 EM SPACE' \u2014 verified at the byte level (6162 E28083 6364) and again at Gap sweep Group B6; ADR 0070",
  },
  {
    id: "tab-nests-three-levels-deep",
    context: "Three items, each sunk under its own immediately preceding sibling in turn.",
    keystrokes: [
      type("- top"),
      key("Enter"),
      type("mid"),
      key("Tab"),
      key("Enter"),
      type("deep"),
      key("Tab"),
    ],
    expected: doc(
      listBlock([
        plainItem("bullet", 0, null, "top"),
        plainItem("bullet", 1, null, "mid"),
        plainItem("bullet", 2, null, "deep"),
      ]),
    ),
    upnote: upnoteHtmlToCanonical(
      "<ul><li>top</li><ul><li>mid</li><ul><li>deep</li></ul></ul></ul>",
    ),
    divergence: "none",
    source:
      "existing apps/e2e/tests/composer.spec.ts 'Tab indents a list item, up to three levels deep'; upnote-macos-detail.md Gap sweep Group A2 (3-level nested structures observed directly) and its own bullet glyph cascade table (level 1/2/3 all verified live)",
  },

  // -------------------------------------------------------------------------
  // Shift+Tab
  // -------------------------------------------------------------------------
  {
    id: "shift-tab-outdents-nested-item-back-one-level",
    context: "A nested (level-1) item; Shift+Tab on it.",
    keystrokes: [type("- top"), key("Enter"), type("mid"), key("Tab"), key("Shift+Tab")],
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "top"), plainItem("bullet", 0, null, "mid")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>top</li><li>mid</li></ul>"),
    divergence: "none",
    source:
      "existing apps/e2e/tests/composer.spec.ts 'Shift-Tab outdents a nested list item back up one level'",
  },
  {
    id: "shift-tab-on-a-single-level-one-item-exits-list-entirely",
    context: "A single top-level item, nothing nested; Shift+Tab on it.",
    keystrokes: [type("- alpha"), key("Shift+Tab")],
    expected: doc(textBlock("alpha")),
    upnote: upnoteHtmlToCanonical("alpha"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group B2 (Shift+Tab on a level-1 item exits the list entirely, bare text at root, confirmed at the hex level, no wrapping tag)",
  },
  {
    id: "shift-tab-on-plain-prose-is-a-content-no-op",
    context: "Plain prose, no list; Shift+Tab on it.",
    keystrokes: [type("plain text here"), key("Shift+Tab")],
    expected: doc(textBlock("plain text here")),
    upnote: upnoteHtmlToCanonical("plain text here"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group B3 (Shift+Tab on plain prose, byte-for-byte unchanged)",
  },

  // -------------------------------------------------------------------------
  // Backspace
  // -------------------------------------------------------------------------
  {
    id: "backspace-at-start-of-nonempty-item-unwraps-to-plain-block",
    context: "Caret at the very start of a single top-level item's own non-empty text; Backspace.",
    keystrokes: [type("- hello"), settle, key("Backspace")],
    expected: doc(textBlock("hello")),
    upnote: upnoteHtmlToCanonical("hello"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group D1, non-empty level-1 item; upnote-android-detail.md Gap sweep Group F (matches macOS exactly)",
  },
  {
    id: "backspace-at-start-of-nested-item-outdents-one-level",
    context: "Caret at the very start of a NESTED item's own text; Backspace.",
    keystrokes: [type("- top"), key("Enter"), type("mid"), key("Tab"), settle, key("Backspace")],
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "top"), plainItem("bullet", 0, null, "mid")]),
    ),
    upnote: upnoteHtmlToCanonical("<ul><li>top</li><li>mid</li></ul>"),
    divergence: "none",
    source:
      "existing apps/e2e/tests/composer.spec.ts 'Backspace at the very start of a list item lifts it out one level...'; upnote-macos-detail.md Gap sweep Group D (nested item Backspace outdents one level, does not unwrap on first press); upnote-android-detail.md Gap sweep Group F (nested bullet item matches)",
  },
  {
    id: "backspace-at-start-of-checked-item-drops-checked-state",
    context: "Caret at the very start of a single, checked checklist item's own text; Backspace.",
    keystrokes: [type("- [x] task"), settle, key("Backspace")],
    expected: doc(textBlock("task")),
    upnote: upnoteHtmlToCanonical("task"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group D3 (checked checkbox item, Backspace -> bare text, data-checked dropped entirely, no strikethrough memory of the check)",
  },
  {
    id: "backspace-on-a-truly-empty-top-level-item-exits-list",
    context:
      "A truly empty second item (never had marker text of its own typed into it, not the marker-undo case below); Backspace.",
    keystrokes: [type("- x"), key("Enter"), key("Backspace")],
    expected: doc(listBlock([plainItem("bullet", 0, null, "x")]), emptyBlock()),
    upnote: upnoteHtmlToCanonical("<ul><li>x</li></ul><br>"),
    divergence: "none",
    source:
      "upnote-macos-detail.md Gap sweep Group D1, empty level-1 item (Backspace exits, same as Enter/A1) — general rule, applied here with a preceding sibling present rather than quoting D1's own single-item table row verbatim",
  },
  {
    id: "backspace-right-after-bullet-marker-restores-literal-text",
    context:
      "Backspace pressed IMMEDIATELY after the '- ' input rule fires, nothing else typed in between.",
    keystrokes: [type("- "), key("Backspace")],
    expected: doc(textBlock("- ")),
    upnote: upnoteHtmlToCanonical("<br>"),
    divergence: "deliberate",
    reason:
      "This repo's own Backspace binding is chainCommands(undoInputRule, liftAtStartOfListItem) (composer-editor.ts, issue #210): the keystroke immediately following ANY input-rule match — not only a list marker — first tries to undo that specific rule, restoring the literal characters it consumed, before falling back to the ordinary list-exit lift. composer-editor.ts's own comment names this as deliberate and matching UpNote's feel (its own worked example there is **bold**, not a list marker specifically), and it is already asserted by apps/e2e/tests/composer.spec.ts's own 'Backspace right after typing \"- \" undoes the bullet input rule, restoring the literal text.' UpNote's own Gap sweep Group D5 (this session) found the OPPOSITE for its list marker specifically: Backspace immediately after '- ' fires does NOT restore the literal text — it performs the ordinary empty-item list-exit instead, confirmed at the hex level and described there as 'a genuinely different code path from Cmd+Z.' ADR 0072 records this open tension rather than resolving it — the two apps chose differently for this one keystroke, and this repo's choice was made and tested before D5 existed to compare it against.",
    source:
      "upnote-macos-detail.md Gap sweep Group D5; apps/web/src/lib/composer-editor.ts's own Backspace/undoInputRule comment; existing apps/e2e/tests/composer.spec.ts 'Backspace right after typing \"- \" undoes the bullet input rule, restoring the literal text'",
  },

  // -------------------------------------------------------------------------
  // Deliberate divergences with no keyboard-only replay path — kept for the
  // generated doc and for ADR 0072's own citations, not executed.
  // -------------------------------------------------------------------------
  {
    id: "multi-block-tab-destroys-both-blocks-text-macos",
    platform: "macOS",
    context:
      "Two plain blocks, both fully selected (Cmd+A) — a multi-block selection this Composer has no keyboard path to build or to act on with Tab at all.",
    keystrokes: [],
    replayable: false,
    expected: doc(textBlock("\u2003alpha"), textBlock("\u2003bravo")),
    upnote: upnoteHtmlToCanonical(" "),
    divergence: "deliberate",
    reason:
      "Verified reproducibly (2/2) on macOS — Gap sweep #2 Group K1: Tab across a multi-block selection deletes BOTH blocks' text, leaving a single em space behind, confirmed by screenshot and hex both times. ADR 0072 names this the clearest of the three verified content-losing UpNote behaviours this repo will not copy. Issue #235 gave this Composer a real multi-block Tab (`insertEmSpace` prepends one em space to the start of each top-level plain block the selection touches), so content preservation here is now a considered behaviour rather than, as this row previously claimed, the mere absence of the feature. One disclosed limit: a multi-item LIST selection starting at the list's first item has no preceding sibling for the whole range and falls back to a single collapsed em space — it never destroys anything, but it does not genuinely indent either. Driven live in `composer.spec.ts` rather than replayed here, since this fixture's keystroke vocabulary cannot build a multi-block selection.",
    source: "upnote-macos-detail.md Gap sweep #2 Group K1",
  },
  {
    id: "multi-block-tab-destroys-both-blocks-text-android",
    platform: "android",
    context:
      "Two plain blocks, both selected — same destructive finding, reproduced independently on Android's own toolbar indent button.",
    keystrokes: [],
    replayable: false,
    expected: doc(emptyBlock(), textBlock("blockB")),
    upnote: doc(emptyBlock(), textBlock("blockB")),
    divergence: "deliberate",
    reason:
      "Verified reproducibly (2/2) on Android — Gap sweep #2 Group K1: tapping indent across a two-block selection deletes the EARLIER block's text outright (leaving an empty paragraph) and leaves the later block untouched and unindented; confirmed by undo restoring the deleted text. A different literal shape from the macOS finding (one destroyed block vs one collapsed em-space block) but the same underlying defect class ADR 0072 names — an editing gesture destroying text with no warning. This row's 'upnote' value is built directly rather than through upnoteHtmlToCanonical: Android's own gap sweeps are screenshot-only, with no on-device HTML column to read (upnote-android-detail.md's own method notes), so there is no literal HTML string to cite here the way the macOS row above can.",
    source: "upnote-android-detail.md Gap sweep #2 Group K1",
  },
  {
    id: "macos-toolbar-unlist-collapses-three-items-to-one-br-joined-block",
    platform: "macOS",
    context:
      "A 3-item flat bullet list, fully selected, toggled off via the Cmd+7 toolbar chord — a multi-item toggle this Composer has no equivalent command for.",
    keystrokes: [],
    replayable: false,
    expected: doc(textBlock("alpha"), textBlock("bravo"), textBlock("charlie")),
    upnote: doc(
      proseBlock([[text("alpha")], [text("bravo")], [text("charlie")]], ["soft", "soft"]),
    ),
    divergence: "deliberate",
    reason:
      "Verified at the hex level — Gap sweep #2 Group G3: toggling a 3-item bullet list off via Cmd+7 collapses all three items' text into ONE plain block joined by <br> soft breaks, not three separate paragraph blocks. Android's own UpNote returns three separate blocks for the identical gesture, so this is a macOS-only content-losing behaviour and ADR 0072 takes Android's side. Issue #235 made this a real, exercised path here — a multi-item toggle preserves each item as its own block — rather than, as this row previously claimed, a gesture this Composer could not perform at all. Driven live in `composer.spec.ts`; not replayable through this fixture's keystroke vocabulary.",
    source: "upnote-macos-detail.md Gap sweep #2 Group G3",
  },
  {
    id: "nested-unlist-alternates-rather-than-flattening",
    platform: "macOS",
    context:
      "A 3-level nested bullet list, fully selected, Cmd+7 pressed repeatedly — again a multi-select toolbar gesture, with a genuinely surprising own finding worth recording regardless of replayability.",
    keystrokes: [],
    replayable: false,
    expected: doc(textBlock("one"), textBlock("two"), textBlock("three")),
    upnote: doc(proseBlock([[text("one")], [text("two")], [text("three")]], ["soft", "soft"])),
    divergence: "deliberate",
    reason:
      "Gap sweep #2 Group I1: un-nesting a 3-level list via repeated Cmd+7 neither flattens in one press nor lifts one level per press — it ALTERNATES between outdenting one level (when the selection is uniformly list-active) and re-normalizing to flat (when the previous outdent left a mixed selection), taking exactly 5 presses to reach the fully-flat state shown in 'upnote' here, on both platforms. Issue #235's `liftEveryTouchedTopLevelList` now scopes the lift to the still-nested top-level lists the selection touches, never disturbing already-plain siblings, so a 3-level list flattens in exactly 3 presses — one level per press, deterministically. That is a deliberate divergence from an erratic behaviour, not, as this row previously claimed, the absence of any multi-select command to be erratic with. Driven live in `composer.spec.ts`.",
    source: "upnote-macos-detail.md Gap sweep #2 Group I1",
  },
  {
    id: "soft-break-survives-conversion-to-a-list-item",
    platform: "android",
    context:
      "A plain block already broken by a soft break, converted to a bullet \u2014 a toolbar gesture this fixture's keystroke vocabulary cannot drive, kept for the citation.",
    keystrokes: [],
    replayable: false,
    expected: doc(
      listBlock([item("bullet", 0, null, [[text("alpha")], [text("bravo")]], ["soft"])]),
    ),
    upnote: doc(textBlock("alpha"), textBlock("bravo")),
    divergence: "deliberate",
    reason:
      "Gap sweep #2 Group H: on Android, converting a block that contains a soft line break into a bullet PERMANENTLY splits it into two separate blocks, and undoing the list conversion does not put it back \u2014 the break is gone for good. ADR 0072 rules that out: silently degrading what the author typed is the same class of behaviour as losing it outright, so the soft break survives here and the item stays one item. Cheap for this schema to honour, because a soft break is a literal `\\n` inside one paragraph rather than a node of its own, so a list wrap never has to decide what to do with it. Driven live in composer-commands.test.ts rather than replayed here.",
    source:
      "upnote-android-detail.md Gap sweep #2 Group H (round trip: plain \u2192 bullet \u2192 plain, soft-break case)",
  },
  {
    id: "pasted-markdown-is-parsed-into-structure-unlike-either-upnote-platform",
    context:
      "Pasting GFM Markdown ('- alpha\\n- bravo\\n') into an empty Composer — paste is not a keystroke this fixture's own script vocabulary can drive.",
    keystrokes: [],
    replayable: false,
    expected: doc(
      listBlock([plainItem("bullet", 0, null, "alpha"), plainItem("bullet", 0, null, "bravo")]),
    ),
    upnote: upnoteHtmlToCanonical("- alpha<br>- bravo<br><br>"),
    divergence: "deliberate",
    reason:
      "upnote-macos-detail.md §10 Paste behaviour: UpNote never converts pasted Markdown into structure — its own '- ' markers survive as literal text, since its input rules fire on typing only, never on paste. That section's own words: 'This is a point where copying UpNote exactly would be a regression for this repo. An Entry's body IS Markdown, so pasted GFM is parsed into a list on the way in' — ADR 0045's own deliberate choice, restated here as a parity row rather than left only as prose in that section.",
    source: "upnote-macos-detail.md §10 Paste behaviour; ADR 0045",
  },
];
