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
  strong: {},
  em: {},
  // `code: true` is the flag ProseMirror's own commands use to treat a run
  // as monospace/verbatim (e.g. not auto-capitalizing, not applying other
  // input rules inside it) — it does not, by itself, exclude `strong`/`em`;
  // `**\`code\`** ` (bold code) is a valid combination in the mark set, and
  // `entry-document.ts`'s serializer relies on that: it treats `code` as an
  // innermost wrap around whatever `strong`/`em` are already open, not as
  // mutually exclusive with them.
  code: { code: true },
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
