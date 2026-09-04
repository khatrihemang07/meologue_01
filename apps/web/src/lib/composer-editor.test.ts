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
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import {
  activeChecklistPromotion,
  buildInputRules,
  checkboxInputRulePattern,
  checklistHighlightPlugin,
  checklistHighlightPluginKey,
  checklistShortcutInputRulePattern,
  liftAtStartOfListItem,
  taskReferenceSeparatorPlugin,
} from "./composer-editor";
import { entryMarkdownToDocument } from "./entry-document";
import { entrySchema } from "./entry-schema";
import { formatTaskReference, parseEntryMarkdown } from "./inline-markdown";

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

// ---------------------------------------------------------------------------
// liftAtStartOfListItem (Backspace's gated outdent, issue #162)
// ---------------------------------------------------------------------------

/** An `EditorState` with the caret/selection placed explicitly — mirrors composer-commands.test.ts's own `stateAt`, duplicated here rather than imported: that module deliberately never imports FROM this one (its own module comment), so the reverse import would be the one direction that actually IS allowed, but a two-line helper is cheaper than adding a cross-file dependency for it. */
function stateAt(doc: PMNode, selection: { from: number; to?: number }): EditorState {
  return EditorState.create({
    schema: entrySchema,
    doc,
    selection: TextSelection.create(doc, selection.from, selection.to ?? selection.from),
  });
}

/** Runs `liftAtStartOfListItem` with a `dispatch` that captures the transaction, returning both whether it applied and the resulting state (only meaningful when it did). */
function runLift(state: EditorState): { applied: boolean; next: EditorState } {
  let captured: Transaction | null = null;
  const applied = liftAtStartOfListItem(state, (tr) => {
    captured = tr;
  });
  return { applied, next: captured === null ? state : state.apply(captured) };
}

function countNodesOfType(doc: PMNode, nodeName: string): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === nodeName) {
      count += 1;
    }
  });
  return count;
}

/** `entrySchema.nodes` is indexed by plain `string` (composer-editor.ts's own `requireNodeType` doc comment has the full account), so under this repo's `noUncheckedIndexedAccess` every access types as possibly `undefined` even though, for these two fixtures below, it never actually is — a small local copy of that same throw-on-typo pattern, scoped to just the two node types these fixtures build by hand. */
function requireNodeType(name: "list_item" | "paragraph" | "bullet_list" | "doc") {
  const type = entrySchema.nodes[name];
  if (type === undefined) {
    throw new Error(`entrySchema has no "${name}" node type`);
  }
  return type;
}

describe("liftAtStartOfListItem", () => {
  it("lifts a top-level item out of its list at the very start of its paragraph", () => {
    const doc = entryMarkdownToDocument("- item");
    const state = stateAt(doc, { from: startOfFirstParagraph(doc) });
    const { applied, next } = runLift(state);
    expect(applied).toBe(true);
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(0);
    expect(countNodesOfType(next.doc, "list_item")).toBe(0);
  });

  it("does nothing when the selection is not collapsed", () => {
    const doc = entryMarkdownToDocument("- item");
    const from = startOfFirstParagraph(doc);
    const state = stateAt(doc, { from, to: from + 2 });
    expect(liftAtStartOfListItem(state)).toBe(false);
  });

  it("does nothing mid-paragraph, even inside a list item", () => {
    const doc = entryMarkdownToDocument("- milk");
    // One character in, not at the very start.
    const state = stateAt(doc, { from: startOfFirstParagraph(doc) + 1 });
    expect(liftAtStartOfListItem(state)).toBe(false);
  });

  it("does nothing at the start of an item's SECOND paragraph — only the first paragraph's start lifts", () => {
    // `entryMarkdownToDocument`'s own dialect has no "two paragraphs, one
    // list item" spelling (a blank line inside a list item's markdown
    // starts a new list item, not a second paragraph in the same one), so
    // this fixture is built directly off `entrySchema` rather than parsed,
    // the same way this module's own `list_item` content spec
    // (`"paragraph block*"`) allows in principle even though nothing in
    // this codebase's writer path produces it today.
    const item = requireNodeType("list_item").create({ checked: null }, [
      requireNodeType("paragraph").create(null, entrySchema.text("first")),
      requireNodeType("paragraph").create(null, entrySchema.text("second")),
    ]);
    const list = requireNodeType("bullet_list").create(null, [item]);
    const doc = requireNodeType("doc").create(null, [list]);

    let secondParagraphStart: number | null = null;
    let seen = 0;
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph") {
        seen += 1;
        if (seen === 2) {
          secondParagraphStart = pos + 1;
        }
      }
    });
    if (secondParagraphStart === null) {
      throw new Error("fixture has no second paragraph");
    }

    const state = stateAt(doc, { from: secondParagraphStart });
    expect(liftAtStartOfListItem(state)).toBe(false);
  });

  it("does nothing outside any list at all", () => {
    const doc = emptyDoc();
    const state = stateAt(doc, { from: startOfFirstParagraph(doc) });
    expect(liftAtStartOfListItem(state)).toBe(false);
  });

  it("lifts a nested (depth-2) item back to depth 1, not out of the list entirely", () => {
    // Build "first" / "second" sunk under "first" directly rather than via
    // indent, so this fixture doesn't depend on `indent`'s own behaviour
    // staying correct for this test to mean anything.
    const inner = requireNodeType("bullet_list").create(null, [
      requireNodeType("list_item").create({ checked: null }, [
        requireNodeType("paragraph").create(null, entrySchema.text("second")),
      ]),
    ]);
    const outerItem = requireNodeType("list_item").create({ checked: null }, [
      requireNodeType("paragraph").create(null, entrySchema.text("first")),
      inner,
    ]);
    const doc = requireNodeType("doc").create(null, [
      requireNodeType("bullet_list").create(null, [outerItem]),
    ]);

    let innerParagraphStart: number | null = null;
    doc.descendants((node, pos) => {
      if (
        innerParagraphStart === null &&
        node.type.name === "paragraph" &&
        node.textContent === "second"
      ) {
        innerParagraphStart = pos + 1;
      }
    });
    if (innerParagraphStart === null) {
      throw new Error("fixture has no nested paragraph");
    }

    expect(countNodesOfType(doc, "bullet_list")).toBe(2);
    const state = stateAt(doc, { from: innerParagraphStart });
    const { applied, next } = runLift(state);
    expect(applied).toBe(true);
    // Lifted one level, not all the way out: "second" is now a sibling
    // list_item of "first" in the SAME (outer) bullet_list, so there is
    // exactly one bullet_list left, not zero.
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(1);
    expect(countNodesOfType(next.doc, "list_item")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checklistHighlightPlugin (issue #173) — the live highlight/click-to-demote
// #170 built for Todo's add field, ported onto a checklist line. Its own
// `state.apply`/`props.decorations` are plain functions of an `EditorState`
// (ProseMirror's `Node`/`ResolvedPos`/`Transaction` all work without a DOM),
// so the DERIVATION — which line is "active," where a decoration lands, how
// a demotion threads through a later transaction — is genuinely testable
// here. What is NOT: `props.handleClick` needs a live `EditorView` to
// dispatch through, and real caret/typing behaviour needs a real browser
// (ADR 0044) — both stay e2e-only (apps/e2e/tests/composer.spec.ts), and
// specifically the one thing add-task-form.tsx's own defect (issue #170's
// backdrop losing sync with a scrolled field) cannot recur here in exactly
// the same shape: `Decoration.inline` paints INSIDE the real text node
// ProseMirror already renders, not a second, separately-scrolled layer —
// verified by reading composer-editor.ts's `decorations` prop, not by a
// jsdom test, since jsdom lays out and scrolls nothing.
describe("checklistHighlightPlugin", () => {
  /**
   * A fresh `EditorState` uses `Plugin.spec.state.init` for a plugin's own
   * value, never `apply` — `checklistHighlightPlugin`'s own `init` returns
   * `null` unconditionally (`pickerPlugin`/`slashPlugin`'s own identical
   * shape, both real-world plugins this file already mirrors), because a
   * live Composer always dispatches at least one transaction before a
   * reader can see anything (loading the document, the very first
   * keystroke). A test that only ever CONSTRUCTS a state, never applies
   * one, would see the plugin at that same "never derived yet" `null` —
   * not a bug in the plugin, a gap between how a fixture is built and how
   * the real editor actually runs. Applying one empty, no-op transaction
   * (identical selection, no doc change) closes that gap the same way a
   * live `EditorView`'s own mount effect implicitly does.
   */
  function stateWithHighlight(doc: PMNode, selection: { from: number; to?: number }): EditorState {
    const initial = EditorState.create({
      schema: entrySchema,
      doc,
      selection: TextSelection.create(doc, selection.from, selection.to ?? selection.from),
      plugins: [checklistHighlightPlugin()],
    });
    return initial.apply(initial.tr);
  }

  /** Every `Decoration.inline`'s own `[from, to)` span, sorted — `DecorationSet.find()` with no arguments returns every decoration in the set, in no particular order. */
  function decorationSpans(state: EditorState): Array<{ from: number; to: number }> {
    const plugin = checklistHighlightPlugin();
    // A fresh plugin INSTANCE, not the one already registered on `state` —
    // `props.decorations` is a pure function of `state` alone (it never
    // reads anything the plugin's own construction captured), so calling it
    // off a second instance is equivalent to calling it off the first; this
    // sidesteps needing `state.plugins` type gymnastics to reach the exact
    // instance `stateWithHighlight` built. Cast to `DecorationSet` rather
    // than the wider `DecorationSource` `props.decorations` is typed to
    // return: this file's own implementation only ever returns
    // `DecorationSet.empty`/`DecorationSet.create(...)`, never the other
    // shapes that union admits.
    const decorations = plugin.props.decorations?.call(plugin, state) as DecorationSet | undefined;
    const found = decorations?.find() ?? [];
    return found
      .map((d) => ({ from: d.from, to: d.to }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
  }

  /**
   * A checklist item's own leading paragraph carries the mandatory
   * separator after `[ ]`/`[x]` as literal leading text
   * (`inline-markdown.ts`'s own comment on `referencedTaskOf` — "the
   * mandatory single space... survives parsing as this run's own leading
   * text node"), so a fixture built from `"- [ ] buy milk p1"` does NOT
   * put "buy milk p1" at the paragraph's own content start; it puts
   * `" buy milk p1"` there, one character further in. Deriving every
   * expected offset from the paragraph's own `textContent` (rather than a
   * hand-counted string length) is what keeps these tests correct
   * regardless of that leading separator, instead of silently encoding
   * the same off-by-one this file's own tests exist to catch elsewhere.
   */
  function paragraphAt(doc: PMNode, blockStart: number): PMNode {
    return doc.resolve(blockStart).parent;
  }

  it("highlights a recognised token on the checklist line the caret is inside", () => {
    const doc = entryMarkdownToDocument("- [ ] buy milk p1");
    const blockStart = startOfFirstParagraph(doc);
    const text = paragraphAt(doc, blockStart).textContent;
    const state = stateWithHighlight(doc, { from: blockStart + text.length });

    const p1Offset = text.indexOf("p1");
    const p1Start = blockStart + p1Offset;
    expect(decorationSpans(state)).toEqual([{ from: p1Start, to: p1Start + "p1".length }]);
  });

  it("highlights nothing on an ordinary paragraph outside any checklist item", () => {
    const doc = entryMarkdownToDocument("buy milk p1");
    const state = stateWithHighlight(doc, { from: startOfFirstParagraph(doc) });

    expect(decorationSpans(state)).toEqual([]);
  });

  it("highlights nothing on a nested block below a checklist item's own first line", () => {
    const doc = entryMarkdownToDocument("- [ ] buy milk\n  - p1 is a note here, not a command");
    let nestedStart: number | null = null;
    doc.descendants((node, pos) => {
      if (
        nestedStart === null &&
        node.type.name === "paragraph" &&
        node.textContent.includes("p1")
      ) {
        nestedStart = pos + 1;
      }
    });
    if (nestedStart === null) {
      throw new Error("fixture has no nested paragraph");
    }
    const state = stateWithHighlight(doc, { from: nestedStart });

    expect(decorationSpans(state)).toEqual([]);
  });

  it("highlights nothing on an already-referenced checklist line — Promotion's own cached label is not prose to re-tokenize", () => {
    const doc = entryMarkdownToDocument(
      `- [ ] ${formatTaskReference("0192abcd-1234-7890-abcd-0123456789ac", "buy milk p1")}`,
    );
    const state = stateWithHighlight(doc, { from: startOfFirstParagraph(doc) });

    expect(decorationSpans(state)).toEqual([]);
  });

  it("carries a demotion forward across a later keystroke on the SAME line", () => {
    const doc = entryMarkdownToDocument("- [ ] buy milk p1");
    const blockStart = startOfFirstParagraph(doc);
    const text = paragraphAt(doc, blockStart).textContent;
    const opened = stateWithHighlight(doc, { from: blockStart + text.length });
    const p1Start = blockStart + text.indexOf("p1");
    expect(decorationSpans(opened)).toEqual([{ from: p1Start, to: p1Start + "p1".length }]);

    // The transaction `handleClick` itself dispatches: no doc change, just
    // the demoted token's own signature on the plugin's meta.
    const demoteTr = opened.tr.setMeta(checklistHighlightPluginKey, "priority:p1");
    const demoted = opened.apply(demoteTr);
    expect(decorationSpans(demoted)).toEqual([]);

    // Typing on the SAME line, past the demoted word — `demoted` must
    // survive this, the exact rule quick-add-highlight.ts's own
    // `parseWithDemotions` doc comment gives ("typing anywhere else in the
    // line never invalidates it"). " ok" rather than a bare character: `!`
    // alone is ALSO a real, recognised token (matchReminder,
    // ../../packages/core/src/quick-add/rules.ts — "the marker alone is
    // still a reminder token"), so it would highlight on its own merits
    // and this test would not be able to tell that apart from a demotion
    // actually failing to survive.
    const typeTr = demoted.tr.insertText(" ok", demoted.selection.from);
    const afterTyping = demoted.apply(typeTr);
    expect(decorationSpans(afterTyping)).toEqual([]);
  });

  it("does not carry a demotion onto a DIFFERENT checklist line", () => {
    const doc = entryMarkdownToDocument("- [ ] buy milk p1\n- [ ] call mum p1");
    const firstBlockStart = startOfFirstParagraph(doc);
    const firstText = paragraphAt(doc, firstBlockStart).textContent;
    const opened = stateWithHighlight(doc, { from: firstBlockStart + firstText.length });
    const demoteTr = opened.tr.setMeta(checklistHighlightPluginKey, "priority:p1");
    const demoted = opened.apply(demoteTr);
    expect(decorationSpans(demoted)).toEqual([]);

    let secondItemParagraphStart: number | null = null;
    doc.descendants((node, pos) => {
      if (
        secondItemParagraphStart === null &&
        node.type.name === "paragraph" &&
        node.textContent.includes("call mum")
      ) {
        secondItemParagraphStart = pos + 1;
      }
    });
    if (secondItemParagraphStart === null) {
      throw new Error("fixture has no second item");
    }
    const secondText = paragraphAt(doc, secondItemParagraphStart).textContent;
    const moveTr = demoted.tr.setSelection(
      TextSelection.create(demoted.doc, secondItemParagraphStart + secondText.length),
    );
    const movedAway = demoted.apply(moveTr);
    const secondP1Start = secondItemParagraphStart + secondText.indexOf("p1");
    expect(decorationSpans(movedAway)).toEqual([
      { from: secondP1Start, to: secondP1Start + "p1".length },
    ]);
  });

  // `activeChecklistPromotion` (issue #173 follow-up) — the ordinal +
  // demoted-signature pair `composer.tsx`'s own `send()` hands to
  // `promoteBareCheckboxes` (promote-tasks.ts) so a demotion the reader
  // clicked survives into promotion. Genuinely testable here for the
  // identical reason the rest of this describe block already is: a plain
  // function of an `EditorState`, no mounted `EditorView` needed.
  describe("activeChecklistPromotion", () => {
    it("returns null when the caret isn't on a checklist line at all", () => {
      const doc = entryMarkdownToDocument("just a thought, no checkbox");
      const state = stateWithHighlight(doc, { from: startOfFirstParagraph(doc) });

      expect(activeChecklistPromotion(state)).toBeNull();
    });

    it("returns ordinal 0 and an empty demoted set for the one checklist item in the Entry", () => {
      const doc = entryMarkdownToDocument("- [ ] buy milk p1");
      const blockStart = startOfFirstParagraph(doc);
      const text = paragraphAt(doc, blockStart).textContent;
      const state = stateWithHighlight(doc, { from: blockStart + text.length });

      expect(activeChecklistPromotion(state)).toEqual({ ordinal: 0, demoted: new Set() });
    });

    it("counts by ORDINAL among qualifying items, not by list position — an already-referenced item ahead of it does not bump the count", () => {
      const doc = entryMarkdownToDocument(
        `- [ ] ${formatTaskReference("0192abcd-1234-7890-abcd-0123456789ac", "already promoted")}\n- [ ] call mum p1`,
      );
      let secondItemStart: number | null = null;
      doc.descendants((node, pos) => {
        if (
          secondItemStart === null &&
          node.type.name === "paragraph" &&
          node.textContent.includes("call mum")
        ) {
          secondItemStart = pos + 1;
        }
      });
      if (secondItemStart === null) {
        throw new Error("fixture has no second item");
      }
      const secondText = paragraphAt(doc, secondItemStart).textContent;
      const state = stateWithHighlight(doc, { from: secondItemStart + secondText.length });

      // The already-referenced FIRST item is not a promotable checklist
      // item at all (`promoteBareCheckboxes`'s own loop guard) — this
      // item, the only qualifying one, is ordinal 0, not 1.
      expect(activeChecklistPromotion(state)).toEqual({ ordinal: 0, demoted: new Set() });
    });

    it("counts a SECOND bare checkbox as ordinal 1, matching the order promoteBareCheckboxes visits them in", () => {
      const doc = entryMarkdownToDocument("- [ ] buy milk p1\n- [ ] call mum p1");
      let secondItemStart: number | null = null;
      doc.descendants((node, pos) => {
        if (
          secondItemStart === null &&
          node.type.name === "paragraph" &&
          node.textContent.includes("call mum")
        ) {
          secondItemStart = pos + 1;
        }
      });
      if (secondItemStart === null) {
        throw new Error("fixture has no second item");
      }
      const secondText = paragraphAt(doc, secondItemStart).textContent;
      const state = stateWithHighlight(doc, { from: secondItemStart + secondText.length });

      expect(activeChecklistPromotion(state)).toEqual({ ordinal: 1, demoted: new Set() });
    });

    it("counts a checkbox nested inside another item's own trailing content, matching promote-tasks.ts's own traversal", () => {
      const doc = entryMarkdownToDocument("- outer\n  - [ ] nested task p1");
      let nestedStart: number | null = null;
      doc.descendants((node, pos) => {
        if (
          nestedStart === null &&
          node.type.name === "paragraph" &&
          node.textContent.includes("nested task")
        ) {
          nestedStart = pos + 1;
        }
      });
      if (nestedStart === null) {
        throw new Error("fixture has no nested item");
      }
      const nestedText = paragraphAt(doc, nestedStart).textContent;
      const state = stateWithHighlight(doc, { from: nestedStart + nestedText.length });

      expect(activeChecklistPromotion(state)).toEqual({ ordinal: 0, demoted: new Set() });
    });

    it("carries the plugin's own demoted signatures through, for the ordinal it names", () => {
      const doc = entryMarkdownToDocument("- [ ] buy milk p1");
      const blockStart = startOfFirstParagraph(doc);
      const text = paragraphAt(doc, blockStart).textContent;
      const opened = stateWithHighlight(doc, { from: blockStart + text.length });
      const demoteTr = opened.tr.setMeta(checklistHighlightPluginKey, "priority:p1");
      const demoted = opened.apply(demoteTr);

      expect(activeChecklistPromotion(demoted)).toEqual({
        ordinal: 0,
        demoted: new Set(["priority:p1"]),
      });
    });
  });
});

// taskReferenceSeparatorPlugin (issue #177) — a pure function of
// `state.doc` alone (no selection, no plugin state), so it's testable the
// identical way `checklistHighlightPlugin`'s own `props.decorations` is
// above: construct a state, ask the plugin for decorations, check the
// spans. Whether that hidden span actually renders with no visual width in
// a real browser is a `white-space: pre-wrap` / `display: none` CSS
// question this file has no DOM to answer — apps/e2e's composer.spec.ts
// (or a screenshot) is where that gets checked for real.
describe("taskReferenceSeparatorPlugin", () => {
  const TASK_ID = "11111111-2222-4333-8444-555555555555";

  function decorationSpans(doc: PMNode): Array<{ from: number; to: number }> {
    const state = EditorState.create({ schema: entrySchema, doc });
    const plugin = taskReferenceSeparatorPlugin();
    const decorations = plugin.props.decorations?.call(plugin, state) as DecorationSet | undefined;
    const found = decorations?.find() ?? [];
    return found
      .map((d) => ({ from: d.from, to: d.to }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
  }

  it("hides the mandatory separator space on a referenced checklist item", () => {
    const body = `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`;
    const doc = entryMarkdownToDocument(body);
    const blockStart = startOfFirstParagraph(doc);

    // The paragraph's own content is exactly [text(" "), task_reference]
    // (entry-document.test.ts's own comment on why) — the separator is
    // the one character right at the paragraph's own content start.
    expect(decorationSpans(doc)).toEqual([{ from: blockStart, to: blockStart + 1 }]);
  });

  it("hides nothing on an ordinary bare checklist item — only a referenced line has a separator to hide", () => {
    const doc = entryMarkdownToDocument("- [ ] buy milk\n- [x] call mum\n- plain");

    expect(decorationSpans(doc)).toEqual([]);
  });

  it("hides nothing on an ordinary paragraph with no checklist item at all", () => {
    const doc = entryMarkdownToDocument("buy milk, please");

    expect(decorationSpans(doc)).toEqual([]);
  });

  it("hides one separator per referenced item when a checklist holds several", () => {
    const body = [
      `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
      "- [ ] a bare checkbox",
      `- [x] ${formatTaskReference("22222222-3333-4444-8555-666666666666", "call mum")}`,
    ].join("\n");
    const doc = entryMarkdownToDocument(body);

    expect(decorationSpans(doc)).toHaveLength(2);
  });
});
