/**
 * The ProseMirror schema for an Entry's body (issue #154, ADR 0043). This is
 * the document shape `entry-document.ts`'s two conversions read and write,
 * and the shape issue #155's Composer will eventually hold directly instead
 * of a string.
 *
 * The mark set here is deliberately a mirror of `inline-markdown.ts`'s
 * dialect, not an independent design: `strong`/`em`/`code` line up with
 * `InlineNode`'s `strong`/`emphasis`/`code`, `bullet_list`/`ordered_list`/
 * `list_item` line up with `EntryBlockNode`'s `bulletList`/`orderedList` and
 * `EntryListItem`, and `list_item`'s `checked` attribute lines up with
 * `EntryTaskMarker`. Headings, blockquotes, code blocks and horizontal rules
 * have no node here at all, for the same reason ADR 0043 gives for removing
 * their parsers from `entryParser`: a node type that was never defined
 * cannot be reintroduced by a later edit, the way a deny-list checked at
 * render time could be.
 *
 * `prosemirror-schema-list`'s `bulletList`/`orderedList`/`listItem` specs
 * are reused as a base (their `toDOM`/`parseDOM` are what issue #155's
 * editor view will need) and extended here with the `content` expression and
 * attributes this schema actually needs — `list_item` gains `checked` rather
 * than getting a second node type for a task, because a task is a checkbox
 * state on an otherwise ordinary item, not a different kind of thing an item
 * can be.
 */
import type { Attrs, MarkSpec, NodeSpec } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { bulletList, listItem, orderedList } from "prosemirror-schema-list";
import { formatTaskReference } from "./inline-markdown";

/**
 * What kind of Reference a `reference` node points at — the node-level
 * counterpart of `InlineNode`'s `"dateReference"`/`"entryReference"` kinds.
 */
export type ReferenceKind = "date" | "entry";

/**
 * A Reference is a node here, not a mark: unlike `strong`/`em`/`code`, it
 * does not wrap a run of editable text, it *replaces* one. Modelling it as
 * an inline atom (ProseMirror's term for a leaf that is edited as a single
 * unit rather than as text with a decoration) means the Composer can never
 * end up with a half-edited `[[2026-08-2` — the editor can only select or
 * delete the whole thing, never type inside it. `raw` is what
 * `entry-document.ts`'s serializer emits verbatim: it is exactly the
 * characters `parseEntryMarkdown` matched (`[[2026-08-28]]` or
 * `[[e:<uuid>]]`), so serializing a Reference back out can never drift from
 * what created it. `date`/`entryId` are carried alongside `raw` — rather
 * than derived from it at serialize time — so a consumer that only cares
 * about which day or Entry is referenced (issue #155's picker, a future
 * link-preview) never has to re-parse `raw` to find out.
 */
const referenceAttrs: { [name: string]: { default?: unknown; validate?: string } } = {
  kind: { validate: "string" },
  raw: { validate: "string" },
  date: { default: null, validate: "string|null" },
  entryId: { default: null, validate: "string|null" },
};

/**
 * `task_reference`'s own attrs (issue #173, ADR 0048) — deliberately not
 * `raw`: unlike `reference` above, whose mark is a link that never itself
 * changes, a task reference's `label` and `checked` are *caches*, rewritten
 * from the Task on every render and Sync. Keeping a frozen `raw` alongside
 * them would be a second copy to keep in step with `label` the moment
 * either changes — exactly the divergence ADR 0048 built this node to rule
 * out — so `entry-document.ts`'s serializer rebuilds the mark's characters
 * from `taskId`/`label` (`formatTaskReference`, inline-markdown.ts) on
 * every write instead of replaying a stored string.
 *
 * `checked` carries `default: false` (issue #177), even though every
 * `task_reference` a real parse produces sits inside a checkbox list item
 * and always has an answer for it (`entry-document.ts`'s `inlineNodesToPM`
 * reads it straight off the enclosing item's own task marker) — a real
 * parse is not the only path that ever builds one of these nodes. ProseMirror
 * itself synthesizes a node from its spec alone in several places
 * (`NodeType.createAndFill`, `ContentMatch.fillBefore`, and anything a
 * paste rule or a schema-level content-repair pass reaches for) and none
 * of those callers have an enclosing task marker to read `checked` off —
 * they call `entrySchema.nodes.task_reference.create()` (or `createAndFill`)
 * with no `checked` in the attrs object at all. Without a `default`,
 * `prosemirror-model`'s own `Node` constructor throws
 * `RangeError: No value supplied for attribute checked` the moment any of
 * those paths reaches this node type — which is exactly the second half of
 * issue #177's crash, distinct from (and a precondition for testing) the
 * missing-`toDOM` one `taskReferenceNodeView`'s own comment
 * (composer-editor.ts) fixes. `taskId`/`label` need no such fallback: a
 * `task_reference` with an empty id or label is merely a Task nobody can
 * resolve, ADR 0042's own "unresolved is plain text" case Composer already
 * has to render either way, so there is nothing for a missing value to
 * corrupt the way a missing `boolean` would (ProseMirror validates a
 * declared type strictly; `false` is a value, `undefined` is not).
 */
const taskReferenceAttrs: { [name: string]: { default?: unknown; validate?: string } } = {
  taskId: { validate: "string" },
  label: { validate: "string" },
  checked: { default: false, validate: "boolean" },
};

const nodes: { [name: string]: NodeSpec } = {
  doc: { content: "block+" },

  paragraph: {
    content: "inline*",
    group: "block",
  },

  text: { group: "inline" },

  /** See the module comment above and `ReferenceKind`'s own comment. */
  reference: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: referenceAttrs,
  },

  /**
   * `[[task:id|label]]` (issue #173, ADR 0048) — a second inline atom
   * alongside `reference` rather than a fourth `ReferenceKind`, because a
   * task reference isn't merely a different target for the same kind of
   * link: it carries its own cached `label`/`checked`, and its rendering
   * (a real checkbox, entry-prose.tsx) has nothing in common with a `Link`
   * to a day or an Entry. Atom, like `reference`, for the identical
   * reason: the Composer can select or delete the whole thing, never edit
   * inside it, so it can never end up half-typed.
   *
   * `toDOM` (issue #177) is the one exception this file's own module
   * comment's "keep `entrySchema` free of anything view-specific"
   * preference makes, for a reason `reference` above doesn't have to:
   * `EditorView`'s clipboard copy path (`serializeForClipboard`,
   * prosemirror-view) builds its HTML through
   * `DOMSerializer.fromSchema(state.schema)`, never through a registered
   * `NodeView` — a NodeView only ever renders the LIVE editor DOM, and
   * `DOMSerializer`'s own `gatherToDOM` (prosemirror-model) silently
   * *drops* any node type whose spec has no `toDOM` from the map it
   * builds, so copying a selection that spans a `task_reference` node
   * called `undefined(node)` and threw, same failure family as the
   * missing-NodeView crash this ticket's own diagnosis opens with, just
   * reached through the clipboard instead of through render. The DOM this
   * produces is deliberately the mark's own literal characters
   * (`formatTaskReference`, the same function `entry-document.ts`'s
   * `writeTaskReference` calls to serialize this node to Markdown) rather
   * than a checkbox+label rendering that would only ever be seen for the
   * length of a copy — there is no `parseDOM` paired with it, so pasting
   * this back into any `entrySchema` document degrades to plain text
   * carrying those same characters (ADR 0042's "unresolved is plain text"
   * rule), which `entryMarkdownToDocument` reconstitutes into a live
   * `task_reference` again the next time that text is parsed (a Send, or
   * this same paste target's own next reload) — correctness for the
   * clipboard, not a second rendering to keep in step with
   * `taskReferenceNodeView`'s (composer-editor.ts).
   */
  task_reference: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: taskReferenceAttrs,
    toDOM(node) {
      return [
        "span",
        { "data-task-reference": "true" },
        formatTaskReference(String(node.attrs.taskId), String(node.attrs.label)),
      ];
    },
  },

  // `itemContent` below is `"paragraph block*"`, the shape
  // `prosemirror-schema-list`'s own doc comment recommends when a schema
  // wants its commands (`splitListItem`, `liftListItem`, `sinkListItem`) to
  // apply — issue #155's benefit, not this ticket's, but free to keep true
  // here since it costs nothing for the pure conversions.
  bullet_list: {
    ...bulletList,
    content: "list_item+",
    group: "block",
  },

  // `order` (inherited from `prosemirror-schema-list`'s base spec) mirrors
  // `EntryBlockNode`'s `orderedList.start` — CommonMark's "an ordered list
  // may start counting anywhere" (`5. five` starts at 5), which
  // `parseEntryMarkdown`'s `orderedListStart` already reads off the first
  // item's own marker.
  ordered_list: {
    ...orderedList,
    content: "list_item+",
    group: "block",
  },

  // `checked` is `null` for a plain item, `true`/`false` for a task —
  // three states, not two, because "not a task" and "an unchecked task" are
  // different things an item can be, and collapsing them would make every
  // list item render a checkbox. This is `EntryListItem.task` flattened
  // onto the node itself: `task === undefined` there is `checked === null`
  // here, `task.checked` there is `checked`'s own boolean value here.
  list_item: {
    ...listItem,
    content: "paragraph block*",
    attrs: { checked: { default: null, validate: "boolean|null" } },
  },
};

const marks: { [name: string]: MarkSpec } = {
  // `toDOM`/`parseDOM` (issue #155): unlike the three node types reused
  // from `prosemirror-schema-list` above, nothing upstream supplies these
  // for a mark — a `NodeView` (this file's own `reference`/`paragraph`
  // rendering, composer-editor.ts) has no mark equivalent, so a mark with
  // no `toDOM` cannot be rendered by an `EditorView` at all, full stop.
  // Purely additive rendering metadata: `entry-document.ts`'s conversions
  // build and read `Mark`s directly off `.type.name`/`.attrs`, never
  // through DOM, so neither this nor its own 691-case property test is
  // touched by adding it.
  strong: {
    toDOM: () => ["strong", 0],
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
  },
  em: {
    toDOM: () => ["em", 0],
    parseDOM: [{ tag: "em" }, { tag: "i" }],
  },
  // `code: true` is the flag ProseMirror's own commands use to treat a run
  // as monospace/verbatim (e.g. not auto-capitalizing, not applying other
  // input rules inside it) — it does not, by itself, exclude `strong`/`em`;
  // `**\`code\`** ` (bold code) is a valid combination in the mark set, and
  // `entry-document.ts`'s serializer relies on that: it treats `code` as an
  // innermost wrap around whatever `strong`/`em` are already open, not as
  // mutually exclusive with them.
  code: {
    code: true,
    toDOM: () => ["code", 0],
    parseDOM: [{ tag: "code" }],
  },
};

/**
 * The schema `entry-document.ts` builds documents in and reads them back
 * out of. A single shared instance — every `Node`/`Mark` created against it
 * carries this exact `Schema` object, and `Node`s from two different
 * `Schema` instances (even with identical specs) are never `.eq()` to one
 * another, so this must stay the one place the schema is constructed.
 */
export const entrySchema = new Schema({ nodes, marks });

/** Convenience alias so callers don't have to know `Attrs` lives in `prosemirror-model`. */
export type ReferenceAttrs = Attrs & {
  kind: ReferenceKind;
  raw: string;
  date: string | null;
  entryId: string | null;
};

/** `task_reference`'s own attrs — see `taskReferenceAttrs`'s own comment for why there is no `raw`. */
export type TaskReferenceAttrs = Attrs & {
  taskId: string;
  label: string;
  checked: boolean;
};
