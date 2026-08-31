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
 * `parseEntryMarkdown` (inline-markdown.ts) is the only thing that changed:
 * an Entry's body can now contain a bullet list, an ordered list, and a
 * task-list checkbox, on top of everything `parseInlineMarkdown` already
 * recognised. This file turns that block tree into React, reusing
 * `inlineProse`'s own `renderNodes` for every stretch of inline content —
 * marks, References, Search highlighting all behave identically whether
 * they sit in a list item or plain prose, because it is the same function
 * either way, not a second copy that could drift from it.
 *
 * No wrapper element of its own, same as `inlineProse`: this returns a
 * `Fragment` of sibling block elements (a `<p>` per prose run, a `<ul>`/
 * `<ol>` per list), and the caller supplies whatever box they sit in
 * (`entry-bubble.tsx`, `entry-row.tsx`'s `EntryBody`). That box can no
 * longer be a `<p>` itself — a `<ul>` cannot validly nest inside one — which
 * is why both callers moved to a `<div>` alongside this ticket.
 */
import type { ReactNode } from "react";
import { type ReferenceRenderers, renderNodes } from "@/components/inline-prose";
import type { EntryBlockNode, EntryListItem } from "@/lib/inline-markdown";
import { parseEntryMarkdown } from "@/lib/inline-markdown";
import { cn } from "@/lib/utils";

/**
 * Vertical rhythm shared by every top-level block this file renders —
 * `<p>`, `<ul>`, `<ol>` alike. `first:mt-0` is what makes the overwhelming
 * common case (an Entry with no list at all, one `"prose"` block) render
 * with no margin of its own, identical to the single `<p>` this used to be
 * before this ticket; `mt-1` only shows up once there is more than one
 * sibling block to separate, whether that's two list-interrupted stretches
 * of prose or a list following one.
 */
const BLOCK_SPACING = "first:mt-0 mt-1";

/**
 * A block's own React output, recursively — the same function renders
 * `Document`-level blocks and a `ListItem`'s own nested `content`, since
 * both are just `EntryBlockNode[]`. `first:mt-0` therefore resets per
 * container: the first block inside a list item gets no top margin of its
 * own, exactly like the first block of the Entry as a whole.
 */
function renderBlocks(
  blocks: readonly EntryBlockNode[],
  query: string,
  refs: ReferenceRenderers,
  keyPrefix: string,
): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}${index}`;
    switch (block.kind) {
      case "prose":
        return (
          <p key={key} className={cn("whitespace-pre-wrap", BLOCK_SPACING)}>
            {renderNodes(block.children, query, refs, `${key}-`)}
          </p>
        );
      case "bulletList":
        return (
          <ul key={key} className={cn("list-disc space-y-0.5 pl-5", BLOCK_SPACING)}>
            {block.items.map((item, itemIndex) =>
              renderListItem(item, query, refs, `${key}-${itemIndex}`),
            )}
          </ul>
        );
      case "orderedList":
        return (
          <ol
            key={key}
            start={block.start}
            className={cn("list-decimal space-y-0.5 pl-5", BLOCK_SPACING)}
          >
            {block.items.map((item, itemIndex) =>
              renderListItem(item, query, refs, `${key}-${itemIndex}`),
            )}
          </ol>
        );
      default:
        // Exhaustive over EntryBlockNode's three kinds — `satisfies never`
        // is what makes a fourth kind a compile error here rather than a
        // silent fallthrough, and the explicit `return` (rather than
        // relying on the switch being exhaustive) is what the linter wants
        // out of a callback passed to `map`.
        return block satisfies never;
    }
  });
}

/**
 * One `<li>`. A task item drops the marker entirely — no bullet, no literal
 * `[ ]`/`[x]` — in favour of a real, disabled `<input type="checkbox">`
 * carrying the same checked state; `disabled` rather than any read-only
 * affordance because toggling one is issue #153's job, not this one's, and
 * a control nothing yet wires up must not look interactive. The checkbox
 * sits beside its content in a flex row rather than nested inside the
 * `<li>`'s own marker box, which is what `list-none` and the negative
 * left margin below undo — a task item earns its own indicator instead of
 * competing with a bullet for the same space.
 */
function renderListItem(
  item: EntryListItem,
  query: string,
  refs: ReferenceRenderers,
  key: string,
): ReactNode {
  const content = renderBlocks(item.content, query, refs, `${key}-`);
  if (item.task === undefined) {
    return <li key={key}>{content}</li>;
  }
  return (
    <li key={key} className="-ml-5 flex list-none items-baseline gap-1.5">
      <input
        type="checkbox"
        checked={item.task.checked}
        disabled
        aria-label={item.task.checked ? "Checked" : "Unchecked"}
        className="mt-[0.2em] shrink-0 accent-current"
      />
      <div className="min-w-0 flex-1">{content}</div>
    </li>
  );
}

export function entryProse(body: string, query = "", refs: ReferenceRenderers = {}): ReactNode {
  return <>{renderBlocks(parseEntryMarkdown(body), query, refs, "")}</>;
}
