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

/**
 * Issue #239/ADR 0069's blank-line encoding: a deliberately blank line —
 * the middle of the three paragraphs `doc(p("alpha"), p(""), p("bravo"))`
 * the Composer's own `splitBlock` produces for `alpha` Enter Enter `bravo`
 * (ADR 0069's own Consequences names this exact gap as left open) — is
 * stored as a paragraph whose entire text content is this one U+00A0
 * NO-BREAK SPACE character, and nothing else.
 *
 * Not an ordinary space: a run of bare `\n` with nothing between two of
 * them already collapses to a single block break on read
 * (`pushProseRuns`/`collectBlocks`, inline-markdown.ts — CommonMark's own
 * blank-line rule, which treats a line of only spaces/tabs as blank the
 * same as a truly empty one) — that collapse is exactly the ADR 0069
 * mechanism this ticket's bug report is about, and it is also why an
 * ordinary space cannot be the marker: a line holding only one would
 * still read back as "no line at all" rather than as a deliberate,
 * distinct paragraph. U+00A0 is not whitespace to CommonMark's blank-line
 * rule (spec: "no characters, or only spaces or tabs" — U+00A0 is neither),
 * so a line holding only it survives as genuine paragraph content, the way
 * `pushProseRuns`'s own comment already describes real indentation
 * surviving. This was verified empirically against this exact reader
 * before any code here changed: `"alpha\n\n \n\nbravo"` already
 * round-trips byte-identical today, and already parses to three `"prose"`
 * blocks, not two — the reader and writer already tolerate this shape:
 * what was missing is `entryDocumentToMarkdown` ever choosing to WRITE it
 * for a genuinely empty paragraph, and `blocksToPM` ever choosing to READ
 * it back as one, rather than as one character of literal text.
 */
const BLANK_LINE_MARKER = "\u00A0";

/**
 * True exactly when a `"prose"` `EntryBlockNode`'s own `children` are the
 * blank-line marker above and *only* the marker — one bare `"text"` leaf,
 * un-nested in any `emphasis`/`strong`/`strikethrough` ancestor (this
 * writer never wraps the marker in a mark, so a marked run of the same
 * character, however unlikely, is left as literal text rather than
 * mistaken for the marker) and carrying no other character beside it.
 * `blocksToPM` (below) is this predicate's only caller, and its own
 * comment has the rest of the reasoning.
 */
function isBlankLineMarker(children: readonly InlineNode[]): boolean {
  const only = children.length === 1 ? children[0] : undefined;
  return only !== undefined && only.kind === "text" && only.text === BLANK_LINE_MARKER;
}

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
      case "strikethrough":
        out.push(
          ...inlineNodesToPM(
            node.children,
            [...marks, entrySchema.mark("strikethrough")],
            taskChecked,
          ),
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
 * builds either. A `"prose"` run becomes exactly one `paragraph` —
 * `collectBlocks` (`inline-markdown.ts`) already splits a source body at
 * every block break (a bare `\n`, ADR 0069) into one `"prose"` `EntryBlockNode`
 * per resulting run, so this function's own job is a straight 1:1 mapping,
 * never a merge or a further split of its own — except for the one case
 * `isBlankLineMarker` exists to catch (issue #239): a `"prose"` run whose
 * own text is nothing but the blank-line marker becomes a genuinely EMPTY
 * `paragraph`, not one holding a stray U+00A0 a person could put a caret
 * after and wonder what it is. This is the reader half of the encoding —
 * `entryDocumentToMarkdown`'s `writeBlocks` (below) is the writer half that
 * produces the marker in the first place, only for an empty paragraph that
 * actually needs one to survive being written down at all (that function's
 * own comment has the reasoning for when that is).
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
          isBlankLineMarker(block.children)
            ? entrySchema.node("paragraph")
            : entrySchema.node("paragraph", null, inlineNodesToPM(block.children, [], taskChecked)),
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
 * Issue #245: the one mandatory separator character between a checkbox's
 * `[ ]`/`[x]` and whatever follows it (`inline-markdown.ts`'s own comment on
 * `referencedTaskOf`, and `itemContentStart`'s identical reasoning for the
 * `- ` bullet marker) is syntax, not typed content — but `collectBlocks`/
 * `pushProseRuns` (inline-markdown.ts) has no clean place to drop it while
 * parsing, because two consumers of ITS output, `EntryBlockNode`, deliberately
 * rely on the separator surviving there: `referencedTaskOf` (inline-markdown.ts)
 * and `isReferencedChecklistItem` (composer-commands.ts) each strip it by
 * hand before checking what remains. So the drop happens one step later, at
 * this exact seam — converting a checklist item's own first prose run into
 * ProseMirror nodes — which is the only place both requirements can hold at
 * once: the parsed tree keeps the separator, the document does not.
 *
 * Only ONE leading character is ever removed, mirroring `itemContentStart`'s
 * own "exactly one mandatory separator, not however much whitespace happens
 * to be there" rule — a person who typed `- [ ]  two spaces` still has their
 * second space as real content. If stripping that one character empties the
 * leading text node entirely, the node itself is dropped (an empty text node
 * is invalid in ProseMirror — see `inlineNodesToPM`'s own guard) rather than
 * left behind as a zero-length leaf.
 *
 * `writeListItem` (this file's doc-to-markdown half) writes this separator
 * back UNCONDITIONALLY for every task item now (its own `needsTaskSeparator`
 * comment has the full reasoning) — always as a plain space, regardless of
 * which single character this function actually stripped. For the ordinary
 * case (the stripped character already was a space) that is a true, silent,
 * byte-identical round trip. For the one character this function treats as
 * equally mandatory-separator syntax — a TAB, which `itemContentStart`
 * (inline-markdown.ts) already accepts as the `- ` bullet marker's own
 * separator and which `entryParser`'s `TaskList` extension accepts here the
 * same way — the round trip normalizes it to a space instead of restoring
 * the tab byte-for-byte. That is not a new gap this function opens: a plain
 * bullet's own tab separator is already normalized to a space today, on
 * unmodified `main`, by `markerFor`'s unconditional literal `"- "` — this
 * function's caller just makes the checkbox case consistent with that
 * existing, accepted behavior rather than inventing a second, different
 * rule for it. Verified directly: `entryMarkdownToDocument("-\talpha")`
 * already round-trips to `"- alpha"` today, tab and all, with none of this
 * ticket's code involved at all.
 */
function withoutTaskSeparator(blocks: readonly EntryBlockNode[]): readonly EntryBlockNode[] {
  const first = blocks[0];
  if (first === undefined || first.kind !== "prose") {
    return blocks;
  }
  const firstChild = first.children[0];
  if (firstChild === undefined || firstChild.kind !== "text") {
    return blocks;
  }
  const char = firstChild.text[0];
  if (char !== " " && char !== "\t") {
    return blocks;
  }
  const rest = firstChild.text.slice(1);
  const children =
    rest === ""
      ? first.children.slice(1)
      : [{ ...firstChild, text: rest }, ...first.children.slice(1)];
  return [{ ...first, children }, ...blocks.slice(1)];
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
  const itemContent = item.task !== undefined ? withoutTaskSeparator(item.content) : item.content;
  const content = blocksToPM(itemContent, item.task?.checked ?? false);
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
 * leaf, used only when `localMarkRank` (below) cannot order two co-occurring
 * marks by their measured span — either because the spans tie exactly, or
 * because (only reachable from a document built by hand, never from
 * `entryMarkdownToDocument`) neither mark's span contains the other's.
 * `code` sits apart from the rest — it is written as a wrap around whatever
 * `strong`/`em`/`strikethrough` are already open (see `writeCodeSpan`), not
 * through this generic diffing at all — so its rank here only matters for
 * sorting it consistently relative to them on the rare path that reaches
 * `openableMarks` with it still present (it never does in practice; see
 * that function).
 */
const DEFAULT_MARK_RANK: Record<string, number> = { strong: 0, em: 1, strikethrough: 2, code: 3 };

/**
 * The nesting order for every non-`code` mark actually present in this one
 * paragraph, *for this paragraph specifically* — computed from where each
 * mark occurs among the paragraph's leaves, not a fixed choice for the
 * whole file. A `Node`'s marks are an unordered *set*, so nothing on a leaf
 * itself says which of several co-occurring marks was outermost in the
 * source; the paragraph's leaf sequence as a whole still does, though,
 * since `inlineNodesToPM` only ever produces these sets by flattening a
 * genuinely nested `InlineNode` tree — meaning whichever mark spans a
 * *wider* run of leaves always properly contains the others', never merely
 * overlaps them.
 *
 * This used to be a single hard-coded choice between exactly two marks
 * (`strong`/`em`), returning one of two fixed `Record`s. That stopped being
 * enough the moment a third nestable mark (`strikethrough`, issue #211)
 * existed: `openableMarks`' `rank[name] ?? 99` fallback pinned whichever
 * mark this function didn't know how to rank all the way to the innermost
 * position, unconditionally — so `~~struck **bold** back~~` (strikethrough
 * wrapping strong) would rank `strikethrough` after `strong` regardless of
 * which one actually nested outside the other in the source, the exact
 * failure the property test below caught once already for
 * `*italic **and** bold*` under the old two-mark version of this same bug.
 *
 * The general fix: collect every non-`code` mark's `[min, max]` leaf-index
 * span, then sort by `min` ascending (a mark that starts earlier is never
 * inside one that starts later, for a properly nested tree), breaking ties
 * by `max` descending (when two marks start together, the one extending
 * further is the outer one), and only then by `DEFAULT_MARK_RANK` — which
 * only ever matters for marks whose spans are identical, since two spans
 * that tie on `min` are only reachable this way. The result is assigned
 * ranks `0..n-1` in that order, so `openableMarks` never needs its `?? 99`
 * fallback for any mark this function has actually seen. This is not
 * specific to two marks in any way, and works identically for three,
 * four, or however many nestable marks this dialect ever grows.
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

  const ordered = [...spans.entries()].sort(([nameA, a], [nameB, b]) => {
    if (a.min !== b.min) {
      return a.min - b.min;
    }
    if (a.max !== b.max) {
      return b.max - a.max;
    }
    return (DEFAULT_MARK_RANK[nameA] ?? 99) - (DEFAULT_MARK_RANK[nameB] ?? 99);
  });

  const rank: Record<string, number> = {};
  ordered.forEach(([name], i) => {
    rank[name] = i;
  });
  return rank;
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
    case "strikethrough":
      return "~~";
    default:
      // Any mark not named here — deliberately including an underline mark
      // this schema will never define (entry-schema.ts's own comment on why
      // underline is refused) — drops silently rather than erroring. That
      // silence is exactly why underline can't be added as a mark at all:
      // there is no Markdown spelling for it, so it would apply in the
      // Composer and vanish the moment it round-trips through here, with
      // nothing anywhere to say so.
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
 * Six things get escaped:
 *
 * - `\n` itself (ADR 0069/issue #234) — a literal newline character embedded
 *   in one text leaf's own content is, after this ticket, always exactly one
 *   thing: a **soft break** (`insertSoftBreak`, composer-commands.ts, or the
 *   identical bare `\n` `walkEntryInline`'s own `"HardBreak"` case pushes
 *   when reading one back, inline-markdown.ts). It is never a block
 *   separator any more — a block break is now always two sibling `paragraph`
 *   nodes, never characters sitting inside one text run (`collectBlocks`,
 *   inline-markdown.ts, splits on every bare `\n` rather than merging across
 *   one) — so escaping it unconditionally to `\` immediately followed by a
 *   real `\n` (GFM's own backslash hard break, which `entryParser`'s
 *   `HardBreak` inline parser recognises on the next read) is what makes a
 *   soft break round-trip as itself rather than silently reading back as a
 *   lazy continuation or, worse, a second stored paragraph the writer would
 *   need `\n\n` to separate. This is the one escape whose replacement is
 *   *longer* than the source character, not merely backslash-prefixed with
 *   the same character repeated — see this function's own loop for why that
 *   still keeps `lineStart` tracking correct.
 * - `\` itself, so a literal backslash never reads back as the start of an
 *   escape sequence.
 * - `*`, unconditionally — it is `entryParser`'s only emphasis/strong
 *   delimiter once escaped this way, since this serializer never emits the
 *   `_`-delimited form, so there is exactly one character to guard.
 * - `` ` ``, unconditionally — the inline-code delimiter.
 * - `~`, unconditionally (issue #211) — GFM Strikethrough's only delimiter,
 *   the same one-character-to-guard reasoning as `*` above (this serializer
 *   never emits a single-`~` form either). Unconditional is the only option
 *   that actually works here, not merely the simplest one: `@lezer/
 *   markdown`'s `Strikethrough` parser explicitly refuses a delimiter run
 *   of three (`if (next != 126 || cx.char(pos+1) != 126 || cx.char(pos+2)
 *   == 126) return -1` — inline-markdown.ts's own comment on why both
 *   `.configure()` calls need this extension has the full node names). A
 *   struck run whose own text happens to end in `~` — `~~a~~~~` — would put
 *   three tildes in a row right where the closing delimiter needs to be;
 *   the parser refuses that as a closer, and the whole span would silently
 *   revert to literal text on the next parse, the same "recognition may
 *   exceed emission, so emission has to be conservative" shape ADR 0045
 *   already documents for `*`. Escaping every `~` in the source text (never
 *   the delimiters this function itself writes — those come from
 *   `markOpen`, through `w.write`, which is never escaped) means a struck
 *   run's own text can never produce three consecutive tildes in the first
 *   place, so the ambiguous case cannot arise rather than needing to be
 *   detected.
 * - `[` immediately followed by another `[` — `referenceParser` only ever
 *   fires on two consecutive open brackets (`inline-markdown.ts`'s own
 *   `parse`), so a lone `[` is never ambiguous and only the first of a pair
 *   needs the backslash.
 *
 * A seventh case is conditional on position: a `-`/`+` or a digit run
 * followed by `.`/`)` — CommonMark's bullet and ordered list markers — only
 * mean list structure at the *start of a line*, so only those are escaped,
 * and only there. This is reachable even though a prose run's own text
 * never begins a line (`atLineStart` only ever seeds `true` at the very
 * start of a container — `writeBlocks`, below — never mid-run): a soft
 * break's own escaped `\` + `\n` (the first bullet above) starts a fresh
 * line immediately after it, inside the SAME text run, so `bravo` typed
 * right after a soft break in `alpha\nbravo` still needs this check if it
 * happens to read like a marker — `lineStart` is what `\n`'s own escape
 * branch, just above, sets back to `true` for exactly that reason.
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
    if (ch === "\n") {
      // ADR 0069/issue #234's soft break — escape to GFM's own backslash
      // hard break (`\` immediately followed by the real `\n`) rather than
      // writing the bare character through. `lineStart` still becomes
      // `true`, exactly as an unescaped `\n` would have left it: visually,
      // and for every check above this one, the next character IS at the
      // start of a new line, regardless of the extra `\` that now precedes
      // the newline itself.
      result += "\\\n";
      lineStart = true;
      i += 1;
      continue;
    }
    if (ch === "\\" || ch === "*" || ch === "`" || ch === "~") {
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
    lineStart = false;
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
  // The one case an empty `paragraph` here is NOT a deliberate blank line
  // (issue #239/ADR 0069): a brand-new or never-edited Entry is a single
  // empty paragraph with nothing else in its container at all
  // (`entryMarkdownToDocument`'s own empty-body contract) — writing nothing
  // for that one keeps `roundTrip("")` at `""`, exactly as before this
  // ticket. Every OTHER empty paragraph reaching this function has at
  // least one sibling — either another entry in `blocks` itself, or
  // (`continuesLine`) the list item's own leading paragraph `writeListItem`
  // already wrote before calling this for the rest of that item's content —
  // so writing nothing for it would silently delete it: two sibling
  // `paragraph`s split by a bare `\n\n` (this branch's own comment below)
  // read back as ONE block boundary, not two, the instant it has nothing
  // of its own between the two separators to survive on. See
  // `BLANK_LINE_MARKER`'s own comment for the marker and why it, not an
  // ordinary space, is what closes that gap.
  const isSoleBlock = blocks.length === 1 && !continuesLine;
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
      // The separator used to be conditional on the paragraph's own
      // `textContent` not already starting with `\n` — before ADR
      // 0069/issue #234, a PARSED document's paragraph could carry a
      // leading blank line inside its own merged text (`collectBlocks` used
      // to fold consecutive paragraph siblings into one run, gap included),
      // while a LIVE-EDITED one never did (`splitBlock`'s new paragraph
      // starts bare). That asymmetry is gone: `collectBlocks` now splits at
      // every block break instead of merging across one, so a freshly
      // parsed paragraph's own text never carries a leading separator
      // either — every embedded `\n` a paragraph's text can still contain
      // is a SOFT break (`insertSoftBreak`, or a `HardBreak` read back by
      // `walkEntryInline`), which `writeInline`/`writeText` below escapes to
      // `\` + `\n` unconditionally, never a bare character `startsWith`
      // could mistake for an already-written separator. The separator
      // between two sibling paragraphs is therefore unconditional now: two
      // real ProseMirror siblings always need one, whichever path produced
      // them.
      //
      // No `${indent}` in that separator, unlike the list branch just
      // below — a paragraph sibling never needs one written explicitly,
      // because its OWN text already supplies whatever leading whitespace
      // belongs there. At the top level `indent` is always `""` anyway
      // (`entryDocumentToMarkdown` only ever calls this with `""`), so this
      // never mattered there; inside a `list_item`'s own continuation
      // content (`writeListItem`'s `writeBlocks(rest, childIndent, w,
      // true)`), it matters a great deal — `collectBlocks`'s `pushProseRuns`
      // (inline-markdown.ts) recovers a continuation paragraph's own
      // leading indentation as literal characters in its text (the same
      // "anchor on `cursor`, not the node's own `.from`" mechanism that
      // recovers indentation after a blank line anywhere else), so that
      // indentation is already exactly `childIndent`'s own width. Adding
      // `${indent}` here on top of it would double it — and keep doubling
      // it every further round trip, since the next parse recovers
      // whatever this function just wrote as the block's own new leading
      // text. This was caught by `entry-document.test.ts`'s own stability
      // check, not reasoned out ahead of time.
      if (needsSeparator) {
        w.write("\n\n");
      }
      if (block.childCount === 0 && !isSoleBlock) {
        // A genuinely empty paragraph with at least one sibling — the
        // Composer's own shape for `alpha` Enter Enter `bravo`
        // (issue #239). Writing nothing here is exactly the bug this
        // ticket exists to fix: two bare `\n\n` separators around nothing
        // read back as a single block boundary, not two, and the blank
        // line the user asked for is gone the moment the Entry reloads.
        w.write(BLANK_LINE_MARKER);
      } else {
        writeInline(block, w);
      }
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
  // first, rather than straight into `w`, so the separator decision below can
  // be made before any of it reaches `w`. That decision used to *peek* at
  // this text; issue #245 made it unconditional and the peek is gone (see
  // `needsTaskSeparator` below for the invariant that changed), but the
  // separate `Writer` stays: `atLineStart` has to be seeded `false` for this
  // paragraph regardless of `w`'s own state, because its text never starts a
  // fresh line — it continues right after the marker `w` just wrote.
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
  // (verified directly against `parseEntryMarkdown`).
  //
  // Issue #245 inverted the invariant this used to rest on. Before that fix,
  // a genuine task's own leading paragraph always already started with the
  // separator — `inline-markdown.ts` never stripped it out of an item's
  // captured content — so this used to *peek* at `firstText` and add a
  // space only when one was truly missing (an empty item, or a document
  // built directly rather than through `entryMarkdownToDocument`). Now the
  // opposite holds: NO document ever carries that separator as real content
  // — `withoutTaskSeparator` (above) strips it at parse time,
  // `promote-tasks.ts`'s live Promotion never wrote one in the first place,
  // and typing `- [ ] ` into the Composer doesn't either. `firstText`
  // starting with whitespace is therefore never "the separator, already
  // there" anymore; it can only be a SPACE the person genuinely typed as
  // their own second character (`- [ ]  two spaces`, `withoutTaskSeparator`'s
  // own comment on why only one leading character is ever stripped). Peeking
  // at it and skipping the write would silently swallow that character on
  // the very first save — found independently, against unmodified `main`'s
  // `- [ ]  alpha` round trip, which stays byte-identical there precisely
  // because main strips nothing at all.
  //
  // So the write is unconditional for any task item: always exactly one
  // space, never zero, never peeking at what follows. That is what keeps
  // the round trip byte-identical for both an ordinary item (nothing to
  // restore but the one mandatory separator) and one whose own second
  // character genuinely is a space (which survives untouched, since this
  // only ever writes the FIRST character back).
  const needsTaskSeparator = checked !== null;
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
 * the single empty paragraph `entryMarkdownToDocument` inserts for an empty
 * body writes back out to `""` — `writeBlocks`'s own `isSoleBlock` case
 * (issue #239) leaves that one paragraph alone precisely so this stays
 * true; any OTHER empty paragraph, one with at least one sibling, writes
 * the blank-line marker instead (`BLANK_LINE_MARKER`'s own comment has the
 * encoding).
 */
export function entryDocumentToMarkdown(doc: PMNode): string {
  const w = new Writer();
  writeBlocks(doc.children, "", w);
  return w.toString();
}
