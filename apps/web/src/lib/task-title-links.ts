/**
 * A Task title's own `[text](url)` grammar (issue #373) — deliberately its
 * own tiny module, not folded into `task-title-editor.tsx`. That file
 * mounts a real ProseMirror `EditorView` and is heavy enough that every
 * test touching a Task title (`task-row.test.tsx`, `task-detail-
 * view.test.tsx`, and others) replaces the whole module with a stub editor
 * component (`vi.mock("@/components/todo/task-title-editor", ...)`) —
 * issue #398's read-only title renderer (`task-title-text.tsx`) needs this
 * same regex too, and importing it from the mocked-out editor module would
 * silently break every one of those tests the moment a title renders.
 * Splitting the pure string logic out here is what lets both the editor
 * and the read-only renderer share ONE definition of "what counts as a
 * link in a title" without either one dragging the other's test surface
 * along.
 */

/** One run of a title's own text — plain, or a link's own display text plus its `href`. */
export interface TitleSegment {
  readonly text: string;
  readonly href?: string;
}

/**
 * `[text](url)` — two groups (display text, then url), the identical
 * shape `task-title-editor.tsx`'s own `linkInputRule` matches against
 * while typing, kept as one pattern here so typing, loading, and reading
 * a title can't drift apart on what counts as a link.
 */
const TITLE_MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

/**
 * Splits `text` into plain-text and link segments. `task-title-
 * editor.tsx`'s `titleDocFromText` is one caller (turns a link segment
 * into a live ProseMirror mark); `task-title-text.tsx`'s read-only title
 * renderer (issue #398) is the other (turns one into an `<a>`). A
 * malformed or empty-part link (`[]()`, `[x]()`, `[](y)`) is left as an
 * ordinary text segment — the same rule `linkInputRule` applies while
 * typing, so a title that never became a live link while it was typed
 * doesn't retroactively become one just by being read back.
 */
export function titleLinkSegments(text: string): TitleSegment[] {
  if (text.length === 0) {
    return [];
  }
  const segments: TitleSegment[] = [];
  let cursor = 0;
  TITLE_MARKDOWN_LINK.lastIndex = 0;
  let match = TITLE_MARKDOWN_LINK.exec(text);
  while (match !== null) {
    const linkText = match[1];
    const href = match[2];
    if (
      linkText !== undefined &&
      href !== undefined &&
      linkText.trim() !== "" &&
      href.trim() !== ""
    ) {
      if (match.index > cursor) {
        segments.push({ text: text.slice(cursor, match.index) });
      }
      segments.push({ text: linkText, href });
      cursor = match.index + match[0].length;
    }
    match = TITLE_MARKDOWN_LINK.exec(text);
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}
