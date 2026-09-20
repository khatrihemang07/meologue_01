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

/** One recognised span, ready for either rendering (`withdrawn`/`inserted` each pick their own style) or for building `data-match-id`. */
export interface QuickAddRecognitionMatch extends QuickAddSpan {
  readonly kind: QuickAddTokenKind;
  readonly matchId: string;
  readonly withdrawn: boolean;
  /**
   * True when this span's exact `[start, end)` is in `insertedSpans` —
   * issue #411's defect 3: a date chip's calendar picker writes literal
   * words into the draft (`draft-chip-text.ts`'s own `literalDateText`,
   * by design: "the title text is the single source of truth," no hidden
   * metadata alongside it), and those words happen to be exactly what
   * `date-rules.ts` recognises as an ordinary typed match too — so
   * without this flag a picker-inserted date rendered as a fully
   * highlighted, click-to-reject-able span, indistinguishable from
   * something the reader actually typed. `insertedSpans` is transient
   * render-only state (`quickAddInsertedPlugin`'s own doc comment),
   * never stored in the text itself, so D1's "no hidden metadata" rule
   * stays true even though this flag exists.
   */
  readonly inserted: boolean;
}

export function computeQuickAddMatches(
  text: string,
  options: QuickAddOptions,
  withdrawnSpans: readonly QuickAddSpan[],
  insertedSpans: readonly QuickAddSpan[] = [],
): QuickAddRecognitionMatch[] {
  const natural = parseQuickAdd(text, options);
  return natural.tokens.map((token) => ({
    start: token.start,
    end: token.end,
    kind: token.kind,
    matchId: matchIdForToken(token, natural.date),
    withdrawn: withdrawnSpans.some((span) => span.start === token.start && span.end === token.end),
    inserted: insertedSpans.some((span) => span.start === token.start && span.end === token.end),
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

/**
 * Issue #411's own plugin key for `quickAddInsertedPlugin` below — kept
 * separate from `quickAddRecognitionPluginKey` (rather than folding
 * "inserted" into that plugin's own withdrawn-span state) so every
 * existing caller/test of `quickAddRecognitionPluginKey.getState` keeps
 * reading exactly the withdrawn-span shape it always has; a caller that
 * never mounts `quickAddInsertedPlugin` at all just sees `undefined` here
 * (`?? []` at both read sites), the same as before this ticket.
 */
export const quickAddInsertedPluginKey = new PluginKey<readonly QuickAddSpan[]>(
  "todo-quick-add-inserted",
);

/**
 * Tracks the spans a caller seeds at construction as "picker-inserted,
 * not typed" — `use-quick-add-composer.ts`'s own `remount(text,
 * insertedSpans)` is the one real caller, feeding it the date/time/
 * recurrence token span a date-chip pick just wrote (`quick-add-
 * content.tsx`'s own wrapper around `useDraftDateState`'s `onTextChange`).
 * `quickAddRecognitionPlugin`'s own `decorations` reads this plugin's
 * state (via `quickAddInsertedPluginKey`) to render a match found inside
 * one of these spans as a plain `data-match-inserted="true"` span instead
 * of the ordinary highlighted-match treatment — `QuickAddRecognitionMatch.
 * inserted`'s own doc comment has the full "why this exists" story.
 *
 * Remapped through edits with the identical `remapWithdrawnSpans` logic
 * withdrawn spans use: typing inside or right up against an inserted
 * span drops it, the same "no longer purely what the picker wrote"
 * reasoning applies to typing there too. Never grows after `init` —
 * unlike withdrawn spans (which accumulate via a later Backspace, through
 * `tr.setMeta`), a picker insertion only ever happens as part of a full
 * `composer.remount`, which tears this plugin instance down and builds a
 * fresh one with its own new initial spans; there is no mid-session
 * "insert more" event this plugin needs to react to.
 */
export function quickAddInsertedPlugin(
  initial: readonly QuickAddSpan[] = [],
): Plugin<readonly QuickAddSpan[]> {
  return new Plugin<readonly QuickAddSpan[]>({
    key: quickAddInsertedPluginKey,
    state: {
      init: (): readonly QuickAddSpan[] => initial,
      apply(tr, previous, oldState, newState): readonly QuickAddSpan[] {
        if (!tr.docChanged) {
          return previous;
        }
        return remapWithdrawnSpans(oldState.doc.textContent, newState.doc.textContent, previous);
      },
    },
  });
}

function decorationAttrs(match: QuickAddRecognitionMatch): Record<string, string> {
  if (match.inserted) {
    // Deliberately not `data-testid="natural-language-match"` and no
    // `data-match-id` — issue #411's defect 3 is explicit that this must
    // read as a DIFFERENT thing from a recognised match, not merely a
    // withdrawn one (a withdrawn span still carries both of those). A
    // plain literal the picker already wrote, nothing left to detect.
    return { nodeName: "span", "data-match-inserted": "true" };
  }
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
        const inserted = quickAddInsertedPluginKey.getState(state) ?? [];
        const matches = computeQuickAddMatches(
          state.doc.textContent,
          getOptions(),
          withdrawn,
          inserted,
        );
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
        const inserted = quickAddInsertedPluginKey.getState(state) ?? [];
        const matches = computeQuickAddMatches(
          state.doc.textContent,
          getOptions(),
          withdrawn,
          inserted,
        );
        // `!match.inserted` too — a picker-inserted span already renders
        // plain (`decorationAttrs`'s own `inserted` branch), so there is
        // no highlight here for Backspace to cancel; without this guard
        // this handler would still find it "active," dispatch a pointless
        // withdrawal, and `preventDefault()` a keystroke that should have
        // just deleted the character in front of the caret like any other
        // plain text.
        const active = matches.find(
          (match) => !match.withdrawn && !match.inserted && match.end === caret,
        );
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
      // Issue #371: porting only the *technique* of `composer-editor.ts`'s
      // `checklistHighlightPlugin.handleClick` — find the token at the
      // clicked position, dispatch, `return false` so ProseMirror still
      // resolves the click and places the caret there itself (confirmed on
      // a real device: a click both cancels the highlight AND leaves
      // `selection.isCollapsed`, the same as an ordinary click would).
      //
      // NOT porting that plugin's demotion *model*. It keys a demotion by
      // `tokenSignature` — text-and-kind — so demoting one "Monday" would
      // demote every later "Monday" too (D14/#371's own ticket calls this
      // out explicitly). This plugin's `apply` above already keys by the
      // edited region's own span instead, and nothing measured about
      // Todoist supports the stronger, signature-keyed claim, so this stays
      // on the existing model — `{start, end}` is exactly the meta shape
      // Backspace already sets above, so `apply()` needs no change at all.
      handleClick(view, pos) {
        const { state } = view;
        const withdrawn = quickAddRecognitionPluginKey.getState(state) ?? [];
        const inserted = quickAddInsertedPluginKey.getState(state) ?? [];
        const matches = computeQuickAddMatches(
          state.doc.textContent,
          getOptions(),
          withdrawn,
          inserted,
        );
        // Exclusive end (`pos < match.end`), matching Backspace's own
        // boundary above and `quick-add-highlight.ts`'s `tokenAtOffset`
        // precedent: a click exactly past a match's last character reads
        // as "just after the word," not "inside" it. `!match.inserted`
        // too, for the identical reason Backspace's own handler above
        // excludes it: a picker-inserted span already renders plain, so
        // there is nothing here for a click to reject.
        const active = matches.find(
          (match) => !match.withdrawn && !match.inserted && pos >= match.start && pos < match.end,
        );
        if (active === undefined) {
          return false;
        }
        view.dispatch(
          view.state.tr.setMeta(quickAddRecognitionPluginKey, {
            start: active.start,
            end: active.end,
          }),
        );
        return false;
      },
    },
  });
}
