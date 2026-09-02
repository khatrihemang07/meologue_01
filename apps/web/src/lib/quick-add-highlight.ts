/**
 * The add field's live highlight and click-to-demote (issue #170's Part
 * D, redesigned by issue #179's Part A) — pure logic, kept free of React
 * and the DOM for the identical reason composer-picker.ts's own header
 * comment gives for the `[[` picker: a caret index and a plain string are
 * what a component test can drive without mounting anything, and every
 * rule that decides "is this span still highlighted, and how" belongs in
 * one function a reader can read top to bottom rather than split across a
 * change handler and a click handler. add-task-form.tsx and
 * composer-editor.ts's `checklistHighlightPlugin` are this module's two
 * callers — two of this app's three live-token surfaces (composer-
 * picker.ts's `[[` picker and composer-slash.ts's `/` menu are the
 * others), and both borrow the identical shape: derive state fresh from
 * the current text (and caret) on every keystroke, never patch it
 * incrementally.
 */
import type {
  QuickAddOptions,
  QuickAddResult,
  QuickAddToken,
  QuickAddTokenKind,
} from "@meologue/core";
import { parseQuickAdd } from "@meologue/core";

/**
 * A demoted token's identity, for surviving further typing — see
 * `demotedTokenSet`'s own doc comment for the rule this exists to
 * implement and why it's text-keyed rather than offset-keyed.
 */
export type DemotedSignature = string;

/**
 * `${kind}:${raw, lower-cased}` — kind is included because two different
 * token families can in principle share the same literal text (a bare
 * recurrence word and an ordinary description word, say), and lower-casing
 * matches ../../packages/core/src/quick-add/date-rules.ts's own
 * case-insensitive matching (every regex there carries the `i` flag), so
 * demoting "Monday" also covers a later "monday".
 */
export function tokenSignature(token: Pick<QuickAddToken, "kind" | "raw">): DemotedSignature {
  return `${token.kind}:${token.raw.toLowerCase()}`;
}

/**
 * Parses `input`, honouring a caller's set of previously-demoted token
 * signatures rather than `QuickAddOptions.demoted`'s own offset-keyed
 * spans directly.
 *
 * **The rule this exists to implement, and why offsets were rejected.**
 * The brief (170-brief.md's Part D) asks for demotion to "survive further
 * typing in a way that makes sense." A demoted *span* — the literal
 * `[start, end)` pair `demoteQuickAddToken` (../../packages/core/src/
 * quick-add/parse-quick-add.ts) hands back — only makes sense against the
 * exact string it was computed from: insert one character before it and
 * every offset after that point shifts, so the stored span now points at
 * the wrong text, or at nothing a token could occupy at all, and the word
 * the reader demoted springs back to being highlighted the next time they
 * type anywhere earlier in the line. Re-deriving the shift on every edit
 * (diffing old and new text, walking every live demotion's span forward
 * or backward by the edit's length) is exactly the incremental-patching
 * this module's own header comment already rejects for the picker/menu
 * shape, and is considerably harder here: `derivePicker`/`deriveSlashMenu`
 * only ever track one open span at a time, this tracks an unbounded set
 * of them.
 *
 * Tracking by signature instead sidesteps the whole problem: a demotion
 * is "this literal word, wherever it appears in this input," not "the
 * text that used to be at these coordinates." Typing anywhere else in the
 * line — before the demoted word, after it, adding a second occurrence of
 * the identical word elsewhere — never invalidates it, because nothing
 * here is coordinate-dependent. The one case this rule reads as
 * "un-demoting" is deliberate, not a gap: editing the demoted word ITSELF
 * into different text changes its signature, so there is no reason left
 * to keep suppressing a span that no longer contains what the reader
 * demoted in the first place.
 */
export function parseWithDemotions(
  input: string,
  options: QuickAddOptions,
  demotedSignatures: ReadonlySet<DemotedSignature>,
): QuickAddResult {
  // The natural parse — nothing demoted — is also exactly the set of
  // candidates a signature could match against; no second, parallel
  // "what would be recognised" query is needed.
  const natural = parseQuickAdd(input, options);
  if (demotedSignatures.size === 0) {
    return natural;
  }
  const demoted = natural.tokens
    .filter((token) => demotedSignatures.has(tokenSignature(token)))
    .map((token) => ({ start: token.start, end: token.end }));
  if (demoted.length === 0) {
    return natural;
  }
  return parseQuickAdd(input, { ...options, demoted });
}

/**
 * The three states a recognised token can read in, live (issue #179's own
 * report: "a reader cannot tell a resolved Date from a Label that matched
 * nothing").
 *
 * - **`"resolved"`** — the token means something real, and the caret has
 *   moved on from it. Rendered as a filled chip (see
 *   `quickAddHighlightClass`).
 * - **`"pending"`** — the caret is still inside the token, or has just
 *   landed immediately past it: the reader may still be typing it, so it
 *   reads as a lighter, provisional decoration rather than a settled
 *   chip.
 * - **`"unresolved"`** — the token's *kind* has nowhere real to land
 *   (`project`/`section` — see `NEVER_RESOLVES_KINDS` below) and never
 *   will, regardless of the caret. Rendered as plain, unstyled text:
 *   neither highlighted nor stripped from what the reader typed, so a
 *   `#Work` the add field doesn't yet wire anywhere reads exactly as
 *   honestly as it behaves.
 */
export type QuickAddHighlightState = "resolved" | "pending" | "unresolved";

/**
 * Kinds a resolved token never lands on today — `project`/`section`
 * tokens are recognised by the parser (../../packages/core/src/quick-add/
 * rules.ts) but quick-add-task.ts's own `UNSUPPORTED_TOKEN_KINDS` keeps
 * them out of every Task field: `todo-page.tsx`'s own `handleAdd` doc
 * comment says as much plainly ("the add field parses dates and
 * recurrence, not `#project` tokens"). A token whose kind can never
 * resolve is `"unresolved"` unconditionally, never `"pending"` —
 * showing a provisional decoration while typing something that will
 * never become real would promise a resolution that isn't coming.
 *
 * `label` is deliberately NOT in this set even though it shares the
 * `#`/`%` sigil shape with `project`/`section`: `use-labels.ts`'s
 * `resolveLabelIds` is a real find-or-create door onto a live Label, so a
 * completed `%label` token always resolves to something real by the time
 * Add is pressed — it only ever reads `"pending"` while the caret is
 * still inside it, exactly like every other supported kind.
 */
const NEVER_RESOLVES_KINDS: ReadonlySet<QuickAddTokenKind> = new Set(["project", "section"]);

/**
 * `token`'s live state, given where the caret currently sits (`null` when
 * nothing is focused/selected, or the field has lost focus entirely —
 * add-task-form.tsx's own `handleBlur` passes `null` for exactly that
 * reason, since nothing is being actively composed once the field is
 * blurred). "Inside or immediately after" (`> token.start && <=
 * token.end`) mirrors `tokenAtOffset`'s own "just past the word" rule
 * below for the identical reason: a caret that has moved past a token
 * without landing inside it (e.g. sitting at the very START of the
 * token, `=== token.start`) has not touched it at all.
 */
export function tokenHighlightState(
  token: Pick<QuickAddToken, "kind" | "start" | "end">,
  caretOffset: number | null,
): QuickAddHighlightState {
  if (NEVER_RESOLVES_KINDS.has(token.kind)) {
    return "unresolved";
  }
  const caretTouchesToken =
    caretOffset !== null && caretOffset > token.start && caretOffset <= token.end;
  return caretTouchesToken ? "pending" : "resolved";
}

/**
 * One run of `input`, plain or carrying a token's kind and live state, for
 * add-task-form.tsx's backdrop and composer-editor.ts's decorations to
 * render — built from `tokens`' own spans (already sorted and
 * non-overlapping, ../../packages/core/src/quick-add/parse-quick-add.ts's
 * `resolveOverlaps`), never by re-scanning `input` for a token's text
 * (this whole module's own reason for existing). An empty run (two tokens
 * with no gap between them, or a token starting at offset 0) is included
 * rather than skipped — a `<span>` with no text costs nothing to render
 * and skipping it would make the segment list's own length depend on
 * input shape in a way a caller has no reason to care about.
 *
 * `kind`/`state` are `null` together, for plain text — never `state` set
 * with `kind` `null` or vice versa, since a state only ever describes a
 * recognised token's own span.
 */
export type QuickAddHighlightSegment =
  | { text: string; kind: null; state: null }
  | { text: string; kind: QuickAddTokenKind; state: QuickAddHighlightState };

export function highlightSegments(
  input: string,
  tokens: readonly QuickAddToken[],
  caretOffset: number | null,
): QuickAddHighlightSegment[] {
  const segments: QuickAddHighlightSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    segments.push({ text: input.slice(cursor, token.start), kind: null, state: null });
    segments.push({
      text: input.slice(token.start, token.end),
      kind: token.kind,
      state: tokenHighlightState(token, caretOffset),
    });
    cursor = token.end;
  }
  segments.push({ text: input.slice(cursor), kind: null, state: null });
  return segments;
}

/** The token, if any, whose span the caret offset falls strictly inside — `add-task-form.tsx`'s click-to-demote reads the clicked `<input>`'s own `selectionStart` and looks it up here. The last character of a token (`offset === token.end`) reads as "just past the word," matching how a click there ordinarily just parks the caret after it, not inside it. */
export function tokenAtOffset(
  tokens: readonly QuickAddToken[],
  offset: number,
): QuickAddToken | undefined {
  return tokens.find((token) => offset >= token.start && offset < token.end);
}

/**
 * Kinds worth spending this app's one reserved colour on — Priority and
 * the Date family (`date`/`time`/`deadline`/`recurrence`), per issue
 * #179's own brief: "reserve colour for Priority and Dates; distinguish
 * the other kinds by chip shape and by keeping the sigil visible."
 * Every other supported kind (`label`, `reminder`, `uncompletable`,
 * `description`) reads as a resolved chip too, just a grayscale one — see
 * `quickAddHighlightClass`'s own `rounded-full` vs `rounded-[3px]` split,
 * the "chip shape" half of that same instruction. `project`/`section`
 * never reach `"resolved"` at all (`NEVER_RESOLVES_KINDS` above), so they
 * never consult this set.
 */
const COLOUR_WORTHY_KINDS: ReadonlySet<QuickAddTokenKind> = new Set([
  "date",
  "time",
  "deadline",
  "recurrence",
  "priority",
]);

/**
 * The Tailwind classes for one token's live state — `undefined` for
 * `"unresolved"`, which is deliberately unstyled (this module's own
 * `QuickAddHighlightState` doc comment: "neither highlighted nor
 * stripped"). Every class here only ever touches `background-color` and
 * `border-radius` — never padding, a border width, or a text colour —
 * because add-task-form.tsx's backdrop renders every character
 * `text-transparent` and relies on its painted characters lining up
 * pixel-for-pixel with the real, opaque `<input>` text sitting on top of
 * it (that file's own `HIGHLIGHT_BOX_CLASSES` comment explains why); a
 * property that changes a span's box width or the colour used to paint
 * its glyphs would desync the two layers or paint a second, wrong-coloured
 * copy of the text underneath the real one.
 *
 * - `"pending"` is uniform across every kind — a light, decoration-style
 *   tint (`--quick-add-pending`, index.css) — because a token still being
 *   typed hasn't earned a settled, kind-specific look yet.
 * - `"resolved"` splits in two, per this module's own `COLOUR_WORTHY_KINDS`
 *   doc comment: a colour-worthy kind gets `--quick-add-resolved-accent`
 *   (this app's one Entry accent, `--entry-accent`, reused rather than a
 *   bespoke second hue — index.css's own comment on why grayscale-plus-
 *   one-accent is the whole palette), `rounded-[3px]` like Todoist's own
 *   chip; every other supported kind gets the grayscale
 *   `--quick-add-resolved`, `rounded-full` instead — a different
 *   silhouette, not a different colour, which is what "distinguish the
 *   other kinds by chip shape" (this ticket's own brief) asks for once
 *   colour itself is off the table.
 */
export function quickAddHighlightClass(
  kind: QuickAddTokenKind,
  state: QuickAddHighlightState,
): string | undefined {
  switch (state) {
    case "unresolved":
      return undefined;
    case "pending":
      return "rounded-[3px] bg-quick-add-pending";
    case "resolved":
      return COLOUR_WORTHY_KINDS.has(kind)
        ? "rounded-[3px] bg-quick-add-resolved-accent"
        : "rounded-full bg-quick-add-resolved";
  }
}

// Exported so a caller can distinguish the eager/false-positive-prone
// family (`date`/`time`/`recurrence`) from the sigil family without
// re-deriving which kinds belong to which — ../../packages/core/src/
// quick-add/types.ts's own QuickAddTokenKind doc comment names the
// distinction. Unused by this module's own two callers today (neither
// add-task-form.tsx nor composer-editor.ts currently varies its own
// rendering by this axis — issue #179's `quickAddHighlightClass` above
// varies by "colour-worthy" instead, a different split), kept for the
// same reason it was added under issue #170: a future treatment that
// specifically calls out the false-positive-prone family has one place
// to ask the question rather than re-deriving the kind list.
export function isEagerTokenKind(kind: QuickAddTokenKind): boolean {
  return kind === "date" || kind === "time" || kind === "recurrence";
}
