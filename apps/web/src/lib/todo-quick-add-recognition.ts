/**
 * Positional recognition with two-step withdrawal — issue #226's own
 * second half, and the behaviour the whole programme exists to fix
 * (meologue-reference/todoist/quick-add.md § "The one fact that decides the
 * implementation" and § "Recognition and withdrawal"). This is Todo's OWN
 * recognition module — a sibling of `quick-add-highlight.ts`, not a
 * replacement for it: that file stays untouched because it is shared with
 * the Composer's checklist highlighting (`composer-editor.ts`'s
 * `checklistHighlightPlugin`), and this module's own withdrawal semantics
 * (below) are deliberately different from `parseWithDemotions`'
 * signature-keyed demotion, so folding the two together would either
 * change the Composer's behaviour or force this module to inherit a model
 * it doesn't want.
 *
 * **Why positional, not signature-keyed.** `quick-add-highlight.ts`'s own
 * header comment explains why the Composer tracks a demotion by the
 * token's TEXT ("this literal word, wherever it appears") rather than its
 * offset — a demotion there is meant to survive indefinitely, reapplied
 * fresh on every keystroke via `parseWithDemotions`' signature lookup.
 * Withdrawal here is the opposite on purpose (QA-07, "withdrawal is not
 * sticky... not remembered against the word"): it names one exact `[start,
 * end)` occurrence, and a caller never needs to re-find it by text because
 * `QuickAddOptions.demoted` (../../packages/core/src/quick-add/types.ts)
 * already speaks in exactly those coordinates — `demoteQuickAddToken`'s
 * own doc comment is the "usual way" this seam is meant to be driven. This
 * module builds on it directly rather than reshaping it.
 *
 * **Remapping across edits.** `remapWithdrawnSpans` below re-derives every
 * withdrawn span's position after a text change by a common-prefix /
 * common-suffix diff between the previous and next text — exact for a
 * single keystroke, which is every keystroke a real editor ever applies in
 * one transaction. A span entirely outside the edited region shifts by the
 * edit's own length delta and survives; a span that OVERLAPS the edited
 * region — including a span whose boundary sits immediately against the
 * edit, not only one whose interior characters changed — is dropped, so
 * recognition returns. The boundary-inclusive rule (a `<`/`>` comparison,
 * not `<=`/`>=`) is deliberate and pinned by
 * `meologue-reference/todoist/quick-add-dom/retype-04-back-to-tod-after-x.json`:
 * typing `x` right after a withdrawn `tod` (making `todx`, itself
 * unrecognised) and then backspacing that `x` away again lands back on
 * `tod` fully re-highlighted, not still-withdrawn, even though `tod`'s own
 * three characters were never themselves touched by either edit. A
 * same-or-past-the-boundary edit reads as "this occurrence has moved on,"
 * matching that capture; a span with real untouched distance on both
 * sides of the edit (the common case of typing elsewhere in a longer
 * line) is left alone.
 */
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

/**
 * `data-match-id`'s value (meologue-reference/todoist/quick-add.md § "The
 * recognised-match span": "carries the resolved value, not the typed
 * text"). Only the date/time family was ever actually measured against
 * the live application; every other kind's rendering here is a direct,
 * honest read of the one resolved field `QuickAddToken` already carries
 * for it, not a second normalisation pass — `recurrence` in particular
 * does NOT reproduce quick-add-task.ts's own `RECURRENCE_WORD_TO_PHRASE`
 * (`daily` -> "every day"): that table is private to field resolution at
 * submit time, and duplicating it here for a decorative attribute would
 * be a second place it could drift from the first. A recurring word's
 * `matchId` is therefore its own raw text, lower-cased for the same
 * case-insensitivity every other rule in this app already applies.
 *
 * `resolvedDateTime` is `QuickAddResult.date` from the very same parse —
 * the merged date-and-time value ../../packages/core/src/quick-add/
 * parse-quick-add.ts's `mergeDateAndTime` already computes for the whole
 * input, including its "a lone time with no date word attaches to
 * today" rule. QA-10's own measured gap: a `"time"` token's `matchId`
 * used to be the bare `token.time` (`"17:00"`), where Todoist's bundles
 * the resolved day in (`"12 Sep 5:00 PM"`) — a time-only phrase implies
 * a day in Todoist, and now does here too. Only the `"time"` case reads
 * this parameter; every other kind ignores it, so passing it through
 * unconditionally from `computeQuickAddMatches` costs nothing.
 */
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

/**
 * Every span the parser recognises in `text` right now, each marked
 * `withdrawn` if its exact `[start, end)` is in `withdrawnSpans` — always
 * derived from the NATURAL parse (no `demoted` option passed to
 * `parseQuickAdd`), never from a demotion-aware reparse.
 *
 * **Deliberately not `parseQuickAdd(text, { ...options, demoted:
 * withdrawnSpans })`.** Demoting a span the ordinary way removes it from
 * `result.tokens` entirely — right for the Composer's checklist highlight,
 * which has nothing left to render once a token is demoted, but wrong
 * here: meologue-reference/todoist/quick-add.md's own measurement is that a
 * withdrawn match is "one element in two visual states," the span STAYS
 * in the document, restyled — not removed and then, confusingly, not
 * re-created either. Reading matches off the natural parse and checking
 * `withdrawnSpans` membership separately is what keeps the withdrawn
 * span's own identity (kind, matchId, position) available to render, and
 * it sidesteps `resolveOverlaps`' own documented cascade concern
 * (../../packages/core/src/quick-add/parse-quick-add.ts: "a demoted span
 * simply stops competing") entirely — nothing here ever asks the parser to
 * treat a withdrawn span as competable content, so no shorter, previously
 * shadowed candidate can spring up in its place. That cascade is real for
 * `quick-add-task.ts`'s own field resolution at submit time (which DOES
 * pass `demoted` through in the ordinary way, deliberately), just not for
 * what gets drawn on screen.
 */
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

/**
 * `Decoration.inline`'s own DOM attributes for one match. Highlighted and
 * withdrawn deliberately differ by more than a class: Todoist's own
 * captured DOM (meologue-reference/todoist/quick-add-dom/tod-04-bksp1.json)
 * drops `data-highlighted-match` AND the styling class outright once
 * withdrawn, leaving a bare, unstyled `<span>` — which is exactly what an
 * ordinary `<span>` with no class already renders as (`display: inline`,
 * no padding, no background, inherited colour — the withdrawn row of that
 * file's own property table), so no withdrawn-specific CSS is needed at
 * all here, only the absence of the highlighted one.
 *
 * **`nodeName` — QA-06's tiebreak, strict DOM parity (decided
 * 2026-09-12).** A recognised span is a `Decoration.inline` wrapping a
 * plain text node, not an atom node of its own — for exactly that shape,
 * `prosemirror-view` decides whether to reuse or recreate the wrapping
 * `<span>` in `patchOuterDeco`
 * (node_modules/prosemirror-view/dist/index.js:1699-1723), by walking
 * `computeOuterDeco`'s per-level `OuterDecoLevel.nodeName` STRINGS
 * (index.js:1673-1698) and reusing the existing element whenever level i's
 * label is `===` between renders (the `prev.nodeName == deco.nodeName`
 * check at index.js:1708). That check runs whether or not the decoration
 * even changed — `updateOuterDeco` only skips it when `sameOuterDeco`
 * finds the two decoration arrays' own `InlineType.eq` equal
 * (index.js:1486-1491, `sameOuterDeco` at 1756-1763, `InlineType.eq` at
 * 3999-4004 comparing `attrs`/`spec` via `compareObjs`) — attrs already
 * differ here (the two keys above), so that check does NOT short-circuit;
 * `patchOuterDeco` still runs and still reuses the span, because leaving
 * `nodeName` unset makes BOTH states fall through to the identical
 * implicit "span" fallback (`computeOuterDeco`'s `needsWrap &&
 * result.length == 1` branch, index.js:1687-1688) — the two label strings
 * are equal, so the existing wrapper is kept and only patched
 * (`patchAttributes`, index.js:1724-1751). That is exactly QA-06's
 * measured divergence: Todoist replaces the node on withdrawal (a
 * `childList` mutation swaps in a fresh `SPAN[data-testid=
 * natural-language-match]`), meologue restyled the same one (`attributes`
 * mutations only) — see meologue-reference/todoist/parity-ledger.md's QA-06
 * row and its tiebreak artifacts.
 *
 * Setting `nodeName` explicitly, to a STRING that differs between the two
 * states, is what breaks the label match and forces `patchOuterDeco` to
 * build a fresh element — `document.createElement(deco.nodeName)`
 * (index.js:1713) — instead of reusing the held one. Using `"span"` for
 * highlighted and `"SPAN"` for withdrawn keeps the actual rendered
 * element identical: an HTML document ASCII-lowercases whatever tag name
 * `createElement` is given (confirmed against this repo's own jsdom), so
 * both produce a real, indistinguishable `<span>` — only the JS string
 * ProseMirror diffs differs. `nodeName` itself is never emitted as a DOM
 * attribute (`computeOuterDeco`'s `else if (name != "nodeName")` guard,
 * index.js:1693; `patchAttributes`'s own `name != "nodeName"` guard,
 * index.js:1726/1729), so this is invisible to anything reading the
 * rendered markup.
 */
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
      /**
       * The two-step withdrawal itself (QA-04/QA-05). On the FIRST
       * Backspace after a match — collapsed selection, caret exactly at a
       * currently-highlighted (not already withdrawn) match's own `end` —
       * this consumes the keystroke, records that span as withdrawn via a
       * no-op transaction (`tr.setMeta`, carrying no document change: `tr`
       * is never told to delete anything), and calls `preventDefault()`:
       * no character is deleted, matching the measured 32.31px ->
       * 24.31px width change with the text itself unchanged. On the
       * SECOND press `computeQuickAddMatches` no longer reports a
       * non-withdrawn match ending at the caret (this module's own
       * `computeQuickAddMatches` doc comment: matches are keyed off the
       * NATURAL parse, but a span already in `withdrawn` never matches
       * the `!match.withdrawn` check below), so this returns `false`
       * without calling `preventDefault()` and `keymap(baseKeymap)`
       * — registered AFTER this plugin, task-title-editor.tsx's own
       * `buildTitlePlugins` — deletes the character normally.
       */
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
