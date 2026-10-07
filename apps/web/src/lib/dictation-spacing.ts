import type { ResolvedPos } from "prosemirror-model";

/**
 * Whether a transcript inserted at `$from` needs a leading space (issue
 * #454). Decided from the node before the caret: nothing before it (start of
 * a block) or a non-text leaf means no space; a Reference reads like a word,
 * so it does; text needs one unless it already ends in whitespace.
 */
export function dictationNeedsLeadingSpace($from: ResolvedPos): boolean {
  const before = $from.nodeBefore;
  if (before === null) {
    return false;
  }
  if (before.isText) {
    const last = before.text?.slice(-1) ?? "";
    return last !== "" && !/\s/.test(last);
  }
  return before.type.name === "reference";
}
