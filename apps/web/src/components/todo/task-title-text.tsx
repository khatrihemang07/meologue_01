import type { ReactNode } from "react";
import { inlineProse } from "@/components/inline-prose";
import { titleLinkSegments } from "@/lib/task-title-links";

/**
 * Renders a saved Task title, converting `[text](url)` into a live link —
 * the read-only counterpart to the title editor's own live mark (issue
 * #398, following #373's storage design: `Task.title` stays a plain
 * string, and a link survives only as that literal `[text](url)` text).
 *
 * Every existing title-rendering call site already ran `task.content`
 * through `inlineProse` (`inline-prose.tsx`) before this ticket — a Task
 * title has supported `**bold**`/`_em_`/`` `code` `` this whole time, even
 * though the title editor itself has never offered a way to type them
 * (`task-row.test.tsx`'s own "renders markdown in the title as real
 * formatting" is the regression test for exactly that). This function has
 * to keep that working, not just add link support next to it: the common
 * case (no link at all) hands the WHOLE title straight to `inlineProse`,
 * unchanged from before this ticket; only once `titleLinkSegments` finds
 * an actual link does this split the title and run `inlineProse` on each
 * plain-text segment around it, splicing in a real `<a>` for the link
 * segment.
 *
 * Known, accepted limitation: formatting that SPANS a link boundary
 * (`**bold [text](url) still bold**`) won't join back up across the
 * split — each segment is parsed independently, so a `**` left open on
 * one side of a link and closed on the other renders as a literal
 * asterisk rather than as bold. Todoist's own title field can't produce
 * that combination at all (no bold syntax there in the first place), so
 * there's no measured behaviour to match either way; flagged here rather
 * than silently accepted.
 *
 * The link's `<a>` itself — `target="_blank"`, `rel="noopener noreferrer"`,
 * the underline styling — is `inline-prose.tsx`'s own `case "link"` shape,
 * reused for visual consistency with every other link this app renders.
 * Its PARSER isn't reusable for the SPLIT, though: `inline-prose.tsx`
 * reads `parseInlineMarkdown` (ADR 0041), whose `Link` construct is
 * deliberately removed from the journal's own dialect (`inline-
 * markdown.ts`'s own module comment — `[label](url)` is not in that mark
 * set, on either the Entry or the Comment side), so it never recognises
 * `[text](url)` at all. `titleLinkSegments` (`@/lib/task-title-links`,
 * deliberately its own module — that file's own header comment explains
 * why it isn't in `task-title-editor.tsx`) is a Task title's own, much
 * narrower grammar for finding where the links are; `inlineProse` is still
 * what renders everything around them, exactly as it always has. A
 * malformed or empty-part link (`[]()`, `[x]()`, `[](y)`) comes back as an
 * ordinary text segment from `titleLinkSegments` — nothing here has to
 * special-case it separately.
 *
 * `onClick`'s `stopPropagation` matters here specifically: every caller
 * renders a title inside its own clickable container (`task-row-
 * content.tsx`'s row button opens the detail view; `task-detail-view.tsx`'s
 * title `div` starts editing) — without stopping the click from bubbling,
 * opening the link would also fire whichever of those the title normally
 * triggers (issue #398's own acceptance criterion). `stopPropagation`
 * alone is enough: it only stops the event bubbling to that ancestor
 * listener, not the anchor's own native navigation.
 */
export function taskTitleText(title: string): ReactNode {
  const segments = titleLinkSegments(title);
  const hasLink = segments.some((segment) => segment.href !== undefined);
  if (!hasLink) {
    return inlineProse(title);
  }
  return segments.map((segment, index) =>
    segment.href === undefined ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one title for one render.
      <span key={index}>{inlineProse(segment.text)}</span>
    ) : (
      <a
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one title for one render.
        key={index}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
        onClick={(event) => event.stopPropagation()}
      >
        {segment.text}
      </a>
    ),
  );
}
