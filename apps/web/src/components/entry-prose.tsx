/**
 * An Entry's own rendering path (issue #148), and — since issue #152 — the
 * one prose surface that renders block structure at all. Every other prose
 * surface (the Digest reader, the clamped Digest card, Reflect's Question
 * and its Answer) still renders through `inlineProse` (inline-prose.tsx)
 * directly and unchanged; `useFittedDigests` (digest-page.tsx) still derives
 * a card's line budget by dividing `scrollHeight` by `lineHeight`, and that
 * arithmetic still silently breaks the moment a block element reaches it.
 * Issue #148 put this seam here for exactly this reason, before there was
 * anything on the other side of it to diverge into.
 *
 * `parseEntryMarkdown` (inline-markdown.ts) is most of what changed: an
 * Entry's body can now contain a bullet list, an ordered list, and a
 * task-list checkbox, on top of everything `parseInlineMarkdown` already
 * recognised, and — since ADR 0069/issue #234 — a bare `\n` is a block
 * break and `\` immediately followed by `\n` is a soft break within one.
 * `parseEntryMarkdown` is also `entryMarkdownToDocument`'s (entry-document.ts,
 * the Composer's own load path) reader — the two used to disagree, through
 * a display-only sibling this file alone called, but that parallel parser
 * is gone (ADR 0069's own Decision, amended): every reader of a stored
 * body goes through this one function now, so History and the Composer
 * never show two different shapes for the same body. This file turns that
 * block tree into React,
 * reusing `inlineProse`'s own `renderNodes` for every stretch of inline
 * content — marks, References, Search highlighting all behave identically
 * whether they sit in a list item or plain prose, because it is the same
 * function either way, not a second copy that could drift from it.
 *
 * No wrapper element of its own, same as `inlineProse`: this returns a
 * `Fragment` of sibling block elements (a `<p>` per prose run, a `<ul>`/
 * `<ol>` per list), and the caller supplies whatever box they sit in
 * (`entry-bubble.tsx`, `entry-row.tsx`'s `EntryBody`). That box can no
 * longer be a `<p>` itself — a `<ul>` cannot validly nest inside one — which
 * is why both callers moved to a `<div>` alongside this ticket.
 */
import { Fragment, type ReactNode } from "react";
import { type ReferenceRenderers, renderNodes } from "@/components/inline-prose";
import type { EntryBlockNode, EntryListItem } from "@/lib/inline-markdown";
import {
  entryBlocksToText,
  parseCommentMarkdown,
  parseEntryMarkdown,
  referencedTaskOf,
} from "@/lib/inline-markdown";
import { cn } from "@/lib/utils";

/**
 * A *bare* checkbox — `- [ ]`/`- [x]` with no `[[task:id|label]]` mark
 * behind it — is rendered permanently disabled, and has been since issue
 * #231 (ADR 0074). It used to be clickable (issue #153) and ticking it
 * spliced the marker characters directly into the Entry's body
 * (`toggleTaskAt`, toggle-task.ts) — ADR 0043's "a checkbox is clickable,
 * and ticking it splices the stored string." ADR 0074 retired that: Todo
 * is now the only place completion is handled, so a checkbox that reaches
 * a Task opens it there instead (`TaskReferenceItem`, entry-row.tsx,
 * below `referencedTaskOf`'s branch in `renderListItem`) rather than
 * ticking in place.
 *
 * A *bare* checkbox specifically has no Task to open, by construction —
 * ADR 0053 made every checkbox a Task, but the association is recorded
 * nowhere except the `[[task:id|label]]` mark itself (`Task`'s own type,
 * packages/core/src/task-types.ts, carries no back-reference to the Entry
 * it came from). A checkbox that hasn't been rewritten into that shape
 * yet — Promotion (`promoteBareCheckboxes`) hasn't reached it, or issue
 * #174's backfill hasn't finished this Device's one-time pass over old
 * History — genuinely has no Task behind it yet, so there is nothing this
 * renderer could open. Rather than invent a fallback (guessing a Task by
 * matching text, the exact "out-of-band matching" ADR 0048's own
 * Alternatives Considered section rejected for the identical reason),
 * this stays read-only until Promotion or the backfill turns it into a
 * reference — the same moment it becomes a live, clickable
 * `TaskReferenceItem` on its very next render.
 *
 * This is therefore the same "no renderer, no interactivity" stance
 * `defaultTaskReferenceItem` below already takes for an unresolved
 * reference — a bare checkbox is just a reference that hasn't been minted
 * yet.
 */

/**
 * What `renderListItem` hands a referenced checkbox line's own renderer
 * (issue #173, ADR 0048) — everything about the line except how to draw
 * it. `label`/`checked` are the body's own *cache*: whatever a live Task
 * lookup would improve on is the renderer's own business, not this file's
 * — `entry-prose.tsx` has no store access of any kind (the module comment
 * above already says as much for the rest of this file), so the default
 * renderer below can only ever show the cache. `content` is any block
 * that follows the reference's own line inside the same item (a nested
 * list — `- [ ] [[task:id|label]]\n  - a note`) already rendered through
 * the ordinary path, so a custom renderer never has to know
 * `EntryBlockNode` exists to render it.
 */
export interface TaskReferenceProps {
  readonly taskId: string;
  readonly label: string;
  readonly checked: boolean;
  readonly content: ReactNode;
  /**
   * The enclosing item's own `EntryTaskMarker` offsets (issue #173),
   * handed through unchanged — a writeable renderer (`entry-row.tsx`'s
   * `TaskReferenceItem`) needs them to splice this one Entry's own
   * `[ ]`/`[x]` cache the same way `toggleTaskAt` (toggle-task.ts) already
   * does for a bare checkbox, without re-parsing the body to find them
   * again.
   */
  readonly markerFrom: number;
  readonly markerTo: number;
}

/**
 * Draws one referenced checkbox line, or the whole rest of the list item —
 * `entryProse`'s own analogue of `ReferenceRenderers.date`/`.entry`, one
 * level up: those render one inline node, this renders the `<li>` itself,
 * because a referenced task's checkbox chrome (its checked state, its
 * click handling) has to change as a unit with the label beside it rather
 * than independently, the way `renderListItem`'s existing bare-checkbox
 * branch already keeps its own `<input>` and label together.
 *
 * `undefined` — the default `entryProse` runs with — is what keeps a
 * referenced checkbox rendering the body's own cache with `defaultTaskReferenceItem`
 * below, exactly the "no renderer, no interactivity" rule
 * `ReferenceRenderers`'s own fields already follow for a date/Entry
 * Reference.
 */
export type TaskReferenceRenderer = (props: TaskReferenceProps, key: string) => ReactNode;

const BLOCK_SPACING = "mt-0";

const HEADING_CLASS: Record<number, string> = {
  1: "text-lg font-semibold",
  2: "text-base font-semibold",
  3: "text-sm font-semibold",
  4: "text-sm font-semibold",
  5: "text-sm font-semibold",
  6: "text-sm font-semibold",
};

const HEADING_TAG = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function headingTag(level: number): (typeof HEADING_TAG)[number] {
  const index = Math.min(Math.max(level, 1), HEADING_TAG.length) - 1;
  return HEADING_TAG[index] ?? "h6";
}

/**
 * The disc → circle → square cascade for a NESTED bullet list, issue #162
 * — the read-side twin of index.css's `.ProseMirror ul` / `:is(ul, ol) ul`
 * / `:is(ul, ol) :is(ul, ol) ul` cascade (that file's own comment, above
 * its `@layer base` block, has the full account of why an ancestor `ol`
 * counts towards a `ul`'s depth exactly the same as an ancestor `ul`
 * does). This file cannot reach for a descendant CSS selector the way that
 * one does: `entryProse` returns a bare `Fragment` with no wrapper element
 * (this file's own module comment above), so there is nothing to scope
 * `ul ul`/`ul ul ul` selectors to that wouldn't ALSO catch some unrelated
 * list elsewhere on the page — Search's own result list, a future
 * Settings page list, anything else that happens to nest a `<ul>` inside
 * another. `depth` is threaded through `renderBlocks`/`renderListItem`'s
 * own recursion instead, purely in TypeScript, so the class this function
 * returns is scoped by construction to exactly the lists this module
 * itself renders.
 *
 * `depth` here is "how many lists deep is this `<ul>` sitting," 1 for a
 * top-level list, exactly the value `renderBlocks` computes as
 * `depth + 1` when it encounters a `bulletList`/`orderedList` block — see
 * that function's own comment on why the increment happens for BOTH list
 * kinds even though only a bullet list's own glyph ever varies with it.
 * Capped at square for depth 3 and beyond ("repeat ▪ beyond depth 3, as
 * browsers do" — the ticket's own words), the same cap index.css's own
 * `:is(ul, ol) :is(ul, ol) ul` rule produces for free by matching "at
 * least two list ancestors" rather than "exactly two."
 *
 * Tailwind ships `list-disc` as a named utility but has no built-in
 * `list-circle`/`list-square` — arbitrary-value syntax (`list-[circle]`,
 * `list-[square]`) reaches the same underlying `list-style-type` property
 * Tailwind's own `list-disc` compiles to, so the three depths differ only
 * in this one class, not in mechanism.
 */
function bulletListStyleClass(depth: number): string {
  if (depth <= 1) {
    return "list-disc";
  }
  if (depth === 2) {
    return "list-[circle]";
  }
  return "list-[square]";
}

function renderBlocks(
  blocks: readonly EntryBlockNode[],
  query: string,
  refs: ReferenceRenderers,
  keyPrefix: string,
  renderTaskReference: TaskReferenceRenderer,
  depth: number,
  mode: EntryProseMode,
  suppressPara = false,
): ReactNode[] {
  const inlineOptions = {
    strikeTag: mode === "comment" ? ("del" as const) : ("s" as const),
    breakNewlines: mode === "comment",
  };
  return blocks.map((block, index) => {
    const key = `${keyPrefix}${index}`;
    switch (block.kind) {
      case "prose": {
        // No `whitespace-pre-wrap` of its own (ADR 0069's prefactor) — every
        // caller of `entryProse` wraps it in an element that already sets
        // that (`EntryBody`, entry-row.tsx; the bubble body, entry-bubble.tsx),
        // and `white-space` is an inherited CSS property, so repeating it
        // here would be the third, fully redundant copy this ticket exists
        // to collapse away. Still needed somewhere in the ancestor chain,
        // even now that a block boundary is a real element rather than a
        // literal `\n`: a soft break (`walkEntryInline`'s "HardBreak" case,
        // inline-markdown.ts) is still a literal `\n` character sitting
        // inside this `<p>`'s own text, and multiple consecutive spaces are
        // still exactly what the author typed.
        const inline = renderNodes(block.children, query, refs, `${key}-`, inlineOptions);
        if (suppressPara) {
          return <Fragment key={key}>{inline}</Fragment>;
        }
        return (
          <p key={key} className={BLOCK_SPACING}>
            {inline}
          </p>
        );
      }
      case "bulletList": {
        const listDepth = depth + 1;
        const tight = mode === "comment" && block.tight === true;
        return (
          <ul
            key={key}
            className={cn(bulletListStyleClass(listDepth), "space-y-0.5 pl-5", BLOCK_SPACING)}
          >
            {block.items.map((item, itemIndex) =>
              renderListItem(
                item,
                query,
                refs,
                `${key}-${itemIndex}`,
                renderTaskReference,
                listDepth,
                mode,
                tight,
              ),
            )}
          </ul>
        );
      }
      case "orderedList": {
        const listDepth = depth + 1;
        const tight = mode === "comment" && block.tight === true;
        const start = mode === "comment" && block.start === 1 ? undefined : block.start;
        return (
          <ol
            key={key}
            start={start}
            className={cn("list-decimal space-y-0.5 pl-5", BLOCK_SPACING)}
          >
            {block.items.map((item, itemIndex) =>
              renderListItem(
                item,
                query,
                refs,
                `${key}-${itemIndex}`,
                renderTaskReference,
                listDepth,
                mode,
                tight,
              ),
            )}
          </ol>
        );
      }
      case "heading": {
        const Tag = headingTag(block.level);
        return (
          <Tag
            key={key}
            className={cn(HEADING_CLASS[block.level] ?? HEADING_CLASS[6], BLOCK_SPACING)}
          >
            {renderNodes(block.children, query, refs, `${key}-`, inlineOptions)}
          </Tag>
        );
      }
      case "blockquote":
        return (
          <blockquote
            key={key}
            className={cn(
              "border-muted-foreground/40 border-l-2 pl-3 text-muted-foreground",
              BLOCK_SPACING,
            )}
          >
            {renderBlocks(block.content, query, refs, `${key}-`, renderTaskReference, depth, mode)}
          </blockquote>
        );
      case "codeBlock":
        return (
          <pre
            key={key}
            className={cn(
              "overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs",
              BLOCK_SPACING,
            )}
          >
            <code>{block.text}</code>
          </pre>
        );
      default:
        // Exhaustive over EntryBlockNode's six kinds — `satisfies never`
        // is what makes a seventh kind a compile error here rather than a
        // silent fallthrough, and the explicit `return` (rather than
        // relying on the switch being exhaustive) is what the linter wants
        // out of a callback passed to `map`.
        return block satisfies never;
    }
  });
}

/**
 * `entryProse`'s own default `TaskReferenceRenderer` — cached data,
 * unconditionally disabled, the same "no live lookup available" stance
 * `ReferenceRenderers`'s own missing `date`/`entry` fields take (this
 * file's own module comment: no store access lives here). A caller that
 * wants a referenced checkbox to show the Task's *live* label/checked
 * state, or to actually tick it, supplies its own renderer instead —
 * `entry-row.tsx`'s `TaskReferenceItem` is that renderer, reading
 * `useEntryStore()`'s own `tasks`/`completedTasks`.
 */
const defaultTaskReferenceItem: TaskReferenceRenderer = ({ label, checked, content }, key) => (
  <li key={key} className="-ml-5 flex list-none items-baseline gap-1.5">
    <input
      type="checkbox"
      checked={checked}
      disabled
      aria-label={label || (checked ? "Checked" : "Unchecked")}
      className="mt-[0.2em] shrink-0 accent-current"
    />
    <div className="min-w-0 flex-1">
      {/* No `whitespace-pre-wrap` here either — see the "prose" case in
          `renderBlocks` above for why an ancestor wrapper already owns it. */}
      <p className={BLOCK_SPACING}>{label}</p>
      {content}
    </div>
  </li>
);

/**
 * The empty PARENT item ADR 0071 names — a `list_item` whose only reason to
 * exist is to hold a nested list one level deeper (`sinkFirstListItem`,
 * composer-commands.ts, reached from Tab on a list's first item, the one
 * case plain `sinkListItem` refuses). ADR 0071's own "Consequences" section
 * left this half deliberately open: issue #233 did the Composer's own
 * `.ProseMirror` rendering (index.css, near this file's own module
 * comment), and named the read-only half — this function — as a known,
 * temporary gap for a later ticket (issue #236) to close, so a Sent Entry
 * built through that Tab press stopped showing a bullet beside an empty
 * line the Composer itself never showed one beside.
 *
 * Detected structurally, the same way index.css's own selector is —
 * "no prose, only a nested list" — but in TypeScript against `EntryBlockNode`
 * rather than a CSS `:has()` chain, because this file already has the exact
 * parsed shape in hand and a DOM selector would have nothing to match
 * against (this file's own module comment: `entryProse` returns a bare
 * `Fragment`, and `renderListItem`'s own output here has no wrapping `<div>`
 * around an item's content the way `composer-editor.ts`'s NodeView does, so
 * the two-`:has()` selector index.css needs for the identical shape would
 * not even apply to this file's own markup).
 *
 * `item.content[0]` is checked, not `item.content` as a whole: `collectBlocks`
 * (inline-markdown.ts) never pushes a `"prose"` block for a genuinely empty
 * paragraph — confirmed directly against a real parse of the exact markdown
 * `entryDocumentToMarkdown` (entry-document.ts) writes for a sunk-first-item
 * (`"- \n  - alpha\n- bravo"`), not assumed — so an item with no text of its
 * own has NO `"prose"` entry in `content` at all, and whatever block comes
 * first is unconditionally what the parser found there. A `bulletList`/
 * `orderedList` sitting first therefore means "this item's own words are
 * empty," full stop; a `content` that is empty altogether (`[]`, a plain
 * blank line pressed twice with no nested list following it — ADR 0071's own
 * "an ORDINARY empty list item... still shows its marker") has no `[0]` to
 * match this check at all, so it falls straight through to the normal,
 * marker-bearing branch below, exactly matching ADR 0071's own
 * `index.css` selector's scope.
 *
 * Task items are excluded up front (`item.task !== undefined` guard) purely
 * because `sinkFirstListItem` only ever wraps a `bullet_list`/`ordered_list`
 * item, never a checklist one — nothing observed needs this to cover a
 * checkbox too, and `renderListItem`'s own checkbox branch already has a
 * different, unrelated reason to render `list-none` (replacing the bullet
 * with a real `<input>`, not hiding a wrapper's marker).
 */
function isMarkerlessParentItem(item: EntryListItem): boolean {
  if (item.task !== undefined) {
    return false;
  }
  const first = item.content[0];
  return first !== undefined && (first.kind === "bulletList" || first.kind === "orderedList");
}

function renderListItem(
  item: EntryListItem,
  query: string,
  refs: ReferenceRenderers,
  key: string,
  renderTaskReference: TaskReferenceRenderer,
  depth: number,
  mode: EntryProseMode,
  tight: boolean,
): ReactNode {
  if (item.task !== undefined) {
    const reference = referencedTaskOf(item);
    if (reference !== undefined) {
      const rest = renderBlocks(
        item.content.slice(1),
        query,
        refs,
        `${key}-`,
        renderTaskReference,
        depth,
        mode,
        tight,
      );
      return renderTaskReference(
        {
          taskId: reference.taskId,
          label: reference.label,
          checked: item.task.checked,
          content: rest.length > 0 ? rest : null,
          markerFrom: item.task.markerFrom,
          markerTo: item.task.markerTo,
        },
        key,
      );
    }
  }
  const content = renderBlocks(
    item.content,
    query,
    refs,
    `${key}-`,
    renderTaskReference,
    depth,
    mode,
    tight,
  );
  if (item.task === undefined) {
    return (
      <li key={key} className={isMarkerlessParentItem(item) ? "list-none" : undefined}>
        {content}
      </li>
    );
  }
  const { checked } = item.task;
  const label = entryBlocksToText(item.content).trim() || (checked ? "Checked" : "Unchecked");
  return (
    <li key={key} className="-ml-5 flex list-none items-baseline gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        disabled
        aria-label={label}
        className="mt-[0.2em] shrink-0 accent-current"
      />
      <div className="min-w-0 flex-1">{content}</div>
    </li>
  );
}

export type EntryProseMode = "entry" | "comment";

/**
 * `renderTaskReference` defaults to `defaultTaskReferenceItem` (cached
 * data, disabled) for every caller that doesn't supply its own — Grounding
 * (`entry-row.tsx`'s `EntryBody`), every test in this file's own suite,
 * and anywhere else that renders an Entry's body with no Task store in
 * reach. `entry-row.tsx`'s `entryBodyContent` is the one caller that
 * supplies a live one.
 *
 * `parseEntryMarkdown` (inline-markdown.ts) — ADR 0069/issue #234's shared
 * reader, so a bare `\n` in `body` renders as a block break and `\`
 * immediately followed by `\n` as a soft break within one, the identical
 * shape `entryMarkdownToDocument` (entry-document.ts, the Composer's own
 * load path) builds a ProseMirror document from. `mode` (above) switches
 * this to `parseCommentMarkdown` instead; `renderBlocks` itself needs no
 * mode of its own to do that safely — the three block kinds only that
 * parser produces (`"heading"`/`"blockquote"`/`"codeBlock"`) simply never
 * occur in whatever `parseEntryMarkdown` hands it.
 */
export function entryProse(
  body: string,
  query = "",
  refs: ReferenceRenderers = {},
  renderTaskReference: TaskReferenceRenderer = defaultTaskReferenceItem,
  mode: EntryProseMode = "entry",
): ReactNode {
  const blocks = mode === "comment" ? parseCommentMarkdown(body) : parseEntryMarkdown(body);
  return <>{renderBlocks(blocks, query, refs, "", renderTaskReference, 0, mode)}</>;
}
