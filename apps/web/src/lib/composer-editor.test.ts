/**
 * Direct unit coverage for `checkboxInputRulePattern` (issue #158), the one
 * regexp in this file's input-rule set that needed fixing for a browser's
 * own whitespace normalisation. jsdom cannot mount a live ProseMirror
 * `EditorView` at all (ADR 0044, and composer-commands.test.ts's own module
 * comment), so this exercises the exported pattern directly rather than
 * typing through a real editor — a live keystroke round trip belongs in
 * apps/e2e's composer.spec.ts, which can drive a real browser.
 *
 * The other input rules built in this file (`bulletListInputRule`,
 * `orderedListInputRule`, the mark rules, `referenceInputRule`) are not
 * covered here: every one of them either matches whitespace with `\s`,
 * which already covers U+00A0 as a matter of the language's own `RegExp`
 * semantics (see the comment above `bulletListNodeType` in
 * composer-editor.ts), or never matches a literal space at all. The
 * checkbox rule was the only one matching a space through a literal
 * character class instead, which is what made it the one rule a browser's
 * own NBSP substitution could silently break.
 *
 * NBSP is built with `String.fromCharCode(0xa0)` throughout rather than
 * typed as a literal character in this source file — a literal U+00A0 is
 * visually indistinguishable from an ordinary space in an editor and in a
 * diff, which is exactly the property that makes the underlying bug
 * possible in the first place; spelling it out keeps that invisibility
 * from leaking into this file too.
 */
import { describe, expect, it } from "vitest";
import { checkboxInputRulePattern } from "./composer-editor";

const NBSP = String.fromCharCode(0xa0);

describe("checkboxInputRulePattern", () => {
  it("matches an ordinary typed space between the brackets", () => {
    expect(checkboxInputRulePattern.test("[ ] ")).toBe(true);
  });

  // The regression this exists for: without `.ProseMirror`'s own
  // `white-space: pre-wrap` (index.css, same ticket), a browser is free to
  // normalise a typed space into U+00A0 before this rule ever sees it —
  // WebKit does this far more eagerly than Chromium (ProseMirror upstream
  // issues #981 and #598). A pattern that only recognised U+0020 inside
  // the brackets left `- [ ] ` unable to ever become a checkbox on such a
  // browser, with nothing on screen to explain why.
  it("matches U+00A0 (a non-breaking space) between the brackets", () => {
    expect(checkboxInputRulePattern.test(`[${NBSP}] `)).toBe(true);
  });

  it("matches U+00A0 as the rule's own trailing whitespace too", () => {
    expect(checkboxInputRulePattern.test(`[ ]${NBSP}`)).toBe(true);
  });

  it("still matches the checked spellings, unaffected by the NBSP fix", () => {
    expect(checkboxInputRulePattern.test("[x] ")).toBe(true);
    expect(checkboxInputRulePattern.test("[X] ")).toBe(true);
  });

  it("does not match a character outside the checkbox grammar", () => {
    expect(checkboxInputRulePattern.test("[y] ")).toBe(false);
    expect(checkboxInputRulePattern.test("[] ")).toBe(false);
  });
});
