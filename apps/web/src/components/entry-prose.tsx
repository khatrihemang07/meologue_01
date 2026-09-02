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
import { entryBlocksToText, parseEntryMarkdown, referencedTaskOf } from "@/lib/inline-markdown";
import { cn } from "@/lib/utils";

/**
 * A tap on a rendered checkbox (issue #153) — `markerFrom`/`markerTo` are
 * handed straight through from the `EntryTaskMarker` the item carries, so
 * the caller (entry-row.tsx's `entryBodyContent`) can splice the source
 * string (`toggleTaskAt`, toggle-task.ts) with no re-parse of its own.
 * Optional everywhere it's threaded below: `undefined` is what keeps a
 * checkbox disabled rather than merely unwired — see `renderListItem`'s
 * own comment for which callers pass one and which deliberately don't.
 *
 * `toggleTaskAt` retires for a *referenced* checkbox line (issue #173,
 * ADR 0048's "ticking writes the Task") — this handler is never invoked
 * for one; see `renderListItem`'s own comment for where that branch
 * happens. A bare checkbox with no reference behind it keeps working
 * through this handler exactly as it did before this ticket, on purpose:
 * issue #174's backfill turns an existing bare checkbox into a reference
 * eventually, not on this ticket's own timeline, so this code must not
 * assume every checkbox it ever sees already has a Task behind it.
 */
type ToggleTaskHandler = (markerFrom: number, markerTo: number) => void;

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

/**
 * A block's own React output, recursively — the same function renders
 * `Document`-level blocks and a `ListItem`'s own nested `content`, since
 * both are just `EntryBlockNode[]`. `first:mt-0` therefore resets per
 * container: the first block inside a list item gets no top margin of its
 * own, exactly like the first block of the Entry as a whole.
 *
 * `depth` (issue #162) counts list nesting, not recursion in general —
 * `entryProse` starts it at `0` (no list yet), and it only advances, by
 * exactly 1, at the point a `bulletList`/`orderedList` block is actually
 * rendered; the two recursive calls below hand each new list's items that
 * incremented value, so a further-nested list found inside one of them
 * advances again from there rather than from `0`. `orderedList` computes
 * and threads the same incremented depth as `bulletList` even though
 * `list-decimal` never varies with it (index.css's own comment on why an
 * `ol` needs no depth cascade of its own) — an `ol` still has to advance
 * the counter for whatever list-of-either-kind nests INSIDE it to see the
 * right depth, exactly what index.css's `:is(ul, ol)` selectors count on
 * the CSS side.
 */
function renderBlocks(
  blocks: readonly EntryBlockNode[],
  query: string,
  refs: ReferenceRenderers,
  keyPrefix: string,
  onToggleTask: ToggleTaskHandler | undefined,
  renderTaskReference: TaskReferenceRenderer,
  depth: number,
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
      case "bulletList": {
        const listDepth = depth + 1;
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
                onToggleTask,
                renderTaskReference,
                listDepth,
              ),
            )}
          </ul>
        );
      }
      case "orderedList": {
        const listDepth = depth + 1;
        return (
          <ol
            key={key}
            start={block.start}
            className={cn("list-decimal space-y-0.5 pl-5", BLOCK_SPACING)}
          >
            {block.items.map((item, itemIndex) =>
              renderListItem(
                item,
                query,
                refs,
                `${key}-${itemIndex}`,
                onToggleTask,
                renderTaskReference,
                listDepth,
              ),
            )}
          </ol>
        );
      }
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
      <p className={cn("whitespace-pre-wrap", BLOCK_SPACING)}>{label}</p>
      {content}
    </div>
  </li>
);

/**
 * One `<li>`. A task item drops the marker entirely — no bullet, no literal
 * `[ ]`/`[x]` — in favour of a real `<input type="checkbox">` carrying the
 * same checked state. The checkbox sits beside its content in a flex row
 * rather than nested inside the `<li>`'s own marker box, which is what
 * `list-none` and the negative left margin below undo — a task item earns
 * its own indicator instead of competing with a bullet for the same space.
 *
 * `onToggleTask === undefined` is what makes the checkbox disabled rather
 * than merely un-wired (issue #153) — `entryProse`'s own doc comment on
 * `ToggleTaskHandler` names the one caller that deliberately never passes
 * one: `entry-row.tsx`'s `EntryBody`, Reflection's Grounding disclosure,
 * which CONTEXT.md requires to stay a read-only view of what an Answer was
 * based on. A tickable box there would let editing a past Answer relied on
 * look possible, exactly the thing `EntryRowProps.actions`'s own comment
 * already refuses for Edit/Delete/Refer — this follows the same rule for
 * the same reason, just for a control embedded in the body instead of a
 * button beside the row.
 *
 * Toggling calls `onToggleTask` with the item's own `markerFrom`/
 * `markerTo` on `onChange` (not `onClick`): a checkbox `<input>` already
 * fires `onChange` for both a pointer click and a Space press while
 * focused, so this is keyboard-operable for free rather than needing a
 * second handler wired to satisfy that separately.
 *
 * The accessible name is the item's own words (issue #153's own
 * requirement), not a generic "Checked"/"Unchecked" — `entryBlocksToText`
 * flattens exactly the way `entrySnippet` (entry-row.tsx) already does for
 * an Entry Reference's own chip, dropping list/task markers and inline
 * formatting so the name reads as prose. The checked/unchecked state
 * itself does not need to be spelled out here: `role="checkbox"`'s native
 * semantics already announce that from the element's own `checked`
 * property. Falls back to the old "Checked"/"Unchecked" wording whenever
 * `entryBlocksToText` flattens to `""` — defensive rather than reachable
 * through today's dialect (every input tried while writing this — `- [ ]`
 * alone included — either grows real text or stops being a `Task` at all,
 * per `taskMarkerOf`'s own contract), kept because a checkbox with a blank
 * accessible name is a worse failure than this fallback ever costs.
 *
 * A *referenced* task item (issue #173, ADR 0048) never reaches any of the
 * above — `referencedTaskOf` (inline-markdown.ts) is checked first, and
 * when it finds one this function hands off to `renderTaskReference`
 * entirely instead, with the item's own checkbox marker as the cached
 * fallback `checked` and everything AFTER the reference's own line (a
 * nested list, most likely)
 * still rendered through the ordinary path below and passed through as
 * `content`. `toggleTaskAt`'s own splice retires for exactly this
 * branch — `onToggleTask` is never invoked for it, on purpose: ticking a
 * reference has to write the Task (ADR 0048), not re-splice the Entry's
 * own marker, and this file has no Task store to write to (this file's
 * own module comment). A caller that can write one supplies its own
 * `renderTaskReference` and wires ticking there instead.
 */
function renderListItem(
  item: EntryListItem,
  query: string,
  refs: ReferenceRenderers,
  key: string,
  onToggleTask: ToggleTaskHandler | undefined,
  renderTaskReference: TaskReferenceRenderer,
  depth: number,
): ReactNode {
  if (item.task !== undefined) {
    const reference = referencedTaskOf(item);
    if (reference !== undefined) {
      const rest = renderBlocks(
        item.content.slice(1),
        query,
        refs,
        `${key}-`,
        onToggleTask,
        renderTaskReference,
        depth,
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
    onToggleTask,
    renderTaskReference,
    depth,
  );
  if (item.task === undefined) {
    return <li key={key}>{content}</li>;
  }
  const { checked, markerFrom, markerTo } = item.task;
  const label = entryBlocksToText(item.content).trim() || (checked ? "Checked" : "Unchecked");
  return (
    <li key={key} className="-ml-5 flex list-none items-baseline gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={onToggleTask === undefined}
        onChange={onToggleTask === undefined ? undefined : () => onToggleTask(markerFrom, markerTo)}
        aria-label={label}
        className="mt-[0.2em] shrink-0 accent-current"
      />
      <div className="min-w-0 flex-1">{content}</div>
    </li>
  );
}

/**
 * `renderTaskReference` defaults to `defaultTaskReferenceItem` (cached
 * data, disabled) for every caller that doesn't supply its own — Grounding
 * (`entry-row.tsx`'s `EntryBody`), every test in this file's own suite,
 * and anywhere else that renders an Entry's body with no Task store in
 * reach. `entry-row.tsx`'s `entryBodyContent` is the one caller that
 * supplies a live one.
 */
export function entryProse(
  body: string,
  query = "",
  refs: ReferenceRenderers = {},
  onToggleTask?: ToggleTaskHandler,
  renderTaskReference: TaskReferenceRenderer = defaultTaskReferenceItem,
): ReactNode {
  return (
    <>
      {renderBlocks(
        parseEntryMarkdown(body),
        query,
        refs,
        "",
        onToggleTask,
        renderTaskReference,
        0,
      )}
    </>
  );
}
