/**
 * Renders parsed prose (ADR 0041) as React nodes — never as an HTML string,
 * so there is nothing for a sanitizer to sanitize.
 *
 * Everything emitted here is inline. There is deliberately no wrapper
 * element: the caller decides what box the prose sits in — Grounding, the
 * Digest reader, the Entry bubble (through `entryProse`, entry-prose.tsx)
 * and everyone else each supply their own `<p>`. (Before issue #149 the
 * Entry bubble was the one exception, sharing a line box with a
 * right-floated clock — ADR 0036 — which needed the body to stay unwrapped
 * there specifically; that clock now has its own row instead.)
 *
 * Search highlighting is applied *within* each text node rather than over raw
 * character offsets into the body (ADR 0041). A match is therefore found in
 * the words as they read, not across the markers that formatted them.
 */
import type { ReactNode } from "react";
import { highlightMatches } from "@/lib/highlight-match";
import { type InlineNode, parseInlineMarkdown } from "@/lib/inline-markdown";

/**
 * How a Reference is drawn. Both are optional and default to the text the user
 * typed, which is what makes a Reference render as plain prose until something
 * can actually resolve it — the rule for an unknown day, a removed Entry, and
 * an Entry that has not Synced to this Device yet.
 */
export interface ReferenceRenderers {
  date?: (node: { date: string; raw: string }, key: string) => ReactNode;
  entry?: (node: { entryId: string; raw: string }, key: string) => ReactNode;
}

function renderText(text: string, query: string, keyPrefix: string): ReactNode[] {
  if (query.trim() === "") {
    return [text];
  }
  return highlightMatches(text, query).map((segment, index) =>
    segment.matched ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one text run for one render; keyPrefix keeps them unique across runs.
      <mark key={`${keyPrefix}m${index}`} className="rounded-sm bg-primary/30 text-inherit">
        {segment.text}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one text run for one render; keyPrefix keeps them unique across runs.
      <span key={`${keyPrefix}t${index}`}>{segment.text}</span>
    ),
  );
}

/**
 * A loop with explicit pushes rather than `flatMap`: the switch below is
 * exhaustive over `InlineNode`, but only the type checker can see that, and a
 * `flatMap` callback with no fallthrough return reads as a bug to every linter
 * that looks at it.
 *
 * Exported for `entry-prose.tsx`: an Entry's block renderer (issue #152)
 * needs this exact inline rendering — marks, References, Search
 * highlighting — inside a `<li>`, not just inside the flat run `inlineProse`
 * below hands its own caller. Reusing it rather than a second copy is what
 * keeps a Reference chip, a highlighted match, and nested emphasis looking
 * and behaving identically whether they sit in a list item or plain prose.
 */
export function renderNodes(
  nodes: readonly InlineNode[],
  query: string,
  refs: ReferenceRenderers,
  keyPrefix: string,
): ReactNode[] {
  const rendered: ReactNode[] = [];
  nodes.forEach((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.kind) {
      case "text":
        rendered.push(...renderText(node.text, query, `${key}-`));
        break;
      case "strong":
        rendered.push(
          <strong key={key} className="font-semibold">
            {renderNodes(node.children, query, refs, `${key}-`)}
          </strong>,
        );
        break;
      case "emphasis":
        rendered.push(
          <em key={key} className="italic">
            {renderNodes(node.children, query, refs, `${key}-`)}
          </em>,
        );
        break;
      case "code":
        rendered.push(
          // Inline, and styled without a background box that would change the
          // line box's height — the Digest card counts lines by dividing
          // scrollHeight by lineHeight, and a taller line silently miscounts.
          <code key={key} className="rounded-sm bg-muted px-1 font-mono text-[0.9em]">
            {node.text}
          </code>,
        );
        break;
      case "dateReference":
        rendered.push(
          ...(refs.date === undefined
            ? renderText(node.raw, query, `${key}-`)
            : [refs.date({ date: node.date, raw: node.raw }, key)]),
        );
        break;
      case "entryReference":
        rendered.push(
          ...(refs.entry === undefined
            ? renderText(node.raw, query, `${key}-`)
            : [refs.entry({ entryId: node.entryId, raw: node.raw }, key)]),
        );
        break;
    }
  });
  return rendered;
}

/**
 * Prose as inline React content. `query` highlights Search matches; omit it
 * (or pass "") on the surfaces that never have one.
 */
export function inlineProse(body: string, query = "", refs: ReferenceRenderers = {}): ReactNode {
  return renderNodes(parseInlineMarkdown(body), query, refs, "");
}
