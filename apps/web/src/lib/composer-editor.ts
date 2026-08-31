/**
 * The ProseMirror wiring issue #155 adds on top of `entrySchema`
 * (entry-schema.ts, issue #154): input rules that consume `**`/`*`/`` ` ``/
 * `- `/`1. `/`- [ ] ` as they're typed, the list Enter/lift keymap, and the
 * inline `[[` picker's own ProseMirror-side trigger detection.
 *
 * `prosemirror-markdown` is not a dependency (see entry-document.ts's own
 * module comment and ADR 0044) and none of this reaches for it —
 * `markInputRule` below is a small, hand-written replacement for the one
 * piece of that package's `inputrules.ts` this file actually needed (mark
 * toggling from a typed delimiter pair), not a second Markdown parser.
 */
import { baseKeymap, chainCommands, splitBlock } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, NodeType, Node as PMNode } from "prosemirror-model";
import { liftListItem, splitListItem } from "prosemirror-schema-list";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { derivePicker, type ReferencePickerState } from "@/lib/composer-picker";
import { entrySchema } from "@/lib/entry-schema";

// ---------------------------------------------------------------------------
// Typed schema access
// ---------------------------------------------------------------------------

/**
 * `entrySchema.nodes`/`.marks` are indexed by plain `string` (entry-schema.ts
 * builds them from `{[name: string]: NodeSpec}`/`MarkSpec` records, not a
 * literal-key union), so under this repo's `noUncheckedIndexedAccess` every
 * access types as possibly `undefined` — even though, for `entrySchema`
 * specifically, it never actually is: nothing here reaches for a node or
 * mark name the schema doesn't define. These two throw rather than return
 * `undefined` so every call site below can treat the result as the real
 * `NodeType`/`MarkType` it always is, and so a typo here fails immediately
 * and loudly (a missing node type breaks the whole editor at construction
 * time) rather than surfacing later as a confusing runtime error deep
 * inside an input rule or a keymap command.
 */
function requireNodeType(name: string): NodeType {
  const type = entrySchema.nodes[name];
  if (type === undefined) {
    throw new Error(`entrySchema has no "${name}" node type`);
  }
  return type;
}

function requireMarkType(name: string): MarkType {
  const type = entrySchema.marks[name];
  if (type === undefined) {
    throw new Error(`entrySchema has no "${name}" mark type`);
  }
  return type;
}

/** The `reference` node type — exported for composer.tsx, which needs it to build a live Reference node from the `[[` picker and from `insertAtCursor`. */
export const referenceNodeType = requireNodeType("reference");

// ---------------------------------------------------------------------------
// Mark input rules: **bold**, *italic*, `code`
// ---------------------------------------------------------------------------

/**
 * Applies `markType` to whatever `regexp`'s first capture group matched,
 * deleting the delimiter characters around it — `**bold**` becomes `bold`
 * with the strong mark applied, never left as literal asterisks next to
 * formatted text.
 *
 * The delimiters can sit on either side of the captured text asymmetrically
 * in principle (a future rule might not be `X...X`), so this locates the
 * capture by its actual offset within the full match (`match[0].indexOf`)
 * rather than assuming it starts right after a fixed-length opener; deletes
 * whatever trails the capture first (positions past it are unaffected by
 * that deletion), then whatever leads it, so the final `addMark` range
 * always lines up with where the captured text now actually sits.
 *
 * `removeStoredMark` after applying is what stops the NEXT character typed
 * from inheriting the mark — without it, typing were to continue directly
 * after `**bold**` would carry on as bold, which is not what closing a pair
 * of delimiters means.
 */
function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const captured = match[1];
    if (captured === undefined || captured.trim() === "") {
      return null;
    }
    const offset = match[0].indexOf(captured);
    if (offset < 0) {
      return null;
    }
    const tr = state.tr;
    const textStart = start + offset;
    const textEnd = textStart + captured.length;
    if (textEnd < end) {
      tr.delete(textEnd, end);
    }
    if (textStart > start) {
      tr.delete(start, textStart);
    }
    const markEnd = start + captured.length;
    tr.addMark(start, markEnd, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

/**
 * `(?<!\*)` guards the em rule's opening `*` — without it, typing
 * `**bold**` one character at a time misfires: input rules re-run on
 * EVERY keystroke, not just the final one, and the instant the FIRST
 * closing `*` of the pair is typed, the text in front of the caret is
 * `**bold*` — which `\*([^*]+)\*$` alone genuinely matches, at the
 * SECOND `*` as its opener and the just-typed one as its closer, turning
 * "bold" italic and leaving one stray `*` behind before the strong rule
 * ever gets a chance to see two adjacent closers. Verified live in a real
 * browser (jsdom cannot drive `handleTextInput` at all — composer.tsx's
 * own module comment), not reasoned out ahead of time; a naive read of
 * the finished string "**bold**" makes the two patterns look
 * structurally exclusive, and they are NOT once every intermediate
 * keystroke is considered. The lookbehind closes exactly that gap:
 * an opening `*` immediately preceded by another `*` is never a valid
 * em delimiter, so the false match above no longer exists, and the
 * legitimate case (an em delimiter preceded by anything else, or
 * nothing at all) is untouched.
 */
const strongInputRule = markInputRule(/\*\*([^*]+)\*\*$/, requireMarkType("strong"));
const emInputRule = markInputRule(/(?<!\*)\*([^*]+)\*$/, requireMarkType("em"));
const codeInputRule = markInputRule(/`([^`]+)`$/, requireMarkType("code"));

// ---------------------------------------------------------------------------
// List input rules: "- ", "1. ", and "- [ ] "/"- [x] " for a checkbox
// ---------------------------------------------------------------------------

const bulletListNodeType = requireNodeType("bullet_list");
const orderedListNodeType = requireNodeType("ordered_list");
const listItemNodeType = requireNodeType("list_item");

const bulletListInputRule = wrappingInputRule(/^\s*([-+])\s$/, bulletListNodeType);

const orderedListInputRule = wrappingInputRule(
  /^(\d+)\.\s$/,
  orderedListNodeType,
  (match) => ({ order: Number(match[1]) }),
  // Standard prosemirror-schema-list join predicate (its own module
  // comment recommends exactly this): continuing a `5. `, `6. `, ... run
  // directly after an existing ordered list joins into it rather than
  // starting a second, adjacent one — matched here against the SAME
  // numbering `entryDocumentToMarkdown`'s own `markerFor` would have
  // produced for that position, so a list typed this way round-trips
  // identically to one written by hand.
  (match, node) => node.childCount + Number(node.attrs.order) === Number(match[1]),
);

/**
 * `- [ ] ` / `- [x] `: not one rule, but the composition of two — the
 * bullet rule above already turns `- ` into a plain bullet item the instant
 * the space after the dash is typed, before `[ ] ` even exists to match
 * against. This rule is what upgrades that already-created item into a
 * task a few keystrokes later: it fires only when `[ ]`/`[x]` plus a space
 * is typed at the very START of a list item's own opening paragraph (never
 * mid-item — a checkbox typed into a later paragraph inside a multi-block
 * item would be describing that paragraph's content, not the item's own
 * state), and sets `checked` on the enclosing `list_item` rather than on
 * the paragraph the regexp actually matched against.
 *
 * A plain paragraph (no enclosing list item, or not that item's first
 * child) returns `null` — the typed `[ ] ` stays exactly as typed, a
 * checkbox mark meaning nothing outside a list is not part of this
 * dialect's grammar any more than a heading is (ADR 0043).
 */
function checkboxInputRule(): InputRule {
  return new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const grandParent = $start.node(-1);
    if (grandParent.type !== listItemNodeType) {
      return null;
    }
    if ($start.index(-1) !== 0) {
      return null;
    }
    const marker = match[1];
    const checked = marker !== undefined && marker.toLowerCase() === "x";
    const itemPos = $start.before(-1);
    return state.tr.delete(start, end).setNodeMarkup(itemPos, undefined, { checked });
  });
}

export function buildInputRules(): InputRule[] {
  return [
    strongInputRule,
    emInputRule,
    codeInputRule,
    bulletListInputRule,
    orderedListInputRule,
    checkboxInputRule(),
  ];
}

// ---------------------------------------------------------------------------
// Keymap: splitListItem / liftListItem on Enter, undo/redo, everything else
// from prosemirror-commands' baseKeymap
// ---------------------------------------------------------------------------

/**
 * `chainCommands(splitListItem, liftListItem)` is the shape
 * prosemirror-schema-list's own `splitListItem` doc comment is written
 * for: on a non-empty list item it splits into the next item; on an EMPTY
 * top-level item it deliberately returns `false` ("bail out and let next
 * command handle lifting") rather than lifting itself, which is exactly
 * what makes chaining `liftListItem` right after it correct instead of
 * redundant — Enter on an empty item then escapes the list one level, per
 * the ticket. Outside a list entirely both commands return `false` and the
 * key falls through (see this module's own comment on plugin order in
 * `buildComposerPlugins`) to `baseKeymap`'s own Enter, an ordinary
 * paragraph split.
 *
 * `Shift-Enter` is bound to the SAME chain, plus `splitBlock` appended as
 * its own final fallback — not left to fall through to `baseKeymap` the
 * way plain `Enter` does. `prosemirror-keymap`'s own matching (verified by
 * reading its source, not assumed) only tries a held Shift as a fallback
 * for single-character keys — "a", producing "A" — never for a NAMED key
 * like "Enter", so a keymap that binds only `Enter` is never consulted at
 * all for `Shift-Enter`; the keydown handler returns `false` outright,
 * nothing calls `preventDefault()`, and the browser's own native
 * contenteditable behaviour runs unopposed — normally a bare `<br>`,
 * which `entrySchema` has no node for at all (there is no `hard_break`),
 * so ProseMirror's own DOMObserver reconciles the DOM straight back to
 * the document's real state on its very next update and the keystroke
 * simply vanishes. The ticket's own requirement is only "Shift+Enter
 * still never sends" — true either way, since `isSubmitChord` already
 * excludes it — but silently eating the keystroke is worse than making it
 * behave exactly like a plain Enter, which is what the pre-#155
 * `<textarea>` did for both (issue #76: neither one ever sent, and both
 * inserted the same plain newline).
 */
function listKeymap(): Plugin {
  const listChain = chainCommands(splitListItem(listItemNodeType), liftListItem(listItemNodeType));
  return keymap({
    Enter: listChain,
    "Shift-Enter": chainCommands(listChain, splitBlock),
  });
}

function historyKeymap(): Plugin {
  return keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
  });
}

// ---------------------------------------------------------------------------
// The inline `[[` picker's ProseMirror-side trigger detection
// ---------------------------------------------------------------------------

export const pickerPluginKey = new PluginKey<ReferencePickerState | null>("composer-picker");

/**
 * The meta flag composer.tsx's own Escape handler sets on an otherwise
 * empty transaction (no doc change, no selection change) to force the
 * picker closed without touching the document. Necessary because — unlike
 * the old `<textarea>`, where `setPicker(null)` was a plain, independent
 * piece of React state — this plugin's state is DERIVED fresh from the doc
 * and selection on every transaction (see `pickerPlugin`'s own comment);
 * dispatching a transaction that carries neither would otherwise re-derive
 * the exact same open state right back, since nothing about the text or
 * caret actually changed. `dispatchTransaction` never marks the Entry
 * dirty for a transaction like this one (it checks `docChanged`, and a
 * dismiss carries none), which matters: pressing Escape to close the list
 * must never be what makes closing an unedited Entry look "changed".
 */
export const PICKER_DISMISS_META = "dismiss";

/**
 * One textblock's own content, flattened to plain text with each inline
 * atom (a `reference` node) standing in for exactly one character —
 * `￼`, the Unicode object-replacement character ProseMirror's own
 * `textBetween` already uses as its conventional leaf placeholder. That
 * choice is what keeps a doc position (where an atom's `nodeSize` is 1,
 * same as any single character) and an index into this string in exact 1:1
 * correspondence, which is the property `derivePicker`'s caller relies on
 * below: `$from.parentOffset` can be used directly as an index into this
 * string, and a string index this function returns can be added straight
 * back onto the block's own start position with no further conversion.
 */
function textBlockPlainText(parent: PMNode): string {
  let out = "";
  parent.forEach((child) => {
    out += child.isText ? (child.text ?? "") : "￼";
  });
  return out;
}

/**
 * Recomputes the picker's state from scratch on every transaction — same
 * rule composer-picker.ts's own module comment gives for `derivePicker`
 * itself, extended one layer out: rather than track "did the doc change
 * near the trigger" incrementally, this rebuilds the current textblock's
 * plain text and caret position fresh every time and re-derives from that,
 * so a keystroke, a backspace, and the caret simply moving away are all the
 * same code path here too.
 *
 * `previous.start`/the derived result's `start` are absolute document
 * positions; `derivePicker` itself only ever deals in offsets relative to
 * the CURRENT textblock, so this plugin is the translation layer between
 * the two — see `textBlockPlainText`'s own comment for why that
 * translation is exact arithmetic rather than an approximation. If the
 * selection has moved to a different textblock since `previous` was set,
 * the translated `relativeStart` will not describe a real trigger position
 * in the new block's text; `derivePicker`'s own validation (re-checking
 * that its two preceding characters are still the trigger) rejects that
 * cleanly and returns `null` rather than needing this plugin to detect the
 * block change itself.
 */
export function pickerPlugin(): Plugin<ReferencePickerState | null> {
  return new Plugin<ReferencePickerState | null>({
    key: pickerPluginKey,
    state: {
      init: (): ReferencePickerState | null => null,
      apply(tr, previous, _oldState, newState): ReferencePickerState | null {
        if (tr.getMeta(pickerPluginKey) === PICKER_DISMISS_META) {
          return null;
        }
        const { $from } = newState.selection;
        if (!$from.parent.isTextblock) {
          return null;
        }
        const blockStart = $from.start();
        const text = textBlockPlainText($from.parent);
        const caret = $from.parentOffset;
        const relativePrevious =
          previous === null ? null : { start: previous.start - blockStart, query: previous.query };
        const next = derivePicker(text, caret, relativePrevious);
        return next === null ? null : { start: next.start + blockStart, query: next.query };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// The empty-document placeholder
// ---------------------------------------------------------------------------

/**
 * Draws `text` as a widget decoration inside an entirely empty document —
 * never a native `placeholder` attribute, since that only has meaning on an
 * `<input>`/`<textarea>` and this is a `contenteditable` `<div>`. A widget
 * decoration is ProseMirror's own mechanism for DOM the document itself
 * doesn't own (it isn't part of the doc, isn't selectable text, and vanishes
 * the instant the first character is typed because `isEmpty` below then
 * reads `false`) — the standard alternative, a CSS `::before` keyed off an
 * empty paragraph, would need `:has()` to reach through the `<br>`
 * ProseMirror itself inserts into an empty textblock so the browser doesn't
 * collapse its line box, for no benefit over reading the doc directly here.
 */
function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const first = state.doc.firstChild;
        const isEmpty =
          state.doc.childCount === 1 &&
          first !== null &&
          first.type.name === "paragraph" &&
          first.content.size === 0;
        if (!isEmpty) {
          return DecorationSet.empty;
        }
        const widget = document.createElement("span");
        widget.className = "pointer-events-none select-none text-muted-foreground";
        widget.textContent = text;
        return DecorationSet.create(state.doc, [
          Decoration.widget(1, widget, { ignoreSelection: true }),
        ]);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// A paragraph's NodeView
// ---------------------------------------------------------------------------

/**
 * `entrySchema`'s `paragraph` spec (entry-schema.ts) has no `toDOM` either
 * — unlike `bullet_list`/`ordered_list`/`list_item`, which inherit theirs
 * from `prosemirror-schema-list`'s own base specs, `paragraph` is entirely
 * this ticket's to render. A NodeView with a `contentDOM` (rather than
 * adding `toDOM: () => ["p", 0]` to the shared schema) for the same reason
 * `referenceNodeView`'s own comment gives: keeping `entrySchema` itself
 * free of anything view-specific, since entry-document.ts's round-trip
 * tests build documents against this exact schema with no `EditorView` in
 * sight.
 */
export function paragraphNodeView(): NodeView {
  const dom = document.createElement("p");
  return { dom, contentDOM: dom };
}

// ---------------------------------------------------------------------------
// A task list item's checkbox
// ---------------------------------------------------------------------------

// `flex list-none items-baseline gap-1.5`, deliberately WITHOUT
// `entry-prose.tsx`'s own `-ml-5` — that negative margin is safe in
// History's read-only bubble, which never constrains horizontal overflow,
// but the Composer's own editable root sets `overflow-y-auto` for its
// 8-line scroll ceiling, and the CSS overflow spec forces a "visible"
// `overflow-x` to compute as `auto` the instant the OTHER axis is
// anything but `visible` — there is no way to opt back out of that
// coupling. `overflow-x: auto` clips content pulled left of the box's own
// start edge rather than letting it bleed into the padding the way it
// does in an unconstrained bubble, which silently pushed the checkbox
// out of its own hit-testable area — visible in the render, invisible to
// any assertion that doesn't actually try to click it. Playwright's
// `locator.click()` on the checkbox in apps/e2e's own composer.spec.ts
// caught this ("<div class=\"...items-end...\"> intercepts pointer
// events") where a same-origin `element.click()` — used only for a quick
// manual check while building this, never for real coverage — did not,
// because `.click()` has no notion of "is this pixel actually there."
// Losing the tight bullet-position alignment read mode gets is the
// trade: a task item's checkbox sits at the list's own ordinary indent
// instead, not smaller, but always exactly where it is drawn.
const TASK_LI_CLASS = "flex list-none items-baseline gap-1.5";
const TASK_CONTENT_CLASS = "min-w-0 flex-1";
const TASK_CHECKBOX_CLASS = "mt-[0.2em] shrink-0 accent-current";

/**
 * `list_item`'s own `<li>` DOES inherit a working `toDOM` from
 * `prosemirror-schema-list` (unlike `paragraph`/`reference`, just above and
 * below) — but that inherited `toDOM` is a bare `["li", 0]`, and knows
 * nothing about this schema's own `checked` attribute (entry-schema.ts's
 * own extension over the base spec). Left alone, a checklist typed in the
 * Composer would silently drop its checkbox entirely: the document model
 * would carry `checked` correctly (`entryDocumentToMarkdown` would still
 * serialize `- [ ] `/`- [x] ` right), but nothing on screen would show it
 * while writing — caught only by looking at the rendered editor, not by
 * any of this ticket's unit tests, which is exactly the class of defect
 * ADR 0036 already named once ("passed every test and was wrong on
 * screen").
 *
 * Mirrors `entry-prose.tsx`'s own `renderListItem` — same classes, same
 * layout (the checkbox beside the content in a flex row, not nested
 * inside the marker box a plain bullet would otherwise claim) — so a task
 * item looks identical whether it's being composed or being read. Unlike
 * that read-only renderer, the checkbox here is live: toggling it commits
 * straight through `setNodeMarkup`, the same one-attribute update
 * `checkboxInputRule` itself performs, rather than being wired through a
 * separate `onToggleTask` callback the way History's own tap-to-toggle is
 * — this is the Composer's own document, already mid-edit, so there is no
 * separate commit path to reach for.
 *
 * The checkbox sits OUTSIDE `contentDOM` (a sibling, inserted before it)
 * rather than inside it — ProseMirror only ever interprets DOM mutations
 * inside `contentDOM` as document edits, so building the checkbox as a
 * plain sibling is what keeps ProseMirror from ever mistaking a toggle (or
 * this function's own DOM writes reacting to `checked` changing) for a
 * paragraph edit.
 */
export function listItemNodeView(
  node: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  const dom = document.createElement("li");
  const contentDOM = document.createElement("div");
  let checkbox: HTMLInputElement | null = null;

  function render(current: PMNode) {
    if (current.attrs.checked === null) {
      dom.className = "";
      contentDOM.className = "";
      checkbox?.remove();
      checkbox = null;
      if (contentDOM.parentElement !== dom) {
        dom.appendChild(contentDOM);
      }
      return;
    }
    dom.className = TASK_LI_CLASS;
    contentDOM.className = TASK_CONTENT_CLASS;
    if (checkbox === null) {
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = TASK_CHECKBOX_CLASS;
      checkbox.addEventListener("change", () => {
        const pos = getPos();
        if (pos === undefined) {
          return;
        }
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { checked: checkbox?.checked === true }),
        );
      });
    }
    checkbox.checked = current.attrs.checked === true;
    dom.insertBefore(checkbox, contentDOM);
  }

  render(node);
  return {
    dom,
    contentDOM,
    update(updatedNode) {
      if (updatedNode.type.name !== "list_item") {
        return false;
      }
      render(updatedNode);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// A Reference's NodeView
// ---------------------------------------------------------------------------

/**
 * `entrySchema`'s own `reference` node spec (entry-schema.ts) has no
 * `toDOM` — issue #154 built that schema purely for the two conversions,
 * with no editor view yet to render into. Supplying a NodeView here rather
 * than adding `toDOM` to the shared schema keeps the schema itself free of
 * anything view-specific (`entrySchema` is also used, headless, by
 * entry-document.ts's own round-trip tests), and a NodeView is the
 * standard place for exactly this: a leaf that renders its own `raw` text
 * — the literal `[[2026-08-28]]`/`[[e:<uuid>]]` characters, never a
 * resolved label, per ADR 0042 — as a single, non-editable unit a reader
 * can select or delete but never type inside.
 */
export function referenceNodeView(node: PMNode): NodeView {
  const span = document.createElement("span");
  span.className = "underline underline-offset-2 rounded-sm";
  span.dataset.reference = "true";
  span.contentEditable = "false";
  span.textContent = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
  return {
    dom: span,
    selectNode() {
      span.classList.add("bg-accent");
    },
    deselectNode() {
      span.classList.remove("bg-accent");
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Every plugin the Composer's `EditorView` needs, in the order that makes
 * `listKeymap`'s Enter binding take priority over `baseKeymap`'s own: two
 * separate `keymap()` plugins bound to the same key chain automatically —
 * ProseMirror tries each plugin's `handleKeyDown` prop in order and moves
 * to the next only if the current one returns `false` — so `listKeymap`
 * simply needs to be registered before `keymap(baseKeymap)`, not merged
 * into one combined bindings object.
 */
export function buildComposerPlugins(placeholder: string): Plugin[] {
  return [
    listKeymap(),
    historyKeymap(),
    keymap(baseKeymap),
    inputRules({ rules: buildInputRules() }),
    pickerPlugin(),
    placeholderPlugin(placeholder),
    history(),
  ];
}
