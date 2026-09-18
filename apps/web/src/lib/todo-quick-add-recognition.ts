import type {
  QuickAddOptions,
  QuickAddSpan,
  QuickAddToken,
  QuickAddTokenKind,
} from "@meologue/core";
import { parseQuickAdd, uiPriorityOf } from "@meologue/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** The number of leading UTF-16 code units `a` and `b` share. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i++;
  }
  return i;
}

/** The number of trailing UTF-16 code units `a` and `b` share. */
function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i++;
  }
  return i;
}

/**
 * Remaps `previousSpans` (positions against `previousText`) onto
 * `nextText` — this module's own header comment carries the full
 * reasoning for the algorithm and its boundary rule. Returns a fresh
 * array; `previousSpans` itself is never mutated.
 */
export function remapWithdrawnSpans(
  previousText: string,
  nextText: string,
  previousSpans: readonly QuickAddSpan[],
): QuickAddSpan[] {
  if (previousSpans.length === 0 || previousText === nextText) {
    return previousSpans.slice();
  }
  const prefixLen = commonPrefixLength(previousText, nextText);
  const suffixLen = commonSuffixLength(previousText.slice(prefixLen), nextText.slice(prefixLen));
  const oldEditEnd = previousText.length - suffixLen;
  const delta = nextText.length - previousText.length;
  const remapped: QuickAddSpan[] = [];
  for (const span of previousSpans) {
    if (span.end < prefixLen) {
      // Entirely before the edit, with a real gap — untouched, same
      // coordinates in both texts.
      remapped.push(span);
    } else if (span.start > oldEditEnd) {
      // Entirely after the edit, with a real gap — untouched content,
      // shifted by however much the edit changed the text's length.
      remapped.push({ start: span.start + delta, end: span.end + delta });
    }
    // Otherwise the span touches or overlaps the edited region — its own
    // occurrence has moved on, so it is dropped and recognition returns.
  }
  return remapped;
}

export function matchIdForToken(token: QuickAddToken, resolvedDateTime: string | null): string {
  switch (token.kind) {
    case "date":
      return token.date;
    case "time":
      // `resolvedDateTime` is guaranteed non-null whenever a "time" token
      // exists — `mergeDateAndTime` only returns `null` when there is no
      // time at all — but `token.time` is kept as a defensive fallback
      // rather than asserting that guarantee with a non-null assertion.
      return resolvedDateTime ?? token.time;
    case "deadline":
      return token.deadline;
    case "priority":
      // `token.priority` is the STORED 1-4 (../../packages/core/src/quick-add/
      // types.ts's own doc comment on `priority`); the identifier is meant
      // to read as Todoist's own p1-p4, which is the UI scale, so this
      // crosses the inversion via `uiPriorityOf` rather than emitting the
      // stored number directly.
      return `P${uiPriorityOf(token.priority)}`;
    case "project":
      return token.name;
    case "section":
      return token.name;
    case "label":
      return token.name;
    case "reminder":
      return token.time ?? token.raw;
    case "uncompletable":
      return "uncompletable";
    case "description":
      return token.text;
    case "recurrence":
      return token.raw.toLowerCase();
  }
}

/** One recognised span, ready for either rendering (`withdrawn` picks the two-state style) or for building `data-match-id`. */
export interface QuickAddRecognitionMatch extends QuickAddSpan {
  readonly kind: QuickAddTokenKind;
  readonly matchId: string;
  readonly withdrawn: boolean;
}

export function computeQuickAddMatches(
  text: string,
  options: QuickAddOptions,
  withdrawnSpans: readonly QuickAddSpan[],
): QuickAddRecognitionMatch[] {
  const natural = parseQuickAdd(text, options);
  return natural.tokens.map((token) => ({
    start: token.start,
    end: token.end,
    kind: token.kind,
    matchId: matchIdForToken(token, natural.date),
    withdrawn: withdrawnSpans.some((span) => span.start === token.start && span.end === token.end),
  }));
}

/**
 * The ProseMirror decoration + keymap plugin `TaskTitleEditor`'s
 * `extraPlugins` seam takes (task-title-editor.tsx's own header comment
 * names this exact seam and why registering before `keymap(baseKeymap)`
 * matters: a plugin's own `handleKeyDown` for Backspace must be asked
 * before `baseKeymap`'s ordinary Backspace).
 *
 * `getOptions` is a callback, not a fixed `QuickAddOptions` value, because
 * `extraPlugins` is read once at mount (task-title-editor.tsx's own doc
 * comment) while `now`/`smartDates` are live — add-task-form.tsx keeps
 * both in a ref and hands this plugin `() => ref.current` so a decoration
 * computed mid-session (a `smartDates` toggle, a date rollover at
 * midnight) reads the current value rather than whatever was true at
 * mount.
 */
export const quickAddRecognitionPluginKey = new PluginKey<readonly QuickAddSpan[]>(
  "todo-quick-add-recognition",
);

function decorationAttrs(match: QuickAddRecognitionMatch): Record<string, string> {
  const attrs: Record<string, string> = {
    nodeName: match.withdrawn ? "SPAN" : "span",
    "data-testid": "natural-language-match",
    "data-match-id": match.matchId,
  };
  if (!match.withdrawn) {
    attrs["data-highlighted-match"] = "true";
    attrs.class = "td-recognition-match";
  }
  return attrs;
}

export function quickAddRecognitionPlugin(
  getOptions: () => QuickAddOptions,
): Plugin<readonly QuickAddSpan[]> {
  return new Plugin<readonly QuickAddSpan[]>({
    key: quickAddRecognitionPluginKey,
    state: {
      init: (): readonly QuickAddSpan[] => [],
      apply(tr, previous, oldState, newState): readonly QuickAddSpan[] {
        let withdrawn = previous;
        if (tr.docChanged) {
          withdrawn = remapWithdrawnSpans(
            oldState.doc.textContent,
            newState.doc.textContent,
            withdrawn,
          );
        }
        const newlyWithdrawn = tr.getMeta(quickAddRecognitionPluginKey) as QuickAddSpan | undefined;
        if (newlyWithdrawn !== undefined) {
          withdrawn = [...withdrawn, newlyWithdrawn];
        }
        return withdrawn;
      },
    },
    props: {
      decorations(state) {
        const withdrawn = quickAddRecognitionPluginKey.getState(state) ?? [];
        const matches = computeQuickAddMatches(state.doc.textContent, getOptions(), withdrawn);
        const decorations = matches.map((match) =>
          // `inclusiveStart`/`inclusiveEnd: false`, explicit rather than
          // relying on the library default — a real-browser defect found
          // after this file's first pass: typing right at a match's own
          // boundary (e.g. the space after "tod" in "tod p1") must never
          // be absorbed into the decorated range, or the caret ends up
          // trapped at the boundary and the next keystroke lands one
          // position too early, corrupting the text ("tod p1" ->
          // "todp1"). Exclusive on both ends is what lets typing
          // immediately continue past a match normally.
          Decoration.inline(match.start, match.end, decorationAttrs(match), {
            inclusiveStart: false,
            inclusiveEnd: false,
          }),
        );
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        if (event.key !== "Backspace") {
          return false;
        }
        const { state } = view;
        if (!state.selection.empty) {
          return false;
        }
        const caret = state.selection.from;
        const withdrawn = quickAddRecognitionPluginKey.getState(state) ?? [];
        const matches = computeQuickAddMatches(state.doc.textContent, getOptions(), withdrawn);
        const active = matches.find((match) => !match.withdrawn && match.end === caret);
        if (active === undefined) {
          return false;
        }
        view.dispatch(
          view.state.tr.setMeta(quickAddRecognitionPluginKey, {
            start: active.start,
            end: active.end,
          }),
        );
        event.preventDefault();
        return true;
      },
    },
  });
}
