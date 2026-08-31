/**
 * Parses prose into nodes for rendering. Two parsers live here, on one
 * shared dialect — the mark set (bold, italic, inline code, `[[…]]`
 * References, backslash escapes) and `referenceParser` that recognises the
 * marks are defined exactly once and configured onto both.
 *
 * `parseInlineMarkdown` (ADR 0041) is inline only, and structurally so.
 * `@lezer/markdown`'s `parseInline` never invokes the block layer at all:
 * `# heading` and `- item` produce no nodes and reach the reader as the
 * characters the user typed. That is not a deny-list we maintain, it is a
 * layer the parser never enters — which matters because the Digest card
 * derives a line count by dividing scrollHeight by lineHeight (ADR 0036,
 * proportional-clamp), arithmetic that a block element silently breaks. This
 * is the parser behind `inlineProse` (inline-prose.tsx), which every prose
 * surface except an Entry's own still renders through — the Digest reader,
 * the clamped Digest card, Reflect's Question and both Answer surfaces.
 *
 * `parseEntryMarkdown` (issue #152) reverses that refusal for one construct:
 * lists. An Entry may now carry a bullet list, an ordered list, and a
 * task-list checkbox — everything else that used to be flat inline text
 * stays flat inline text, one prose run per stretch of it. This is safe to
 * do here because it is *not* the parser behind the Digest clamp — only
 * `entryProse` (entry-prose.tsx) calls it, and that split was issue #148's
 * whole point. Headings, blockquotes, fenced code, indented code, and
 * thematic breaks are removed from the block layer the same way Link,
 * Image, HTMLTag and Entity are removed from the inline one: the parser
 * that recognises them no longer exists, so their characters fall through
 * to an ordinary paragraph rather than being filtered out of one. `remove`
 * is what makes that true for both layers — a construct with no parser
 * cannot be reintroduced by a later edit to a deny-list, because there is
 * no deny-list, only an absent parser.
 *
 * No HTML is produced anywhere in this file or its renderers — we emit
 * React nodes, and neither parser has an HTML layer left after the removals
 * below. That is what makes a sanitizer unnecessary rather than merely
 * omitted.
 */
import type { SyntaxNode } from "@lezer/common";
import { parser as commonmark, type Element, type InlineParser, TaskList } from "@lezer/markdown";

/**
 * What a Reference points at. A Reference is a mark in the body rather than a
 * field on an Entry (ADR 0042), so an Entry's shape is unchanged and
 * PROTOCOL_VERSION stays where it is.
 */
export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; children: InlineNode[] }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "code"; text: string }
  /** `[[YYYY-MM-DD]]` — `date` is the day it names, `raw` the text as typed. */
  | { kind: "dateReference"; date: string; raw: string }
  /** `[[e:<id>]]` — `entryId` is the Entry it points at, `raw` the text as typed. */
  | { kind: "entryReference"; entryId: string; raw: string };

const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENTRY_SHAPE =
  /^e:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * A calendar date, not merely something date-shaped. `[[2026-13-45]]` matches
 * the shape and is not a day, so it is not a Reference and renders as the
 * characters the user typed — the same rule as a day with no Entries, or an
 * Entry that was removed.
 */
export function parseReferenceDate(text: string): string | null {
  const match = DATE_SHAPE.exec(text);
  if (match === null) {
    return null;
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const real =
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
  return real ? text : null;
}

/**
 * A well-formed `e:<uuid>`, not merely something that starts with `e:`.
 * `[[e:notauuid]]` fails this the same way `[[2026-13-45]]` fails
 * `parseReferenceDate` — not a real Reference, so it renders as the
 * characters the user typed. `referenceParser` below and
 * `composer-editor.ts`'s hand-typed-Reference input rule both check the
 * shape through this one function rather than each keeping its own copy of
 * `ENTRY_SHAPE`, so a Reference cannot come to mean one thing when read and
 * another when composed (ADR 0043's "one dialect").
 */
export function parseReferenceEntryId(text: string): string | null {
  const match = ENTRY_SHAPE.exec(text);
  return match?.[1] ?? null;
}

/**
 * `[[…]]`, ours rather than CommonMark's.
 *
 * Installed after Escape so `\[[2026-08-28]]` escapes as the user expects, and
 * it never has to outrun CommonMark's link parser because that parser is
 * removed below — `[label](url)` is deliberately not in the mark set (ADR
 * 0041), and removing Link is what stops it eating `[[` before we see it.
 *
 * A mark whose contents are neither a real date nor an Entry id is not
 * recognised at all. Returning -1 leaves the characters as text, which is
 * exactly the "an unresolvable Reference is plain text" rule, obtained here
 * for free rather than by a second check downstream.
 */
const referenceParser: InlineParser = {
  name: "Reference",
  after: "Escape",
  parse(cx, next, pos) {
    if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) {
      return -1;
    }
    let scan = pos + 2;
    while (
      scan < cx.end - 1 &&
      !(cx.char(scan) === CLOSE_BRACKET && cx.char(scan + 1) === CLOSE_BRACKET)
    ) {
      scan += 1;
    }
    if (scan >= cx.end - 1) {
      return -1;
    }
    const inner = cx.slice(pos + 2, scan);
    const name =
      parseReferenceDate(inner) !== null
        ? "DateReference"
        : ENTRY_SHAPE.test(inner)
          ? "EntryReference"
          : null;
    if (name === null) {
      return -1;
    }
    return cx.addElement(cx.elt(name, pos, scan + 2));
  },
};

/**
 * The dialect. `remove` is doing real work here, not tidying:
 *
 * - **Link, Image** — `[label](url)` is out of the mark set, and Link would
 *   otherwise consume `[[` before our own parser ever sees the second bracket.
 * - **HTMLTag, Entity** — raw HTML is off (ADR 0041). Removing the parsers
 *   means there is no node to mishandle, rather than a node we remember not to
 *   render.
 * - **HardBreak** — every prose surface already sets `whitespace-pre-wrap`, so
 *   a newline is a newline without a mark for it.
 *
 * Autolink is not in the default dialect, so a bare URL stays text with no
 * removal needed — also deliberate (ADR 0041).
 */
const inlineParser = commonmark.configure({
  defineNodes: ["DateReference", "EntryReference"],
  parseInline: [referenceParser],
  remove: ["Link", "Image", "HTMLTag", "Entity", "HardBreak"],
});

const nodeNames = inlineParser.nodeSet.types.map((type) => type.name);

/**
 * Marks that punctuate a construct rather than carrying any of its text.
 * `TaskMarker` (a `- [ ]`/`- [x]` checkbox's own three characters) is only
 * ever produced by `entryParser`, never by `inlineParser` — harmless to
 * list here for both walkers, since `walk` (below) can never actually see
 * one.
 */
const PUNCTUATION = new Set(["EmphasisMark", "CodeMark", "LinkMark", "TaskMarker"]);

interface RawElement extends Element {
  readonly children?: readonly RawElement[];
}

function nodeName(element: Element): string {
  return nodeNames[element.type] ?? "";
}

function pushText(into: InlineNode[], text: string) {
  if (text === "") {
    return;
  }
  const last = into.at(-1);
  // Coalesce, so a gap split by punctuation marks still reads as one text run
  // to the highlighter — which matches within a text node, and would otherwise
  // miss a phrase merely because the parser happened to divide it.
  if (last !== undefined && last.kind === "text") {
    last.text += text;
    return;
  }
  into.push({ kind: "text", text });
}

/**
 * `parseInline` returns a *sparse* list — plain text produces no element at
 * all — so the walker fills the gaps between elements from the source. Every
 * character of `body` therefore reaches the output exactly once, which is what
 * makes an unrecognised construct render as itself instead of vanishing.
 */
function walk(
  elements: readonly RawElement[],
  body: string,
  from: number,
  to: number,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = from;

  for (const element of elements) {
    const name = nodeName(element);
    if (element.from > cursor) {
      pushText(nodes, body.slice(cursor, element.from));
    }
    if (PUNCTUATION.has(name)) {
      cursor = Math.max(cursor, element.to);
      continue;
    }
    const children = element.children ?? [];

    switch (name) {
      case "Emphasis":
        nodes.push({ kind: "emphasis", children: walk(children, body, element.from, element.to) });
        break;
      case "StrongEmphasis":
        nodes.push({ kind: "strong", children: walk(children, body, element.from, element.to) });
        break;
      case "InlineCode": {
        // The text between the two CodeMarks. Nothing inside is parsed, which
        // is why a mark inside inline code renders literally.
        const first = children.at(0);
        const last = children.at(-1);
        const start =
          first !== undefined && nodeName(first) === "CodeMark" ? first.to : element.from;
        const end = last !== undefined && nodeName(last) === "CodeMark" ? last.from : element.to;
        nodes.push({ kind: "code", text: body.slice(start, end) });
        break;
      }
      case "Escape":
        // The element spans `\x`; only the escaped character survives.
        pushText(nodes, body.slice(element.from + 1, element.to));
        break;
      case "DateReference": {
        const raw = body.slice(element.from, element.to);
        nodes.push({ kind: "dateReference", date: raw.slice(2, -2), raw });
        break;
      }
      case "EntryReference": {
        const raw = body.slice(element.from, element.to);
        nodes.push({ kind: "entryReference", entryId: raw.slice(4, -2), raw });
        break;
      }
      default:
        // Anything we do not model reaches the reader as what was typed.
        pushText(nodes, body.slice(element.from, element.to));
        break;
    }
    cursor = Math.max(cursor, element.to);
  }

  if (cursor < to) {
    pushText(nodes, body.slice(cursor, to));
  }
  return nodes;
}

/**
 * Parses one string of prose. Always returns nodes covering the whole input —
 * an empty string gives an empty list, and nothing else can lose text.
 */
export function parseInlineMarkdown(body: string): InlineNode[] {
  if (body === "") {
    return [];
  }
  const elements = inlineParser.parseInline(body, 0) as readonly RawElement[];
  return walk(elements, body, 0, body.length);
}

/** The text a set of nodes renders, ignoring formatting. Used by tests and by Export-adjacent callers. */
export function inlineNodesToText(nodes: readonly InlineNode[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "code":
        text += node.text;
        break;
      case "emphasis":
      case "strong":
        text += inlineNodesToText(node.children);
        break;
      case "dateReference":
      case "entryReference":
        text += node.raw;
        break;
    }
  }
  return text;
}

/**
 * An Entry's block structure (issue #152) — a bullet list, an ordered list,
 * or a run of the same inline prose `parseInlineMarkdown` already produces.
 * Everything that is not a list is one `"prose"` run: consecutive lines of
 * plain text, including whatever used to be a heading, a blockquote, a
 * fenced or indented code block, or a thematic break before its block
 * parser was removed below, since all of those now fall through to
 * ordinary paragraph text. Merging them into one run rather than one block
 * per original paragraph is deliberate — an Entry's non-list text has never
 * had paragraph spacing, and this ticket does not give it any; only a list
 * earns a block boundary.
 */
export type EntryBlockNode =
  | { kind: "prose"; children: InlineNode[] }
  | { kind: "bulletList"; items: readonly EntryListItem[] }
  | { kind: "orderedList"; start: number; items: readonly EntryListItem[] };

/**
 * `task` is present exactly when the item opened with `- [ ]`/`- [x]`, and
 * carries the source offsets of that marker rather than just its checked
 * state. Issue #153 needs `markerFrom`/`markerTo` to splice `[ ]` to `[x]`
 * (or back) directly in the body, without re-parsing to find it — designing
 * that in now is cheaper than adding it once #153 needs it.
 */
export interface EntryTaskMarker {
  readonly checked: boolean;
  readonly markerFrom: number;
  readonly markerTo: number;
}

export interface EntryListItem {
  readonly task?: EntryTaskMarker;
  readonly content: readonly EntryBlockNode[];
}

/**
 * The full-document configuration `parseEntryMarkdown` parses with. Built
 * on the same `commonmark` parser and the same `referenceParser`/mark set as
 * `inlineParser` above — the dialect is one definition, reused rather than
 * copied — but through `.parse()` (a real block-and-inline tree) instead of
 * `.parseInline()` (a flat inline-only list), because a list is a block
 * construct and `parseInline` never builds one.
 *
 * `remove` does the same job here that it does for `inlineParser`, extended
 * to the block layer: `ATXHeading`, `SetextHeading`, `Blockquote`,
 * `FencedCode`, `IndentedCode`, `HorizontalRule` and `HTMLBlock` are the
 * parsers that would otherwise recognise a heading, a blockquote, a fenced
 * or indented code block, and a thematic break — removing the parser is
 * what makes each of those degrade into ordinary paragraph text rather than
 * structure, the same "no layer to suppress" property ADR 0041 relies on
 * for the inline side. `LinkReference` is removed alongside `Link` for the
 * same reason `Link` already is: `[label]: url` is not in the mark set
 * either, and leaving its block-level parser in would give reference-style
 * links a way back in through the one door `Link`'s own removal doesn't
 * cover.
 *
 * `IndentedCode` is the one of these that bites: without it, four spaces of
 * leading indentation on an otherwise ordinary line is not a special case
 * to filter, it is simply no longer enough to start any block parser, so
 * the line becomes paragraph text like any other — and paragraph text
 * keeps everything expected of it, including those four leading spaces.
 * The walk below relies on exactly that: it never special-cases removed
 * constructs, because there is nothing left running that would produce a
 * node for them to special-case.
 *
 * `TaskList` (from `@lezer/markdown`) adds the one piece of GFM syntax in
 * the mark set: `- [ ]`/`- [x]` inside a list item. It only ever fires
 * inside a `ListItem` (its own `leaf` hook checks `cx.parentType()`), so a
 * bare `[ ] not a list` elsewhere in an Entry is never mistaken for one.
 */
const entryParser = commonmark.configure([
  {
    defineNodes: ["DateReference", "EntryReference"],
    parseInline: [referenceParser],
    remove: [
      "Link",
      "Image",
      "HTMLTag",
      "Entity",
      "HardBreak",
      "ATXHeading",
      "SetextHeading",
      "Blockquote",
      "FencedCode",
      "IndentedCode",
      "HorizontalRule",
      "HTMLBlock",
      "LinkReference",
    ],
  },
  TaskList,
]);

/** Every direct child of a `SyntaxNode`, in document order. */
function childNodes(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

/**
 * `walk`'s counterpart for the block parser's tree. Same contract — every
 * character of `[from, to)` reaches the output exactly once, either as a
 * modelled node or as plain text filling the gap before it — and the same
 * mark set, but sourced from `SyntaxNode`s (`.type.name`, `.firstChild`)
 * rather than `parseInline`'s flat `Element[]` (`.type` as an index into a
 * separate name table), which is the one thing the two parser APIs don't
 * share. Kept as its own function rather than unified with `walk` so that
 * function — and the well-exercised behaviour of `parseInlineMarkdown` it
 * backs — stays exactly as it was before this ticket.
 */
function walkEntryInline(
  nodes: readonly SyntaxNode[],
  body: string,
  from: number,
  to: number,
): InlineNode[] {
  const result: InlineNode[] = [];
  let cursor = from;

  for (const node of nodes) {
    const name = node.type.name;
    if (node.from > cursor) {
      pushText(result, body.slice(cursor, node.from));
    }
    if (PUNCTUATION.has(name)) {
      cursor = Math.max(cursor, node.to);
      continue;
    }
    const children = childNodes(node);

    switch (name) {
      case "Emphasis":
        result.push({
          kind: "emphasis",
          children: walkEntryInline(children, body, node.from, node.to),
        });
        break;
      case "StrongEmphasis":
        result.push({
          kind: "strong",
          children: walkEntryInline(children, body, node.from, node.to),
        });
        break;
      case "InlineCode": {
        const first = children.at(0);
        const last = children.at(-1);
        const start = first !== undefined && first.type.name === "CodeMark" ? first.to : node.from;
        const end = last !== undefined && last.type.name === "CodeMark" ? last.from : node.to;
        result.push({ kind: "code", text: body.slice(start, end) });
        break;
      }
      case "Escape":
        pushText(result, body.slice(node.from + 1, node.to));
        break;
      case "DateReference": {
        const raw = body.slice(node.from, node.to);
        result.push({ kind: "dateReference", date: raw.slice(2, -2), raw });
        break;
      }
      case "EntryReference": {
        const raw = body.slice(node.from, node.to);
        result.push({ kind: "entryReference", entryId: raw.slice(4, -2), raw });
        break;
      }
      default:
        pushText(result, body.slice(node.from, node.to));
        break;
    }
    cursor = Math.max(cursor, node.to);
  }

  if (cursor < to) {
    pushText(result, body.slice(cursor, to));
  }
  return result;
}

/**
 * The task metadata for a `ListItem` whose first content node is a `Task`
 * (i.e. the item opened `- [ ]`/`- [x]`) — `undefined` for a plain item.
 * `TaskMarker` is `Task`'s own first child, always exactly the three
 * characters `[ ]`/`[x]`/`[X]`, which is what `markerFrom`/`markerTo`
 * below hand issue #153.
 */
function taskMarkerOf(task: SyntaxNode, body: string): EntryTaskMarker | undefined {
  const marker = task.firstChild;
  if (marker === null || marker.type.name !== "TaskMarker") {
    return undefined;
  }
  const checked = body[marker.from + 1] === "x" || body[marker.from + 1] === "X";
  return { checked, markerFrom: marker.from, markerTo: marker.to };
}

/**
 * Where a container's own content genuinely starts — `0` for `Document`,
 * or a `ListItem`'s own `ListMark` plus exactly one mandatory separator
 * character after it (a space or a tab; CommonMark requires at least one).
 *
 * This is deliberately *not* `child.from` of the container's first content
 * node. A `Paragraph` (and a `Task`, which is paragraph-shaped) reports a
 * `.from` that already skips whatever leading whitespace preceded its own
 * first line — ordinarily just the mandatory separator, but with
 * `IndentedCode` removed (see `entryParser`'s own comment on why that
 * "bites"), *any* amount of extra leading whitespace on that first line
 * gets swallowed the same way, silently: `"-     five extra spaces"` reports
 * a `Paragraph.from` that skips all five, not just the one CommonMark
 * actually requires. Anchoring on the marker instead, and skipping only the
 * one separator character that's unambiguously syntax rather than content,
 * is what keeps that data intact — the four "extra" spaces above end up as
 * ordinary leading text, verbatim, exactly as typed.
 */
function itemContentStart(item: SyntaxNode, body: string): number {
  const mark = childNodes(item).find((c) => c.type.name === "ListMark");
  if (mark === undefined) {
    return item.from;
  }
  const nextChar = body[mark.to];
  return nextChar === " " || nextChar === "\t" ? mark.to + 1 : mark.to;
}

/**
 * Turns one container's direct children — `Document`'s, or a `ListItem`'s —
 * into `EntryBlockNode`s, starting from `containerStart` (see
 * `itemContentStart`'s own comment for why that has to be a container-level
 * position rather than anything read off an individual child node). A
 * container's children are always some mix of `Paragraph`/`Task` (content)
 * and `BulletList`/`OrderedList` (nested structure), plus a leading
 * `ListMark` when the container is itself a list item; that marker is
 * structural and never reaches the output as text.
 *
 * Consecutive `Paragraph`/`Task` siblings are merged into one `"prose"` run
 * rather than one per node: `walkEntryInline` is handed their combined
 * inline children (a `Task`'s own `TaskMarker` child included — it is
 * excluded from the *rendered* text by being in `PUNCTUATION`, the same
 * mechanism that already hides `EmphasisMark`/`CodeMark`, not by being cut
 * from this list) and the full span from `containerStart` (or wherever the
 * previous list in this same container ended) to the last node's end, so
 * whatever sits between the merged nodes — a blank line, a second line of
 * the same paragraph, the gap before a checkbox marker — is filled in as
 * ordinary text the same way any other gap is. `cursor` only ever moves
 * forward when a list is flushed; it is never reset to a content node's own
 * `.from`, which is the property that keeps this lossless.
 */
function collectBlocks(
  children: readonly SyntaxNode[],
  body: string,
  containerStart: number,
): EntryBlockNode[] {
  const blocks: EntryBlockNode[] = [];
  let cursor = containerStart;
  let proseTo = cursor;
  let hasProse = false;
  let proseSources: SyntaxNode[] = [];

  const flushProse = () => {
    if (hasProse) {
      const nodes = walkEntryInline(proseSources, body, cursor, proseTo);
      if (nodes.length > 0) {
        blocks.push({ kind: "prose", children: nodes });
      }
    }
    hasProse = false;
    proseSources = [];
  };

  for (const child of children) {
    const name = child.type.name;
    if (name === "ListMark") {
      continue;
    }
    if (name === "BulletList" || name === "OrderedList") {
      flushProse();
      blocks.push(listToBlock(child, body));
      cursor = child.to;
      continue;
    }
    // The two remaining content types after the removals above: Paragraph,
    // and Task (a paragraph-shaped leaf that also carries a TaskMarker).
    hasProse = true;
    proseTo = child.to;
    proseSources.push(...childNodes(child));
  }
  flushProse();
  return blocks;
}

/** The leading run of digits off a `ListMark`, for an `OrderedList`'s start number — `"1."` and `"1)"` both give `1`. */
function orderedListStart(firstItem: SyntaxNode | undefined, body: string): number {
  const mark =
    firstItem !== undefined
      ? childNodes(firstItem).find((c) => c.type.name === "ListMark")
      : undefined;
  const digits = mark !== undefined ? /^\d+/.exec(body.slice(mark.from, mark.to)) : null;
  return digits !== null ? Number(digits[0]) : 1;
}

function listToBlock(list: SyntaxNode, body: string): EntryBlockNode {
  const itemNodes = childNodes(list).filter((c) => c.type.name === "ListItem");
  const items = itemNodes.map((item): EntryListItem => {
    const itemChildren = childNodes(item);
    const firstContent = itemChildren.find((c) => c.type.name !== "ListMark");
    const task =
      firstContent !== undefined && firstContent.type.name === "Task"
        ? taskMarkerOf(firstContent, body)
        : undefined;
    return { task, content: collectBlocks(itemChildren, body, itemContentStart(item, body)) };
  });
  return list.type.name === "OrderedList"
    ? { kind: "orderedList", start: orderedListStart(itemNodes.at(0), body), items }
    : { kind: "bulletList", items };
}

/**
 * Parses an Entry's body into block nodes (issue #152) — the entry point
 * `entryProse` (entry-prose.tsx) renders, and the only caller of
 * `entryParser` above. Same empty-body contract as `parseInlineMarkdown`.
 */
export function parseEntryMarkdown(body: string): EntryBlockNode[] {
  if (body === "") {
    return [];
  }
  const tree = entryParser.parse(body);
  return collectBlocks(childNodes(tree.topNode), body, 0);
}

/**
 * The text a set of block nodes renders, ignoring both inline formatting
 * and list structure — no bullet, number, or checkbox marker, and no
 * indentation, just the words, each item's own text space-joined against
 * its siblings. Used by `entrySnippet` (entry-row.tsx) for a History row's
 * preview and the `[[` picker's suggestions, neither of which has room to
 * reproduce a list's own shape and both of which would otherwise leak a
 * raw `- `/`1. ` into what is supposed to read as flattened prose.
 */
export function entryBlocksToText(blocks: readonly EntryBlockNode[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "prose") {
      parts.push(inlineNodesToText(block.children));
    } else {
      for (const item of block.items) {
        parts.push(entryBlocksToText(item.content));
      }
    }
  }
  return parts.join(" ");
}
