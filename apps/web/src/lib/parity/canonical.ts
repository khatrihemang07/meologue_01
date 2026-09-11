/**
 * Issue #230's canonical form: a structural shape an Entry's body can be
 * normalized into from EITHER of the two apps that can produce one, so a
 * parity row can compare "what UpNote built" against "what this Composer
 * built" as data, not as two different serializations that merely look
 * similar on screen.
 *
 * The normalization problem this module exists to solve is named directly
 * in issue #230: UpNote nests a list as a *sibling* `<ul>`/`<ol>` of the
 * `<li>` it follows — `<ul><li>one</li><ul><li>two</li></ul></ul>`, invalid
 * per the HTML spec but verified (`upnote-editor-behaviour.md`) as exactly
 * what UpNote's own editor writes — while this repo's own schema
 * (`entry-schema.ts`) nests a list as a *child* of the `list_item`:
 * `list_item: "paragraph block*"`, so a nested `bullet_list` sits inside
 * the item it belongs to, not beside it. Two trees with a different shape
 * for identical on-screen content is exactly the case a "compare the two
 * apps" harness cannot get away with comparing structurally as-is — so
 * `CanonicalListItem` below flattens both shapes to the same thing: an
 * ordered list of items, each carrying its own nesting `level` as a plain
 * number, however its own source tree happened to spell "nested."
 *
 * The other normalization this module exists for is named in ADR 0066: a
 * block-level split (two sibling `paragraph` nodes on our side, two
 * sibling `<div>`s on UpNote's) and a same-block soft break (a literal
 * `\n` inside one `paragraph`'s text on our side, a `<br>` inside one
 * `<div>` on UpNote's) are the two only ways either app ever puts a line
 * break in prose. `CanonicalProse` keeps both as one flat run of `lines`
 * joined by a `breaks` array recording, entry by entry, which of the two
 * kinds separated that pair of lines — which is the one piece of
 * information a parity row about Enter vs Shift+Enter actually turns on.
 *
 * Both adapters below (`entryDocumentToCanonical`/`entryMarkdownToCanonical`
 * for this repo's own document, `upnoteHtmlToCanonical` for UpNote's stored
 * HTML) are expected to produce IDENTICAL `CanonicalDocument` values for
 * two documents a person would call "the same entry" — that agreement is
 * the whole point of the module, not an incidental property of it.
 */
import type { Mark, Node as PMNode } from "prosemirror-model";
import { entryMarkdownToDocument } from "../entry-document";

// ---------------------------------------------------------------------------
// The canonical shape itself
// ---------------------------------------------------------------------------

/**
 * How two adjacent lines of prose came to be adjacent. `"block"` is a
 * genuine block-level split — two sibling `paragraph` nodes on our side
 * (only ever produced today by leaving a list, ADR 0066's own
 * "Consequences"), two sibling `<div>`s on UpNote's. `"soft"` is a literal
 * `\n` living inside one text run — `insertSoftBreak`'s own output on our
 * side, a `<br>` on UpNote's.
 */
export type CanonicalBreak = "block" | "soft";

/** The mark set both dialects can express. See `entry-schema.ts`'s own marks. */
export type CanonicalMarkKind = "strong" | "em" | "code" | "strikethrough";

/**
 * One run of inline content. `text`/`reference`/`taskReference` mirror
 * `entry-schema.ts`'s three inline node kinds (`text`, `reference`,
 * `task_reference`); UpNote's own HTML never produces a `reference` or
 * `taskReference` run, since `[[…]]`/`[[task:…]]` are this repo's own
 * syntax, not UpNote's — a parity row that compares References is
 * therefore always `divergence: "deliberate"` on the UpNote side (no
 * counterpart exists to compare against), not something this module needs
 * to special-case.
 */
export type CanonicalInline =
  | { readonly kind: "text"; readonly text: string; readonly marks: readonly CanonicalMarkKind[] }
  | {
      readonly kind: "reference";
      readonly raw: string;
      readonly marks: readonly CanonicalMarkKind[];
    }
  | {
      readonly kind: "taskReference";
      readonly label: string;
      readonly checked: boolean;
      readonly marks: readonly CanonicalMarkKind[];
    };

/**
 * A flat run of prose: one array of lines (each line its own array of
 * inline runs, empty for a blank line) and, between each adjacent pair, the
 * kind of break that put them next to each other. `breaks.length` is always
 * `lines.length - 1`.
 */
export interface CanonicalProse {
  readonly lines: readonly (readonly CanonicalInline[])[];
  readonly breaks: readonly CanonicalBreak[];
}

/**
 * One list item, flattened to its own nesting depth (`level`, 0 for a
 * top-level item) rather than nested inside its parent the way either
 * source tree does. `listKind` and `checked` are deliberately orthogonal —
 * matching `entry-schema.ts`'s own `list_item.checked` living beside
 * `bullet_list`/`ordered_list` rather than inside a third node type, and
 * matching UpNote's own model directly: `upnote-editor-behaviour.md`
 * states plainly that "a checklist is not a separate structure: it is a
 * `<ul>` whose `<li>` carries `data-checked`." `checked: null` is a plain
 * item; `true`/`false` is a checklist item's own state.
 */
export interface CanonicalListItem {
  readonly listKind: "bullet" | "ordered";
  readonly level: number;
  readonly checked: boolean | null;
  readonly prose: CanonicalProse;
}

export type CanonicalBlock =
  | { readonly kind: "prose"; readonly prose: CanonicalProse }
  | { readonly kind: "list"; readonly items: readonly CanonicalListItem[] };

export interface CanonicalDocument {
  readonly blocks: readonly CanonicalBlock[];
}

// ---------------------------------------------------------------------------
// A small builder shared by both adapters for the "flat lines + breaks"
// shape above — the one piece of bookkeeping (close the current line,
// start a new one, remember what kind of break did it) both otherwise
// unrelated tree walks below need identically.
// ---------------------------------------------------------------------------

class ProseBuilder {
  private readonly linesInProgress: CanonicalInline[][] = [[]];
  private readonly breaksInProgress: CanonicalBreak[] = [];

  push(inline: CanonicalInline): void {
    const current = this.linesInProgress[this.linesInProgress.length - 1];
    if (current === undefined) {
      throw new Error("ProseBuilder invariant violated: no current line");
    }
    current.push(inline);
  }

  breakLine(kind: CanonicalBreak): void {
    this.breaksInProgress.push(kind);
    this.linesInProgress.push([]);
  }

  isEmpty(): boolean {
    return this.linesInProgress.length === 1 && this.linesInProgress[0]?.length === 0;
  }

  build(): CanonicalProse {
    return { lines: this.linesInProgress, breaks: this.breaksInProgress };
  }
}

function pushTextWithSoftBreaks(
  builder: ProseBuilder,
  text: string,
  marks: readonly CanonicalMarkKind[],
): void {
  const segments = text.split("\n");
  segments.forEach((segment, index) => {
    if (index > 0) {
      builder.breakLine("soft");
    }
    if (segment.length > 0) {
      builder.push({ kind: "text", text: segment, marks });
    }
  });
}

// ---------------------------------------------------------------------------
// entry-document.ts's own document -> canonical
// ---------------------------------------------------------------------------

function pmMarksToCanonical(marks: readonly Mark[]): readonly CanonicalMarkKind[] {
  const kinds: CanonicalMarkKind[] = [];
  for (const mark of marks) {
    if (
      mark.type.name === "strong" ||
      mark.type.name === "em" ||
      mark.type.name === "code" ||
      mark.type.name === "strikethrough"
    ) {
      kinds.push(mark.type.name);
    }
  }
  return kinds;
}

/** Appends one `paragraph` node's own inline content (text, marks, atoms, internal soft breaks) onto `builder`. */
function appendParagraphInline(builder: ProseBuilder, paragraph: PMNode): void {
  paragraph.forEach((child) => {
    if (child.isText) {
      pushTextWithSoftBreaks(builder, child.text ?? "", pmMarksToCanonical(child.marks));
      return;
    }
    const marks = pmMarksToCanonical(child.marks);
    if (child.type.name === "reference") {
      builder.push({ kind: "reference", raw: String(child.attrs.raw), marks });
    } else if (child.type.name === "task_reference") {
      builder.push({
        kind: "taskReference",
        label: String(child.attrs.label),
        checked: Boolean(child.attrs.checked),
        marks,
      });
    }
  });
}

/** Builds one item's own `CanonicalProse` from its leading `paragraph` — a `list_item`'s content is always `"paragraph block*"` (`entry-schema.ts`), so index 0 is always that paragraph. */
function itemProse(listItem: PMNode): CanonicalProse {
  const builder = new ProseBuilder();
  const leading = listItem.child(0);
  appendParagraphInline(builder, leading);
  return builder.build();
}

/** Flattens a `bullet_list`/`ordered_list` node's own child `list_item`s into `out`, recursing into any nested list a `block*` child carries and incrementing `level` each time — the normalization this module exists for. */
/**
 * True for an **empty parent item** (ADR 0071): a `list_item` carrying no
 * prose of its own whose only other content is the nested list it holds.
 *
 * This schema nests a list as a CHILD of its item, so indenting an item
 * with no preceding sibling — UpNote nests the first item of a list too,
 * verified on both platforms — has to mint a textless wrapper item to hang
 * that nested list from. UpNote needs no such node: it emits the nested
 * `<ul>` as a SIBLING of the `<li>`, so the identical visible document has
 * one fewer list item in its markup than ours does.
 *
 * That difference is a pure artefact of the two schemas, which is exactly
 * the class of difference this module exists to normalise away — the same
 * way `flattenHtmlList` already flattens UpNote's sibling nesting into a
 * `level` rather than preserving its shape. Counting the wrapper would
 * make every first-item-indent row read as a divergence when the two
 * documents are, on screen and in meaning, identical. The wrapper renders
 * markerless for the same reason (ADR 0071).
 *
 * Deliberately narrow: an item with ANY prose of its own is a real item
 * even when it also holds a nested list, and a textless item holding no
 * nested list is a genuinely empty bullet the reader can see.
 */
function isEmptyParentItem(item: PMNode): boolean {
  if (item.childCount < 2) {
    return false;
  }
  if (item.child(0).textContent !== "") {
    return false;
  }
  let sawNestedList = false;
  for (let i = 1; i < item.childCount; i += 1) {
    const name = item.child(i).type.name;
    if (name === "bullet_list" || name === "ordered_list") {
      sawNestedList = true;
    } else if (item.child(i).textContent !== "") {
      return false;
    }
  }
  return sawNestedList;
}

function flattenList(listNode: PMNode, level: number, out: CanonicalListItem[]): void {
  const listKind = listNode.type.name === "ordered_list" ? "ordered" : "bullet";
  listNode.forEach((item) => {
    const checkedAttr = item.attrs.checked;
    if (isEmptyParentItem(item)) {
      // The wrapper contributes no ITEM, but it still contributes its
      // level: a lone `alpha` indented once reads at level 1, the same
      // depth UpNote's `<ul><ul><li>alpha` puts it at. Only the row is
      // elided, never the nesting it exists to carry.
      for (let i = 1; i < item.childCount; i += 1) {
        const child = item.child(i);
        if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
          flattenList(child, level + 1, out);
        }
      }
      return;
    }
    out.push({
      listKind,
      level,
      checked: checkedAttr === null || checkedAttr === undefined ? null : Boolean(checkedAttr),
      prose: itemProse(item),
    });
    // content[0] is the required leading paragraph; anything after it is
    // `block*` — a nested list recurses one level deeper, in place, right
    // after the item it belongs to (so the flattened array's own order
    // already reads correctly with no further bookkeeping).
    for (let i = 1; i < item.childCount; i += 1) {
      const child = item.child(i);
      if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
        flattenList(child, level + 1, out);
      }
    }
  });
}

/**
 * Converts a live `entrySchema` document (`entryMarkdownToDocument`'s own
 * return type, or a document a mounted `EditorView` is holding) into
 * canonical form. Consecutive `paragraph` siblings — the only way this
 * schema ever puts two lines of prose next to each other without a list
 * between them — are merged into ONE `CanonicalBlock` of kind `"prose"`,
 * with a `"block"` break recorded at each paragraph boundary and a
 * `"soft"` break recorded at each internal `\n` — the exact distinction
 * ADR 0066 turns on.
 */
export function entryDocumentToCanonical(doc: PMNode): CanonicalDocument {
  const blocks: CanonicalBlock[] = [];
  let proseBuilder: ProseBuilder | null = null;

  const flushProse = () => {
    if (proseBuilder !== null) {
      blocks.push({ kind: "prose", prose: proseBuilder.build() });
      proseBuilder = null;
    }
  };

  doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      if (proseBuilder === null) {
        proseBuilder = new ProseBuilder();
      } else {
        proseBuilder.breakLine("block");
      }
      appendParagraphInline(proseBuilder, node);
      return;
    }
    flushProse();
    if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
      const items: CanonicalListItem[] = [];
      flattenList(node, 0, items);
      blocks.push({ kind: "list", items });
    }
  });
  flushProse();

  return { blocks };
}

/**
 * Convenience composition of `entryMarkdownToDocument` (`entry-document.ts`)
 * with `entryDocumentToCanonical` above — the adapter for a stored Entry
 * body, as opposed to a live document a mounted editor already holds.
 */
export function entryMarkdownToCanonical(body: string): CanonicalDocument {
  return entryDocumentToCanonical(entryMarkdownToDocument(body));
}

// ---------------------------------------------------------------------------
// UpNote's stored HTML -> canonical
//
// A small, dependency-free HTML-fragment reader, not a general HTML5
// parser: this module has to run both under vitest (jsdom's global
// `DOMParser` would be available there) and under a plain Node process
// driving Playwright (no DOM global exists at all), so it cannot depend on
// one being present. UpNote's own stored HTML (verified directly against
// its shipped app, `upnote-editor-behaviour.md`) never needs HTML5's error
// -recovery machinery to read correctly: every open tag this fixture set
// ever sees is properly closed, including the deliberately-invalid sibling
// `<ul>` nesting — that's "semantically surprising," not "an unbalanced
// tag," and a plain balanced-tag reader handles it exactly as written.
// ---------------------------------------------------------------------------

interface HtmlElement {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly HtmlNode[];
}
interface HtmlText {
  readonly kind: "text";
  readonly value: string;
}
type HtmlNode = HtmlElement | HtmlText;

const VOID_TAGS = new Set(["br"]);
const TAG_OPEN_RE = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z0-9_-]+(?:="[^"]*")?)*)\s*\/?>/;
const TAG_CLOSE_RE = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/;
const ATTR_RE = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const name = match[1];
    if (name !== undefined) {
      attrs[name] = match[2] ?? "";
    }
  }
  return attrs;
}

/** Parses a fragment of UpNote's stored HTML into a small tree, with no dependency on a DOM global. */
function parseHtmlFragment(html: string): readonly HtmlNode[] {
  let pos = 0;

  function parseNodes(): HtmlNode[] {
    const nodes: HtmlNode[] = [];
    while (pos < html.length) {
      if (html[pos] === "<") {
        if (html[pos + 1] === "/") {
          // A closing tag belongs to whichever open call is above us on the
          // stack — stop here and let that call consume it.
          return nodes;
        }
        const openMatch = TAG_OPEN_RE.exec(html.slice(pos));
        if (openMatch === null) {
          // Not a real tag (a stray '<'); treat it as a literal character
          // rather than looping forever.
          nodes.push({ kind: "text", value: "<" });
          pos += 1;
          continue;
        }
        const [full, rawTag, rawAttrs] = openMatch;
        const tag = (rawTag ?? "").toLowerCase();
        const attrs = parseAttrs(rawAttrs ?? "");
        pos += full.length;
        if (VOID_TAGS.has(tag) || full.trimEnd().endsWith("/>")) {
          nodes.push({ kind: "element", tag, attrs, children: [] });
          continue;
        }
        const children = parseNodes();
        const closeMatch = TAG_CLOSE_RE.exec(html.slice(pos));
        if (closeMatch !== null && (closeMatch[1] ?? "").toLowerCase() === tag) {
          pos += closeMatch[0].length;
        }
        nodes.push({ kind: "element", tag, attrs, children });
      } else {
        const next = html.indexOf("<", pos);
        const end = next === -1 ? html.length : next;
        const raw = html.slice(pos, end);
        pos = end;
        if (raw.length > 0) {
          nodes.push({ kind: "text", value: decodeHtmlEntities(raw) });
        }
      }
    }
    return nodes;
  }

  return parseNodes();
}

const MARK_TAGS: Readonly<Record<string, CanonicalMarkKind>> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  code: "code",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
};

/**
 * Appends one `<div>`'s (or a bare root run's) own inline content onto
 * `builder`, expanding `<br>` into a soft break — EXCEPT the very last
 * `<br>` in a list of nodes with nothing after it, which is filler, not a
 * break. A `<div>` (or an `<li>`) can never be empty in real contenteditable
 * HTML, so both UpNote's own empty note (`upnote-editor-behaviour.md`:
 * "empty note | `<br>`") and, per this session's own gap sweep, an
 * otherwise-empty middle block (`<div>alpha</div><div><br></div><div>bravo</div>`
 * for "alpha, Enter, Enter, bravo") use the exact same lone `<br>` to mean
 * "this block has nothing in it" — the emptiness there is already carried
 * by the block boundary itself (a `"block"` break either side of it), so
 * counting the filler `<br>` as ANOTHER, independent soft break would
 * double it. A `<br>` that has real content after it in the SAME node list
 * (`alpha<br>bravo`) is a genuine break and is still counted as one.
 */
function appendHtmlInline(
  builder: ProseBuilder,
  nodes: readonly HtmlNode[],
  marks: readonly CanonicalMarkKind[],
): void {
  nodes.forEach((node, index) => {
    if (node.kind === "text") {
      pushTextWithSoftBreaks(builder, node.value, marks);
      return;
    }
    if (node.tag === "br") {
      if (index < nodes.length - 1) {
        builder.breakLine("soft");
      }
      return;
    }
    const markKind = MARK_TAGS[node.tag];
    if (markKind !== undefined) {
      appendHtmlInline(builder, node.children, [...marks, markKind]);
      return;
    }
    // Anything else UpNote's own inline content could carry (a link, a
    // colour span) has no counterpart in this dialect at all — read as
    // plain inline content, marks aside, rather than dropped silently.
    appendHtmlInline(builder, node.children, marks);
  });
}

function htmlItemProse(li: HtmlElement): CanonicalProse {
  const builder = new ProseBuilder();
  // A nested `<ul>`/`<ol>` that (incorrectly, relative to UpNote's own
  // verified sibling-nesting model) ended up INSIDE an `<li>` is handled by
  // the caller below, not here — this only reads the item's own text.
  const ownInline = li.children.filter(
    (child) => !(child.kind === "element" && (child.tag === "ul" || child.tag === "ol")),
  );
  appendHtmlInline(builder, ownInline, []);
  return builder.build();
}

/**
 * Flattens a `<ul>`/`<ol>` element's children into `out`. UpNote nests a
 * sub-list as a SIBLING of the `<li>` it follows
 * (`upnote-editor-behaviour.md`), so — unlike `flattenList` above — the
 * recursion here is driven by walking this element's own children in
 * order, not by looking inside one `<li>`: an `<li>` child is an item at
 * `level`, and a `<ul>`/`<ol>` child recurses at `level + 1`, landing right
 * after the item it belongs to purely because it comes right after it in
 * the source.
 */
function flattenHtmlList(list: HtmlElement, level: number, out: CanonicalListItem[]): void {
  const listKind = list.tag === "ol" ? "ordered" : "bullet";
  for (const child of list.children) {
    if (child.kind !== "element") {
      continue;
    }
    if (child.tag === "li") {
      const checkedAttr = child.attrs["data-checked"];
      out.push({
        listKind,
        level,
        checked: checkedAttr === undefined ? null : checkedAttr === "true",
        prose: htmlItemProse(child),
      });
      // Defensive: if a nested list were ever found INSIDE the `<li>`
      // instead of beside it, still read it rather than silently drop it.
      for (const inner of child.children) {
        if (inner.kind === "element" && (inner.tag === "ul" || inner.tag === "ol")) {
          flattenHtmlList(inner, level + 1, out);
        }
      }
    } else if (child.tag === "ul" || child.tag === "ol") {
      flattenHtmlList(child, level + 1, out);
    }
  }
}

/**
 * Converts UpNote's own stored HTML (the `html` column read directly from
 * `upnote.sqlite3`, per `upnote-editor-behaviour.md`'s own verification
 * method) into the same canonical form `entryDocumentToCanonical` produces.
 * A bare `<br>` (UpNote's own empty-note shape) and the bare inline content
 * UpNote leaves unwrapped "at the root until a second block exists" both
 * read as an ordinary top-level prose run — the same normalization applied
 * to consecutive `paragraph` siblings on the other adapter.
 */
export function upnoteHtmlToCanonical(html: string): CanonicalDocument {
  const nodes = parseHtmlFragment(html);
  const blocks: CanonicalBlock[] = [];
  let proseBuilder: ProseBuilder | null = null;
  // Bare (not-yet-wrapped-in-a-`<div>`) top-level nodes — "note the first
  // block is left as bare inline content at the root until a second block
  // exists" (`upnote-editor-behaviour.md`) — accumulate here and are handed
  // to `appendHtmlInline` as ONE group, never one node at a time: its own
  // "is this the LAST node" lookahead (for a lone trailing `<br>` being
  // filler, not a break) only sees what's in the array it's given, so a
  // bare `alpha<br>bravo` has to reach it as the three-node array it really
  // is, not three separate one-node calls that each look like "last node."
  let bareRun: HtmlNode[] = [];

  const flushBareRun = () => {
    if (bareRun.length === 0) {
      return;
    }
    if (proseBuilder === null) {
      proseBuilder = new ProseBuilder();
    }
    appendHtmlInline(proseBuilder, bareRun, []);
    bareRun = [];
  };
  const flushProse = () => {
    flushBareRun();
    if (proseBuilder !== null) {
      blocks.push({ kind: "prose", prose: proseBuilder.build() });
      proseBuilder = null;
    }
  };

  for (const node of nodes) {
    if (node.kind === "element" && (node.tag === "ul" || node.tag === "ol")) {
      flushProse();
      const items: CanonicalListItem[] = [];
      flattenHtmlList(node, 0, items);
      blocks.push({ kind: "list", items });
      continue;
    }
    if (node.kind === "element" && node.tag === "div") {
      flushBareRun();
      if (proseBuilder === null) {
        proseBuilder = new ProseBuilder();
      } else {
        proseBuilder.breakLine("block");
      }
      appendHtmlInline(proseBuilder, node.children, []);
      continue;
    }
    bareRun.push(node);
  }
  flushProse();

  return { blocks };
}

/**
 * Rebuilds canonical form from the JSON a live `EditorView`'s own document
 * hands back (`Node.toJSON()`). Playwright can only cross the page/Node.js
 * boundary with plain JSON, never a real `prosemirror-model` class
 * instance — this is the bridge `apps/e2e/tests/composer-parity.spec.ts`
 * uses to run the SAME `entryDocumentToCanonical` this module already
 * exports against a document a real, live `EditorView` produced, rather
 * than inventing a third, DOM-shaped adapter for it.
 */
export function canonicalDocumentFromJSON(
  schema: { nodeFromJSON(json: unknown): PMNode },
  json: unknown,
): CanonicalDocument {
  return entryDocumentToCanonical(schema.nodeFromJSON(json));
}
