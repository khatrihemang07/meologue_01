/**
 * Direct unit coverage for this file's input rules — `checkboxInputRule`'s
 * pattern (issue #158, the one regexp here that needed fixing for a
 * browser's own whitespace normalisation), and, as of issue #161, the
 * reader/writer symmetry bar between `parseEntryMarkdown` (inline-markdown
 * .ts) and `buildInputRules()`, plus the new one-step checklist shortcut.
 * jsdom cannot mount a live ProseMirror `EditorView` at all (ADR 0044, and
 * composer-commands.test.ts's own module comment), so every test below
 * either probes an exported regexp directly or drives a rule's exported
 * `match`/`handler` pair against a plain `EditorState` — never through a
 * mounted view. A live keystroke round trip belongs in apps/e2e's
 * composer.spec.ts, which can drive a real browser.
 *
 * `match`/`handler` are documented as `@internal` in
 * prosemirror-inputrules' own `.d.ts` and so are invisible to TypeScript on
 * a plain `InputRule`, even though the class's actual (JS) constructor
 * assigns both as ordinary instance properties and nothing in the runtime
 * hides them — `inspect` below is the one, explicit cast this file needs to
 * reach them, rather than scattering `as unknown as` at every call site.
 *
 * NBSP is built with `String.fromCharCode(0xa0)` throughout rather than
 * typed as a literal character in this source file — a literal U+00A0 is
 * visually indistinguishable from an ordinary space in an editor and in a
 * diff, which is exactly the property that makes the underlying bug
 * possible in the first place; spelling it out keeps that invisibility
 * from leaking into this file too.
 */
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
  buildInputRules,
  checkboxInputRulePattern,
  checklistShortcutInputRulePattern,
} from "./composer-editor";
import { entryMarkdownToDocument } from "./entry-document";
import { entrySchema } from "./entry-schema";
import { parseEntryMarkdown } from "./inline-markdown";

const NBSP = String.fromCharCode(0xa0);

describe("checkboxInputRulePattern", () => {
  it("matches an ordinary typed space between the brackets", () => {
    expect(checkboxInputRulePattern.test("[ ] ")).toBe(true);
  });

  // The regression this exists for: without `.ProseMirror`'s own
  // `white-space: pre-wrap` (index.css, same ticket), a browser is free to
  // normalise a typed space into U+00A0 before this rule ever sees it —
  // WebKit does this far more eagerly than Chromium (ProseMirror upstream
  // issues #981 and #598). A pattern that only recognised U+0020 inside
  // the brackets left `- [ ] ` unable to ever become a checkbox on such a
  // browser, with nothing on screen to explain why.
  it("matches U+00A0 (a non-breaking space) between the brackets", () => {
    expect(checkboxInputRulePattern.test(`[${NBSP}] `)).toBe(true);
  });

  it("matches U+00A0 as the rule's own trailing whitespace too", () => {
    expect(checkboxInputRulePattern.test(`[ ]${NBSP}`)).toBe(true);
  });

  it("still matches the checked spellings, unaffected by the NBSP fix", () => {
    expect(checkboxInputRulePattern.test("[x] ")).toBe(true);
    expect(checkboxInputRulePattern.test("[X] ")).toBe(true);
  });

  it("does not match a character outside the checkbox grammar", () => {
    expect(checkboxInputRulePattern.test("[y] ")).toBe(false);
    expect(checkboxInputRulePattern.test("[] ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reader/writer symmetry (issue #161) — the test that would have caught `*`
// ---------------------------------------------------------------------------

/**
 * Replicates prosemirror-inputrules' own `run()` matching by hand: the text
 * an `InputRule` sees is the current textblock's OWN text from its start up
 * to the cursor (`$from.parent.textBetween(0, $from.parentOffset, ...)`),
 * with the just-typed `text` appended, never anything from an outer block —
 * which is what makes every rule below naturally refuse to fire on a marker
 * typed anywhere but the start of a block, with no separate "is this the
 * start of a block" check needed in the test. `run()` itself only exists
 * bound to a live `EditorView` (`view.dispatch`, `view.composing`), which
 * jsdom cannot mount at all (ADR 0044 and this file's own history) — so
 * this calls straight through to each rule's public `match`/`handler`
 * instead, the same seam `checkboxInputRulePattern`'s own tests already
 * lean on, extended here to actually run a rule's transaction rather than
 * only probe its regexp.
 *
 * Returns the resulting document, or `null` if no rule in
 * `buildInputRules()` handled the typed text at all — the same "stays
 * literal" outcome a real keystroke produces when nothing matches.
 */
/** The two properties `InputRule` actually carries at runtime, hidden from its public `.d.ts` behind an `@internal` tag — see this file's module comment. */
interface InspectableInputRule {
  readonly match: RegExp;
  readonly handler: (
    state: EditorState,
    match: RegExpMatchArray,
    start: number,
    end: number,
  ) => Transaction | null;
}

function inspect(rule: ReturnType<typeof buildInputRules>[number]): InspectableInputRule {
  return rule as unknown as InspectableInputRule;
}

function typeAt(doc: PMNode, pos: number, text: string): PMNode | null {
  const state = EditorState.create({ schema: entrySchema, doc });
  const $from = state.doc.resolve(pos);
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼") + text;
  for (const rule of buildInputRules().map(inspect)) {
    const match = rule.match.exec(textBefore);
    if (match === null || match[0].length < text.length) {
      continue;
    }
    const startPos = pos - (match[0].length - text.length);
    const tr = rule.handler(state, match, startPos, pos);
    if (tr !== null) {
      return tr.doc;
    }
  }
  return null;
}

/** The position right after the opening of a document's first paragraph — where typing into a freshly-seeded empty Entry lands. */
function startOfFirstParagraph(doc: PMNode): number {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found === null && node.type.name === "paragraph") {
      found = pos + 1;
    }
  });
  if (found === null) {
    throw new Error("fixture has no paragraph");
  }
  return found;
}

/** An empty Entry: a document holding a single empty paragraph (`entryMarkdownToDocument`'s own documented behaviour for `""`). */
function emptyDoc(): PMNode {
  return entryMarkdownToDocument("");
}

/**
 * CommonMark's bullet-marker alphabet (`@lezer/markdown`'s stock `BulletList`
 * parser, which `entryParser` uses unmodified — inline-markdown.ts) and its
 * ordered-list delimiter alphabet (same source, "`1.` and `1)` both give
 * 1"), gathered here ONCE. Both halves of the symmetry assertion below are
 * driven off these two arrays rather than off two independently-typed lists
 * of literals — the whole point of this test, per issue #161, is that a
 * marker added to one side (`parseEntryMarkdown`, by a future `@lezer/
 * markdown` config change) and not the other (`bulletListInputRule`/
 * `orderedListInputRule`) fails a loop, rather than two hand-maintained
 * assertions quietly drifting the same way ADR 0043's "one dialect" claim
 * already had for `*` and `1)` before this ticket.
 */
const READER_BULLET_MARKERS = ["-", "+", "*"] as const;
const READER_ORDERED_DELIMITERS = [".", ")"] as const;

describe("reader/writer symmetry: bullet markers", () => {
  for (const marker of READER_BULLET_MARKERS) {
    it(`"${marker} " is a bullet to both parseEntryMarkdown and the Composer`, () => {
      const blocks = parseEntryMarkdown(`${marker} milk`);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe("bulletList");

      const result = typeAt(emptyDoc(), startOfFirstParagraph(emptyDoc()), `${marker} `);
      expect(result).not.toBeNull();
      expect(result?.firstChild?.type.name).toBe("bullet_list");
      expect(result?.firstChild?.firstChild?.type.name).toBe("list_item");
    });
  }
});

describe("reader/writer symmetry: ordered-list delimiters", () => {
  for (const delimiter of READER_ORDERED_DELIMITERS) {
    it(`"1${delimiter} " is an ordered list to both parseEntryMarkdown and the Composer`, () => {
      const blocks = parseEntryMarkdown(`1${delimiter} alpha`);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe("orderedList");
      if (blocks[0]?.kind === "orderedList") {
        expect(blocks[0].start).toBe(1);
      }

      const result = typeAt(emptyDoc(), startOfFirstParagraph(emptyDoc()), `1${delimiter} `);
      expect(result).not.toBeNull();
      expect(result?.firstChild?.type.name).toBe("ordered_list");
      expect(result?.firstChild?.attrs.order).toBe(1);
    });

    it(`"5${delimiter} " starts an ordered list at 5, matching "5. "`, () => {
      const blocks = parseEntryMarkdown(`5${delimiter} alpha`);
      expect(blocks[0]?.kind).toBe("orderedList");
      if (blocks[0]?.kind === "orderedList") {
        expect(blocks[0].start).toBe(5);
      }

      const result = typeAt(emptyDoc(), startOfFirstParagraph(emptyDoc()), `5${delimiter} `);
      expect(result?.firstChild?.attrs.order).toBe(5);
    });
  }
});

// ---------------------------------------------------------------------------
// The one-step checklist shortcut ("[] ", "[x] ", "[X] ") — issue #161
// ---------------------------------------------------------------------------

describe("checklistShortcutInputRulePattern", () => {
  it("matches the bare, unchecked spelling with nothing between the brackets", () => {
    expect(checklistShortcutInputRulePattern.test("[] ")).toBe(true);
  });

  it("matches the checked spellings", () => {
    expect(checklistShortcutInputRulePattern.test("[x] ")).toBe(true);
    expect(checklistShortcutInputRulePattern.test("[X] ")).toBe(true);
  });

  // The GFM spelling with a literal space between the brackets is
  // deliberately NOT this rule's job — that spelling only ever means
  // something as an upgrade of an existing list item, which
  // `checkboxInputRulePattern`/`checkboxInputRule` already own. If this
  // pattern also matched it, a `- ` followed by `[ ] ` (the two-step path
  // this ticket explicitly keeps working) would risk this rule firing
  // instead of the upgrade path, on a paragraph that is already a list
  // item's child.
  it("does not match the GFM spelling with a space between the brackets", () => {
    expect(checklistShortcutInputRulePattern.test("[ ] ")).toBe(false);
  });

  it("does not match a character outside the checklist grammar", () => {
    expect(checklistShortcutInputRulePattern.test("[y] ")).toBe(false);
  });

  it("is nbsp-tolerant on its trailing separator, like every other rule in this file", () => {
    expect(checklistShortcutInputRulePattern.test(`[]${NBSP}`)).toBe(true);
    expect(checklistShortcutInputRulePattern.test(`[x]${NBSP}`)).toBe(true);
  });
});

describe("checklistShortcutInputRule (via buildInputRules)", () => {
  it("creates an unchecked checklist item directly, with no bullet step in between", () => {
    const doc = emptyDoc();
    const result = typeAt(doc, startOfFirstParagraph(doc), "[] ");
    expect(result).not.toBeNull();
    const list = result?.firstChild;
    expect(list?.type.name).toBe("bullet_list");
    expect(list?.childCount).toBe(1);
    const item = list?.firstChild;
    expect(item?.type.name).toBe("list_item");
    expect(item?.attrs.checked).toBe(false);
  });

  it.each(["x", "X"])("creates a checked checklist item for [%s]", (letter) => {
    const doc = emptyDoc();
    const result = typeAt(doc, startOfFirstParagraph(doc), `[${letter}] `);
    const item = result?.firstChild?.firstChild;
    expect(item?.type.name).toBe("list_item");
    expect(item?.attrs.checked).toBe(true);
  });

  it("stays literal text when [] is not at the start of a block", () => {
    const doc = entryMarkdownToDocument("milk ");
    const pos = startOfFirstParagraph(doc) + "milk ".length;
    const result = typeAt(doc, pos, "[] ");
    expect(result).toBeNull();
  });

  it("keeps checkboxInputRule's existing two-step upgrade path working unchanged", () => {
    // Step 1: "- " opens a bullet, the same as it always has.
    const afterBullet = typeAt(emptyDoc(), startOfFirstParagraph(emptyDoc()), "- ");
    expect(afterBullet).not.toBeNull();
    if (afterBullet === null) {
      throw new Error("unreachable");
    }
    // Step 2: "[x] " typed into that now-live, empty list item upgrades it
    // in place — `checkboxInputRule` fires (its guard requires an
    // enclosing list item), not `checklistShortcutInputRule` (its guard
    // requires the OPPOSITE), and the result is the SAME single list item,
    // never a second `bullet_list` nested inside the first.
    const pos = startOfFirstParagraph(afterBullet);
    const afterCheck = typeAt(afterBullet, pos, "[x] ");
    expect(afterCheck).not.toBeNull();
    const list = afterCheck?.firstChild;
    expect(list?.type.name).toBe("bullet_list");
    expect(list?.childCount).toBe(1);
    const item = list?.firstChild;
    expect(item?.type.name).toBe("list_item");
    expect(item?.attrs.checked).toBe(true);
    // No nested bullet_list: the item's own content is still just its
    // (empty) leading paragraph.
    expect(item?.childCount).toBe(1);
    expect(item?.firstChild?.type.name).toBe("paragraph");
  });
});
