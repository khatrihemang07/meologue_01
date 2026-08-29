/**
 * Parses an Entry's body — and the Server's prose — into inline nodes for
 * rendering (ADR 0041).
 *
 * Inline only, and structurally so. `@lezer/markdown`'s `parseInline` never
 * invokes the block layer at all: `# heading` and `- item` produce no nodes
 * and reach the reader as the characters the user typed. That is not a
 * deny-list we maintain, it is a layer the parser never enters — which
 * matters because two shipped decisions depend on a body being exactly one
 * line box. The Entry bubble puts its clock in a right float that can only
 * land on a line box it shares (ADR 0036), and the Digest card derives a line
 * count by dividing scrollHeight by lineHeight (ADR 0036, proportional-clamp).
 * A block element silently breaks both, and the first of those "passed every
 * test and was wrong on screen".
 *
 * No HTML is produced anywhere in this file or its renderer — we emit React
 * nodes, and the parser has no HTML layer left after the removals below. That
 * is what makes a sanitizer unnecessary rather than merely omitted.
 */
import { parser as commonmark, type Element, type InlineParser } from "@lezer/markdown";

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

/** Marks that punctuate a construct rather than carrying any of its text. */
const PUNCTUATION = new Set(["EmphasisMark", "CodeMark", "LinkMark"]);

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
