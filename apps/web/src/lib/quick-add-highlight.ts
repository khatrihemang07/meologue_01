/**
 * The add field's live highlight and click-to-demote (issue #170's Part
 * D) — pure logic, kept free of React and the DOM for the identical
 * reason composer-picker.ts's own header comment gives for the `[[`
 * picker: a caret index and a plain string are what a component test can
 * drive without mounting anything, and every rule that decides "is this
 * span still highlighted" belongs in one function a reader can read top
 * to bottom rather than split across a change handler and a click
 * handler. add-task-form.tsx is this module's one caller — the third
 * live-token surface this app has (composer-picker.ts's `[[` picker,
 * composer-slash.ts's `/` menu, and this), and it borrows the identical
 * shape: derive state fresh from the current text on every keystroke,
 * never patch it incrementally.
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
 * token families can share the same literal text (`"for"` could in
 * principle open a duration clause in one input and be plain content in
 * another once one is demoted and the other isn't), and lower-casing
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

/** One run of `input`, plain or highlighted, for add-task-form.tsx's backdrop to render as a `<span>` — built from `tokens`' own spans (already sorted and non-overlapping, ../../packages/core/src/quick-add/parse-quick-add.ts's `resolveOverlaps`), never by re-scanning `input` for a token's text (this whole module's own reason for existing). An empty run (two tokens with no gap between them, or a token starting at offset 0) is included rather than skipped — a `<span>` with no text costs nothing to render and skipping it would make the segment list's own length depend on input shape in a way a caller has no reason to care about. */
export interface QuickAddHighlightSegment {
  text: string;
  highlighted: boolean;
}

export function highlightSegments(
  input: string,
  tokens: readonly QuickAddToken[],
): QuickAddHighlightSegment[] {
  const segments: QuickAddHighlightSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    segments.push({ text: input.slice(cursor, token.start), highlighted: false });
    segments.push({ text: input.slice(token.start, token.end), highlighted: true });
    cursor = token.end;
  }
  segments.push({ text: input.slice(cursor), highlighted: false });
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
 * One shared highlight treatment for every recognised token, rather than
 * a colour per `QuickAddTokenKind` — this app's own palette
 * (index.css's `--primary`/`--accent`/etc.) is grayscale-plus-one-accent
 * by design (settings.ts's Accent setting is the one place a reader picks
 * a hue at all), and a bespoke rainbow of token colours here would be a
 * second, uncoordinated colour language next to it. `--primary` already
 * means "this is the one thing on the row that matters" everywhere else
 * in this app (Button's own `default` variant); reusing it for "the
 * parser noticed this" keeps that meaning rather than inventing a new one.
 */
export const QUICK_ADD_HIGHLIGHT_CLASS = "rounded-[3px] bg-primary/15";

// Exported only so a future per-kind treatment (say, a visibly different
// underline for the eager family that carries the false-positive risk
// versus the sigil family that doesn't — ../../packages/core/src/
// quick-add/types.ts's own QuickAddTokenKind doc comment names the
// distinction) has one place to add it without re-deriving which kinds
// exist. Unused today; kept alongside QUICK_ADD_HIGHLIGHT_CLASS rather
// than deleted, since the type import above would otherwise be dead too.
export function isEagerTokenKind(kind: QuickAddTokenKind): boolean {
  return kind === "date" || kind === "time" || kind === "recurrence";
}
