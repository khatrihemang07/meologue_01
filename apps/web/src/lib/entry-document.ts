/**
 * The two conversions issue #155's Composer needs before it can hold a
 * ProseMirror document instead of a string: an Entry's stored body into a
 * document (`entryMarkdownToDocument`), and a document back into a body
 * (`entryDocumentToMarkdown`). Both are plain functions — no editor, no
 * DOM, nothing from `prosemirror-view` — because a round-trip bug is far
 * cheaper to catch here, against a table of inputs, than through a
 * `contenteditable` a person has to type into.
 *
 * `prosemirror-markdown` was deliberately not added as a dependency for
 * this (see the ticket this file implements, issue #154, and ADR 0043).
 * That package exists mainly to provide the *parser* half — a
 * `markdown-it`-backed reader that turns Markdown into a `ProseMirror`
 * document — and this repo already has that reader for one dialect,
 * `parseEntryMarkdown` (`inline-markdown.ts`, issue #152). Adding
 * `prosemirror-markdown` would mean two parsers for the same `[[…]]`
 * Reference syntax, maintained separately, free to drift apart — exactly
 * what `inline-markdown.ts`'s own module comment calls out as the reason a
 * Reference is defined once. `markdown-it` alone is measured at ~48 KB gzip
 * of the ~61 KB `prosemirror-markdown` pulls in; the 9 packages this ticket
 * does add come to about 68.6 KB gzip total, so skipping it is not a
 * rounding error. The serializer half — turning a document back into
 * Markdown — is comparatively small, and is what this file hand-writes
 * below.
 *
 * Both functions read/write plain strings and `Node`s from `entrySchema`
 * (`entry-schema.ts`) — no dependency on anything issue #155 owns.
 */
import type { Mark, Node as PMNode } from "prosemirror-model";
import { entrySchema } from "./entry-schema";
import type { EntryBlockNode, EntryListItem, InlineNode } from "./inline-markdown";
import { formatTaskReference, parseEntryMarkdown } from "./inline-markdown";

// ---------------------------------------------------------------------------
// markdown -> document
// ---------------------------------------------------------------------------

/**
 * `InlineNode`'s "text"/"code"/dateReference"/"entryReference" leaves,
 * flattened into `Node`s with `marks` already resolved from whatever
 * `emphasis`/`strong` ancestors wrapped them in the source tree —
 * `parseEntryMarkdown`'s tree carries mark nesting as node *nesting*
 * (`strong` containing `emphasis` containing `text`), and a `Node`'s marks
 * are a *set* on a leaf instead, so this is where that shape is flattened.
 *
 * `taskChecked` (issue #173) is not derived from anything in `nodes` — a
 * `taskReference` InlineNode carries no checked state of its own, only
 * `taskId`/`label` (inline-markdown.ts's own comment on why the mark's
 * *text* never encodes it: the checkbox marker already does, and this is
 * the one caller that reads that marker). `blocksToPM` threads the
 * enclosing item's own `EntryTaskMarker.checked` down to here so a
 * `task_reference` node's `checked` attr — a cache, never consulted by
 * `entryDocumentToMarkdown`'s own write side — starts out agreeing with
 * the marker it sits beside, for a reader that wants the state without
 * walking back up to the parent `list_item`.
 */
function inlineNodesToPM(
  nodes: readonly InlineNode[],
  marks: readonly Mark[],
  taskChecked: boolean,
): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        // Empty text nodes are invalid in ProseMirror (`Schema.text` throws),
        // and can legitimately occur here — `pushText` upstream never
        // produces one, but nothing stops a zero-length slice reaching this
        // function directly in a future caller, so this stays a real guard
        // rather than an assumption.
        if (node.text !== "") {
          out.push(entrySchema.text(node.text, marks));
        }
        break;
      case "code":
        if (node.text !== "") {
          out.push(entrySchema.text(node.text, [...marks, entrySchema.mark("code")]));
        }
        break;
      case "emphasis":
        out.push(
          ...inlineNodesToPM(node.children, [...marks, entrySchema.mark("em")], taskChecked),
        );
        break;
      case "strong":
        out.push(
          ...inlineNodesToPM(node.children, [...marks, entrySchema.mark("strong")], taskChecked),
        );
        break;
      case "dateReference":
        out.push(
          entrySchema.node(
            "reference",
            { kind: "date", raw: node.raw, date: node.date, entryId: null },
            undefined,
            marks,
          ),
        );
        break;
      case "entryReference":
        out.push(
          entrySchema.node(
            "reference",
            { kind: "entry", raw: node.raw, date: null, entryId: node.entryId },
            undefined,
            marks,
          ),
        );
        break;
      case "taskReference":
        out.push(
          entrySchema.node(
            "task_reference",
            { taskId: node.taskId, label: node.label, checked: taskChecked },
            undefined,
            marks,
          ),
        );
        break;
    }
  }
  return out;
}

/**
 * An `EntryBlockNode`'s content sits directly under `doc` or under a
 * `list_item`; both accept the same `"block+"`-ish shape, so one function
 * builds either. A `"prose"` run becomes one `paragraph` — `entryParser`
 * already merges consecutive lines of plain text into a single run (see
 * `inline-markdown.ts`'s `collectBlocks`), so there is exactly one
 * `paragraph` per run here too, never one per source line.
 *
 * `taskChecked` defaults `false` for `entryMarkdownToDocument`'s own
 * top-level call, where there is no enclosing item at all — a
 * `taskReference` mark sitting in plain prose (the dialect permits it;
 * ADR 0048 assumes it never happens in practice, since Promotion only ever
 * writes one inside a checkbox item) needs *some* value for `checked`, and
 * `false` is no less arbitrary than any other choice for a case the app
 * never actually produces. `itemToPM` (below) overrides it with the
 * enclosing item's own marker for every other call.
 */
function blocksToPM(blocks: readonly EntryBlockNode[], taskChecked = false): PMNode[] {
  const out: PMNode[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "prose":
        out.push(
          entrySchema.node("paragraph", null, inlineNodesToPM(block.children, [], taskChecked)),
        );
        break;
      case "bulletList":
        out.push(entrySchema.node("bullet_list", null, block.items.map(itemToPM)));
        break;
      case "orderedList":
        out.push(
          entrySchema.node("ordered_list", { order: block.start }, block.items.map(itemToPM)),
        );
        break;
    }
  }
  return out;
}

/**
 * `list_item`'s content expression is `"paragraph block*"` — it always
 * needs a leading paragraph, even an empty one — because
 * `prosemirror-schema-list`'s own commands assume that shape (see
 * `entry-schema.ts`'s comment on `bullet_list`). `EntryListItem.content`
 * has no such requirement: an empty item (`- ` with nothing typed) or one
 * whose first block is itself a nested list (`- - nested`, a bullet item
 * whose line has no text of its own before the sub-list starts) both
 * produce content that does not start with a `"prose"` block, or does not
 * exist at all. `withLeadingParagraph` below closes that gap by inserting an
 * empty `paragraph` only when one is actually missing — a normalization this
 * ticket accepts because `writeInline` (`entry-document.ts`'s own
 * doc-to-markdown half) writes nothing at all for a genuinely empty
 * paragraph, so nothing about it is visible in the text that comes back out.
 */
function itemToPM(item: EntryListItem): PMNode {
  // The item's own checkbox marker, if it has one — passed down so any
  // `taskReference` mark inside this item's own leading content (not a
  // nested item's; `blocksToPM`'s "bulletList"/"orderedList" branch calls
  // `itemToPM` fresh for each of those, which recomputes this from ITS OWN
  // `item.task`) starts its `checked` cache agreeing with the marker
  // beside it.
  const content = blocksToPM(item.content, item.task?.checked ?? false);
  const needsLeadingParagraph = content.length === 0 || content[0]?.type.name !== "paragraph";
  const withLeadingParagraph = needsLeadingParagraph
    ? [entrySchema.node("paragraph"), ...content]
    : content;
  const checked = item.task !== undefined ? item.task.checked : null;
  return entrySchema.node("list_item", { checked }, withLeadingParagraph);
}

/**
 * Stored text into a document. Built directly on `parseEntryMarkdown`
 * (`inline-markdown.ts`, issue #152) — the same parser `entryProse`
 * (`entry-prose.tsx`) reads an Entry's body with — so a Reference, a list,
 * or a checkbox cannot come to mean one thing when read and another when
 * the Composer opens it for editing.
 *
 * `doc`'s content expression is `"block+"`: it can never be truly empty,
 * because ProseMirror's own editing model needs somewhere for the cursor to
 * land even in a brand-new Entry. An empty body (or one that is only
 * whitespace, which `parseEntryMarkdown` also reports as no blocks at all)
 * becomes a document holding a single empty paragraph — `entryDocumentToMarkdown`
 * of that document is `""` again, so this does not by itself put a body
 * through any visible change.
 */
export function entryMarkdownToDocument(body: string): PMNode {
  const blocks = blocksToPM(parseEntryMarkdown(body));
  const content = blocks.length > 0 ? blocks : [entrySchema.node("paragraph")];
  return entrySchema.node("doc", null, content);
}

// ---------------------------------------------------------------------------
// document -> markdown
// ---------------------------------------------------------------------------

/**
 * Fallback rank for the marks that can be simultaneously active on one
 * leaf, used only when `localMarkRank` (below) cannot tell which of two
 * co-occurring marks should nest outside the other. `code` sits apart from
 * the other two — it is written as a wrap around whatever `strong`/`em` are
 * already open (see `writeCodeSpan`), not through this generic diffing at
 * all — so its rank here only matters for sorting it consistently relative
 * to them on the rare path that reaches `openableMarks` with it still
 * present (it never does in practice; see that function).
 */
const DEFAULT_MARK_RANK: Record<string, number> = { strong: 0, em: 1, code: 2 };

/**
 * Which of `strong`/`em` nests outside the other, *for this one paragraph*
 * — computed from where each mark actually occurs among the paragraph's
 * leaves, not a single fixed choice for the whole file. A `Node`'s marks
 * are an unordered *set*, so nothing on a leaf itself says whether `strong`
 * or `em` was the outer one in the source; the paragraph's leaf sequence as
 * a whole still does, though, since `inlineNodesToPM` only ever produces
 * these sets by flattening a genuinely nested `InlineNode` tree — meaning
 * whichever of the two marks spans a *wider* run of leaves always properly
 * contains the other's, never merely overlaps it.
 *
 * This is not a cosmetic choice: get it backwards and `writeInline`'s
 * diffing is forced to close the wider-spanning mark and reopen it moments
 * later just to let the narrower one drop out from "inside" it — and that
 * reopened delimiter lands directly against whatever the narrower mark is
 * doing at the same boundary, with no character between them, which is
 * exactly the run-length ambiguity CommonMark's delimiter tokenizer
 * resolves in ways this file does not control (`*italic **and** bold*`,
 * with a fixed `strong`-always-outer rank, serializes to a string that
 * reparses into a different tree — caught by the property test below, not
 * reasoned out ahead of time). Ranking by measured span keeps whichever
 * mark is actually outer in the common prefix `writeInline` never has to
 * touch, so this situation cannot arise for any leaf sequence a properly
 * nested tree can produce. Two marks that neither contains the other (only
 * reachable from a document built by hand rather than through
 * `entryMarkdownToDocument`, since that is precisely what "properly
 * nested" rules out) fall back to `DEFAULT_MARK_RANK`.
 */
function localMarkRank(content: PMNode): Record<string, number> {
  const spans = new Map<string, { min: number; max: number }>();
  let index = 0;
  content.forEach((leaf) => {
    for (const mark of leaf.marks) {
      if (mark.type.name === "code") {
        continue;
      }
      const span = spans.get(mark.type.name);
      if (span === undefined) {
        spans.set(mark.type.name, { min: index, max: index });
      } else {
        span.max = index;
      }
    }
    index += 1;
  });

  const strong = spans.get("strong");
  const em = spans.get("em");
  if (strong !== undefined && em !== undefined) {
    const strongContainsEm = strong.min <= em.min && strong.max >= em.max;
    const emContainsStrong = em.min <= strong.min && em.max >= strong.max;
    if (emContainsStrong && !strongContainsEm) {
      return { strong: 1, em: 0, code: 2 };
    }
  }
  return DEFAULT_MARK_RANK;
}

/** Marks in this paragraph's canonical (rank) order, `code` excluded — see `localMarkRank`'s comment. */
function openableMarks(marks: readonly Mark[], rank: Record<string, number>): Mark[] {
  return marks
    .filter((mark) => mark.type.name !== "code")
    .sort((a, b) => (rank[a.type.name] ?? 99) - (rank[b.type.name] ?? 99));
}

function markOpen(mark: Mark): string {
  switch (mark.type.name) {
    case "strong":
      return "**";
    case "em":
      return "*";
    default:
      return "";
  }
}

/**
 * Accumulates the serialized text for one call to `entryDocumentToMarkdown`,
 * tracking the one piece of state escaping needs beyond the current
 * character: whether the next character written would land at the start of
 * a line. That flag is what makes `writeText` line-start-aware rather than
 * a fixed per-character table (see its own comment for why line start
 * matters at all).
 *
 * `write` is for output *this file* controls — mark delimiters, list
 * markers, a Reference's `raw` text, indentation, newlines inserted between
 * sibling blocks. None of it is escaped, all of it is trusted, and writing
 * it always updates `atLineStart` from whether the string ends in `\n`.
 * `writeText` is the only path for characters that came from a `text`
 * node's own content, and the only one that escapes.
 */
class Writer {
  private out = "";
  atLineStart = true;

  write(raw: string): void {
    if (raw === "") {
      return;
    }
    this.out += raw;
    this.atLineStart = raw.endsWith("\n");
  }

  writeText(text: string): void {
    if (text === "") {
      return;
    }
    this.out += escapeUserText(text, this.atLineStart);
    this.atLineStart = text.endsWith("\n");
  }

  toString(): string {
    return this.out;
  }
}

// The lookahead admits a space, a tab, a newline, or the end of the string —
// CommonMark accepts a list marker with nothing else on its line (`- ` and
// bare `-` both produce a valid, empty item; verified directly against
// `parseEntryMarkdown`), so "nothing before the next line" has to count as
// a marker position exactly the way "nothing left in the string" does.
const LINE_START_BULLET = /^[-+](?=[ \t\n]|$)/;
const LINE_START_ORDERED = /^\d+[.)](?=[ \t\n]|$)/;

/**
 * Escapes the characters in one run of user-authored text that
 * `entryParser` (`inline-markdown.ts`) would otherwise read back as a mark
 * or a list marker instead of the literal characters they are — the
 * serializer's half of "escaped markers survive" (ADR 0043's own
 * "block-looking syntax... survives as literal characters" is handled
 * differently: headings, blockquotes, fences and thematic breaks have no
 * parser left to reintroduce them, so nothing here needs to escape `#`,
 * `>`, `` ``` ``, `---`, or leading indentation at all).
 *
 * Four things get escaped:
 *
 * - `\` itself, so a literal backslash never reads back as the start of an
 *   escape sequence.
 * - `*`, unconditionally — it is `entryParser`'s only emphasis/strong
 *   delimiter once escaped this way, since this serializer never emits the
 *   `_`-delimited form, so there is exactly one character to guard.
 * - `` ` ``, unconditionally — the inline-code delimiter.
 * - `[` immediately followed by another `[` — `referenceParser` only ever
 *   fires on two consecutive open brackets (`inline-markdown.ts`'s own
 *   `parse`), so a lone `[` is never ambiguous and only the first of a pair
 *   needs the backslash.
 *
 * A fifth case is conditional on position: a `-`/`+` or a digit run
 * followed by `.`/`)` — CommonMark's bullet and ordered list markers — only
 * mean list structure at the *start of a line*, so only those are escaped,
 * and only there. This is reachable: `parseEntryMarkdown` only ever
 * produces a `"prose"` block whose text starts a line with what reads as a
 * list marker when the source escaped it (`\- text`, `1\. text`) — a
 * genuine, unescaped `- text` at the start of a line becomes a real list at
 * parse time, never prose — so a prose run's own leading `-`/digit-marker
 * is possible only via an escape this function has to reproduce, on every
 * line the run's embedded `\n`s create, not only its first.
 *
 * `atLineStart` seeds this correctly for both places a prose run's text can
 * begin: at the true start of a container (nothing came before it) and
 * immediately after a list block that has none of its own leading
 * whitespace (`writeBlocks`'s own comment covers why a prose run's *own*
 * text already carries whatever blank line preceded it in the first case,
 * but never in the second) — in both cases the run's text starts with the
 * newline itself when one is needed, so this function does not need to know
 * which case it is in, only where the line boundary actually falls once its
 * own scan reaches it.
 */
function escapeUserText(text: string, atLineStart: boolean): string {
  let result = "";
  let lineStart = atLineStart;
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (lineStart) {
      // `*` as a bullet marker is already covered by the unconditional `*`
      // escape a few lines down (it runs the same way regardless of
      // position), so only `-`/`+` need a dedicated line-start check here.
      const bulletMatch = LINE_START_BULLET.exec(rest);
      if (bulletMatch !== null) {
        const marker = bulletMatch[0];
        result += `\\${marker}`;
        i += marker.length;
        lineStart = false;
        continue;
      }
      const orderedMatch = LINE_START_ORDERED.exec(rest);
      if (orderedMatch !== null) {
        const marker = orderedMatch[0];
        const digits = marker.slice(0, -1);
        const punct = marker.slice(-1);
        result += `${digits}\\${punct}`;
        i += marker.length;
        lineStart = false;
        continue;
      }
    }
    const ch = text[i] as string;
    if (ch === "\\" || ch === "*" || ch === "`") {
      result += `\\${ch}`;
      i += 1;
      lineStart = false;
      continue;
    }
    if (ch === "[" && text[i + 1] === "[") {
      result += "\\[";
      i += 1;
      lineStart = false;
      continue;
    }
    result += ch;
    lineStart = ch === "\n";
    i += 1;
  }
  return result;
}

/**
 * An inline code span's content, verbatim — CommonMark never interprets
 * backslash escapes inside one, so `writeText`'s escaping does not apply
 * here at all. What this does instead is choose a backtick fence long
 * enough that the content's own backticks can never be mistaken for the
 * closing delimiter (one longer than the longest run already inside it,
 * CommonMark's own rule for nested backticks), and pads with a single
 * space on each side exactly when the content would otherwise be
 * ambiguous: starting or ending with a backtick (which would visually run
 * into the fence), or starting and ending with a space while not being
 * entirely spaces (which CommonMark strips one layer of on read, so
 * writing it unpadded would lose that exact space on the next parse).
 */
function writeCodeSpan(text: string, w: Writer): void {
  if (text === "") {
    return;
  }
  let longestRun = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longestRun = Math.max(longestRun, run.length);
  }
  const fence = "`".repeat(longestRun + 1);
  const needsPad =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "");
  w.write(fence);
  w.write(needsPad ? " " : "");
  w.write(text);
  w.write(needsPad ? " " : "");
  w.write(fence);
}

function writeReference(node: PMNode, w: Writer): void {
  w.write(String(node.attrs.raw));
}

/**
 * Unlike `writeReference` just above, this does not replay a stored `raw`
 * — `task_reference` has none (`entry-schema.ts`'s own comment on why).
 * The mark's characters are rebuilt fresh from `taskId`/`label` through
 * `formatTaskReference` (inline-markdown.ts, the one function that knows
 * how to escape a label's own `\`/`]` characters) every time this runs, so
 * a `label` a caller has since refreshed from the Task — a rename, ADR
 * 0048's own "a Task's name is no longer something only Todo can change" —
 * serializes correctly with no separate step to keep a cached `raw` in
 * step with it. `checked` plays no part here: the checkbox's own `[ ]`/
 * `[x]` comes from the enclosing `list_item`'s `checked` attr
 * (`writeListItem`), exactly as it does for a bare task — this node's own
 * `checked` is a read-only convenience for a live component, never a
 * second place the marker's own state is written.
 */
function writeTaskReference(node: PMNode, w: Writer): void {
  w.write(formatTaskReference(String(node.attrs.taskId), String(node.attrs.label)));
}

/**
 * Walks one `paragraph`'s (or a Reference's ancestor's) inline content,
 * diffing each leaf's marks against whatever is already open and only
 * closing/opening the difference — not closing everything after every leaf
 * — which is what lets a shared mark span several leaves as one
 * uninterrupted run (`**bold *and* italic**`, not `**bold** ***and***
 * **italic**`). `code` is deliberately excluded from that diffing (see
 * `MARK_RANK`'s comment) and instead wraps each leaf that carries it
 * individually (via `writeCodeSpan`), inside whatever `strong`/`em` this
 * diffing already has open.
 */
function writeInline(content: PMNode, w: Writer): void {
  const rank = localMarkRank(content);
  let active: readonly Mark[] = [];
  content.forEach((leaf) => {
    const target = openableMarks(leaf.marks, rank);
    let common = 0;
    while (
      common < active.length &&
      common < target.length &&
      active[common]?.type.name === target[common]?.type.name
    ) {
      common += 1;
    }
    for (let j = active.length - 1; j >= common; j -= 1) {
      const mark = active[j];
      if (mark !== undefined) {
        w.write(markOpen(mark));
      }
    }
    for (let j = common; j < target.length; j += 1) {
      const mark = target[j];
      if (mark !== undefined) {
        w.write(markOpen(mark));
      }
    }
    active = target;

    if (leaf.type.name === "reference") {
      writeReference(leaf, w);
    } else if (leaf.type.name === "task_reference") {
      writeTaskReference(leaf, w);
    } else if (leaf.marks.some((mark) => mark.type.name === "code")) {
      writeCodeSpan(leaf.text ?? "", w);
    } else {
      w.writeText(leaf.text ?? "");
    }
  });
  for (let j = active.length - 1; j >= 0; j -= 1) {
    const mark = active[j];
    if (mark !== undefined) {
      w.write(markOpen(mark));
    }
  }
}

/**
 * One container's direct block children — `doc`'s, or a `list_item`'s —
 * written in order. `indent` is the exact prefix a *new* line belonging to
 * this container needs (used for a sibling list block, and threaded one
 * marker-width deeper for anything nested inside a list item; see
 * `writeListItem`).
 *
 * A `"prose"`... i.e. `paragraph` block never gets a separator inserted
 * ahead of it by this function, on purpose: `parseEntryMarkdown` only ever
 * puts a `paragraph` right after a preceding block when the gap between
 * them (a blank line, or nothing at all) is *itself* captured as part of
 * that paragraph's own leading text — never trimmed — so writing the
 * paragraph's content verbatim already reproduces whatever separation was
 * there. A list block (`bullet_list`/`ordered_list`) carries no such
 * leading whitespace of its own — `parseEntryMarkdown`'s `listToBlock`
 * builds it straight from the parse tree's `ListItem`s, nothing gap-filled
 * — so this function is the one place a newline gets inserted ahead of it,
 * and only when something already precedes it — either an earlier sibling
 * in `blocks` itself, or (`continuesLine`) a first paragraph `writeListItem`
 * already wrote directly onto the marker's own line before calling this for
 * the rest of that item's content, which `blocks` here never includes.
 *
 * That separator is a single newline in the ordinary case, but a full blank
 * line when the block about to be written is an `ordered_list` whose
 * `order` is not `1` — CommonMark only lets an ordered-list marker
 * *interrupt* an already-open paragraph or list item when it starts at 1
 * (the exception exists so `1986. That was a good year` cannot turn into a
 * list); `5. five` directly after something else, with no blank line,
 * would not be read back as a list at all, it would lazily continue
 * whatever came before it (caught by the property test below). A blank
 * line always starts a block fresh, sidestepping the restriction entirely,
 * and is never *wrong* to use even where a single newline would have
 * worked (verified directly against `parseEntryMarkdown`) — so this is a
 * blanket rule for every non-1-start `ordered_list`, not something threaded
 * through as a special case only where it would otherwise fail.
 */
function writeBlocks(
  blocks: readonly PMNode[],
  indent: string,
  w: Writer,
  continuesLine = false,
): void {
  blocks.forEach((block, i) => {
    const needsSeparator = i > 0 || continuesLine;
    if (block.type.name === "paragraph") {
      // A paragraph sibling needs a BLANK line, never a single newline: a
      // lone `\n` is a lazy continuation, which the parser folds back into
      // whatever block sits above it — two paragraphs come back as one, and
      // a paragraph after a list is swallowed by that list's last item.
      //
      // This branch used to `return` before writing any separator at all,
      // on the reasoning that a `list_item`'s own leading paragraph
      // continues straight after its marker. That paragraph never reaches
      // here — `writeListItem` writes it into its own `Writer` and passes
      // only `rest` — so the early return was skipping the separator for
      // every paragraph that genuinely needed one, and their text was
      // written flush against whatever preceded it. Two lines of prose
      // serialized to "line oneline two", and Enter-ing out of a checklist
      // produced "- [ ] call mumafter": an Entry lost a line break, or
      // fused two, the moment it was Sent. Found by review after the
      // round-trip property test passed straight through it — both passes
      // produce the same glued output, so a fixpoint check cannot see it.
      //
      // The separator is conditional because the two ways a document can
      // come into being disagree about where a blank line lives. Parsing
      // keeps it inside the paragraph's own text — `"- a\n\nb"` comes back
      // as `[bullet_list, paragraph("\n\nb")]`, newlines and all, because
      // an Entry's body has always been one string and the reader renders
      // it `whitespace-pre-wrap`. Live editing does not: ProseMirror's
      // Enter splits the block, so the new paragraph's text is bare. Adding
      // a separator unconditionally therefore doubles the blank line on
      // every parsed document, compounding it on each round trip; adding
      // none at all glues the live-edited ones together. Writing it only
      // when the paragraph does not already begin with a newline is what
      // makes both shapes serialize to the same thing and stay there.
      if (needsSeparator && !block.textContent.startsWith("\n")) {
        w.write(`\n\n${indent}`);
      }
      writeInline(block, w);
      return;
    }
    if (needsSeparator) {
      const needsBlankLine = block.type.name === "ordered_list" && Number(block.attrs.order) !== 1;
      w.write(needsBlankLine ? `\n\n${indent}` : `\n${indent}`);
    }
    writeList(block, indent, w);
  });
}

function markerFor(list: PMNode, index: number): string {
  return list.type.name === "ordered_list" ? `${Number(list.attrs.order) + index}. ` : "- ";
}

function writeListItem(item: PMNode, marker: string, indent: string, w: Writer): void {
  w.write(marker);
  const checked = item.attrs.checked;
  if (checked === true) {
    w.write("[x]");
  } else if (checked === false) {
    w.write("[ ]");
  }

  // `list_item`'s content is always `paragraph block*` (entry-schema.ts), so
  // `first` is always that leading paragraph — written into its own `Writer`
  // first, rather than straight into `w`, because a task's checkbox needs to
  // *peek* at whether that paragraph's own text already starts with the
  // mandatory separator space before deciding whether to add one (see
  // `needsTaskSeparator` below). Its own text never starts a fresh line —
  // it continues right after the marker `w` just wrote — so `atLineStart`
  // is seeded `false` here regardless of `w`'s own state.
  const childIndent = indent + " ".repeat(marker.length);
  const children = item.children;
  const first = children[0];
  const rest = children.slice(1);

  const firstWriter = new Writer();
  firstWriter.atLineStart = false;
  if (first !== undefined) {
    writeInline(first, firstWriter);
  }
  const firstText = firstWriter.toString();

  // A task's checkbox needs at least one space after it to be recognised as
  // a task at all on the next parse — `entryParser`'s `TaskList` extension
  // requires it; a bare `[ ]` with nothing after falls back to plain text
  // (verified directly against `parseEntryMarkdown`). A genuine task's own
  // leading paragraph always already starts with that separator —
  // `inline-markdown.ts` never strips it out of an item's captured content —
  // so this only ever adds a space when one is truly missing (an empty
  // item, or a document built directly rather than through
  // `entryMarkdownToDocument`), never on top of one that's already there.
  // That is what keeps this from compounding an extra space on every
  // repeated round trip.
  const needsTaskSeparator =
    checked !== null && !firstText.startsWith(" ") && !firstText.startsWith("\t");
  w.write(needsTaskSeparator ? " " : "");
  w.write(firstText);

  if (rest.length > 0) {
    writeBlocks(rest, childIndent, w, true);
  }
}

function writeList(list: PMNode, indent: string, w: Writer): void {
  list.forEach((item, _offset, index) => {
    if (index > 0) {
      w.write(`\n${indent}`);
    }
    const marker = markerFor(list, index);
    writeListItem(item, marker, indent, w);
  });
}

/**
 * A document back into stored text. The inverse of `entryMarkdownToDocument`,
 * written by hand rather than through `prosemirror-markdown`'s serializer —
 * see this file's module comment for why that package is not a dependency
 * here at all.
 *
 * `doc`'s own children are handed to `writeBlocks` as the top-level
 * container, with `indent` starting at `""`. A document holding nothing but
 * the single
 * empty paragraph `entryMarkdownToDocument` inserts for an empty body
 * writes back out to `""` — `writeInline` of an empty paragraph writes
 * nothing, and there is nothing else in the document to write.
 */
export function entryDocumentToMarkdown(doc: PMNode): string {
  const w = new Writer();
  writeBlocks(doc.children, "", w);
  return w.toString();
}
