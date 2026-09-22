import { describe, expect, it } from "vitest";
import { parseThemeTokens, resolveToken } from "@/test/css-tokens";
import { readIndexCss } from "@/test/read-index-css.mjs";

/**
 * Issue #436's own spec review: every other test in this file's sibling
 * `task-schedule-popover.test.tsx` only ever proves a `--td-*` token is
 * WIRED (the class/style string on an element names it) — none of them
 * proves the token itself carries the right rgb triplet, so a wrong
 * colour in `index.css` would ship green. This reads the real stylesheet
 * bytes (`readIndexCss`, `@/test/read-index-css.mjs`'s own header comment
 * on why that needs a plain `.mjs` module rather than an ordinary import)
 * and checks the MEASURED numbers themselves, in both themes, so a typo
 * or a wrong-theme swap fails here rather than only being catchable by a
 * side-by-side screenshot.
 */
describe("index.css — issue #436's date-picker frame tokens (measured values)", () => {
  const { light, dark } = parseThemeTokens(readIndexCss());

  it("card width and height cap", () => {
    expect(light.get("--td-popover-width")).toBe("250px");
    // A CEILING (`max-height`), not a floor — this token's own comment in
    // index.css has the full real-browser story (issue #436's own
    // follow-up pass). Theme-independent: layout, not colour.
    expect(light.get("--td-popover-max-height")).toBe("555px");
  });

  it("card border — transparent in light (no visible border), the measured rgb(61,61,61) in dark", () => {
    expect(resolveToken(light, "--td-popover-border")).toBe("transparent");
    expect(resolveToken(dark, "--td-popover-border")).toBe("rgb(61, 61, 61)");
  });

  it("card shadow — the two measured elevations, one per theme, not one literal shared by both", () => {
    expect(resolveToken(light, "--td-popover-shadow")).toBe(
      "0 1px 8px 0 rgba(0, 0, 0, 0.08), 0 0 1px 0 rgba(0, 0, 0, 0.3)",
    );
    expect(resolveToken(dark, "--td-popover-shadow")).toBe(
      "0 10px 20px 0 rgba(0, 0, 0, 0.19), 0 6px 6px 0 rgba(0, 0, 0, 0.23)",
    );
  });

  it("card background — white in light, the measured rgb(38,38,38) in dark", () => {
    expect(resolveToken(light, "--td-popover-background")).toBe("rgb(255, 255, 255)");
    expect(resolveToken(dark, "--td-popover-background")).toBe("rgb(38, 38, 38)");
  });

  it("divider", () => {
    expect(light.get("--td-popover-divider")).toBe("rgb(238, 238, 238)");
    expect(dark.get("--td-popover-divider")).toBe("rgb(61, 61, 61)");
  });

  it("input text/placeholder", () => {
    expect(light.get("--td-schedule-input-text")).toBe("rgb(32, 32, 32)");
    expect(light.get("--td-schedule-input-placeholder")).toBe("rgb(153, 153, 153)");
    expect(dark.get("--td-schedule-input-text")).toBe("rgb(255, 255, 255)");
    expect(dark.get("--td-schedule-input-placeholder")).toBe("rgb(128, 128, 128)");
  });

  it("quick-option label/hint/hover", () => {
    expect(light.get("--td-schedule-option-label")).toBe("rgb(32, 32, 32)");
    expect(light.get("--td-schedule-option-hint")).toBe("rgb(128, 128, 128)");
    expect(light.get("--td-schedule-option-hover")).toBe("rgb(243, 243, 243)");
    expect(dark.get("--td-schedule-option-label")).toBe("rgb(255, 255, 255)");
    expect(dark.get("--td-schedule-option-hint")).toBe("rgb(204, 204, 204)");
    expect(dark.get("--td-schedule-option-hover")).toBe("rgb(54, 54, 54)");
  });

  it("quick-option icon colours", () => {
    expect(light.get("--td-schedule-today")).toBe("rgb(75, 146, 68)");
    expect(light.get("--td-schedule-tomorrow")).toBe("rgb(173, 98, 0)");
    expect(light.get("--td-schedule-this-weekend")).toBe("rgb(36, 111, 224)");
    expect(light.get("--td-schedule-next-week")).toBe("rgb(105, 46, 194)");
    expect(light.get("--td-schedule-no-date")).toBe("rgb(128, 128, 128)");

    expect(dark.get("--td-schedule-today")).toBe("rgb(28, 140, 58)");
    expect(dark.get("--td-schedule-tomorrow")).toBe("rgb(235, 134, 0)");
    expect(dark.get("--td-schedule-this-weekend")).toBe("rgb(41, 126, 255)");
    expect(dark.get("--td-schedule-next-week")).toBe("rgb(145, 71, 255)");
    expect(dark.get("--td-schedule-no-date")).toBe("rgb(128, 128, 128)");
  });

  // Issue #436's own follow-up: "Later this week" is Next week's violet,
  // not Tomorrow's orange (this ticket's own first guess, retired once a
  // real-browser side-by-side checked it) — resolved through its `var()`
  // reference rather than read as a raw string, so this fails exactly the
  // way it would if a future edit pointed the reference at the wrong
  // family again, not only if the literal text of the reference changes.
  it("'Later this week' resolves to Next week's own violet, in both themes", () => {
    expect(resolveToken(light, "--td-schedule-later-this-week")).toBe(
      resolveToken(light, "--td-schedule-next-week"),
    );
    expect(resolveToken(light, "--td-schedule-later-this-week")).toBe("rgb(105, 46, 194)");
    expect(resolveToken(dark, "--td-schedule-later-this-week")).toBe(
      resolveToken(dark, "--td-schedule-next-week"),
    );
    expect(resolveToken(dark, "--td-schedule-later-this-week")).toBe("rgb(145, 71, 255)");
  });

  it("Time/Repeat field border/text", () => {
    expect(light.get("--td-schedule-field-border")).toBe("rgb(230, 230, 230)");
    expect(light.get("--td-schedule-field-text")).toBe("rgb(102, 102, 102)");
    expect(dark.get("--td-schedule-field-border")).toBe("rgb(61, 61, 61)");
    expect(dark.get("--td-schedule-field-text")).toBe("rgb(209, 209, 209)");
  });
});

/**
 * Issue #437's own measured pair — the Todoist top bar's constant 1px
 * bottom border, Today/Upcoming's mouse-only scroll chrome. Not
 * `--border` (light `rgb(224, 224, 224)`, dark `rgb(61, 61, 61)`): both
 * measured values are distinct from the app's generic divider, the
 * identical "measured separately, don't assume it matches a nearby
 * existing token" call `--td-overdue-reschedule`'s own comment already
 * makes for a colour close enough to tempt reuse.
 */
describe("index.css — issue #437's Todoist top bar (measured values)", () => {
  const { light, dark } = parseThemeTokens(readIndexCss());

  it("bottom border", () => {
    expect(light.get("--td-topbar-border")).toBe("rgb(245, 245, 245)");
    expect(dark.get("--td-topbar-border")).toBe("rgb(40, 40, 40)");
  });
});

/**
 * Issue #438's own hover-strip tokens, both driven live against Todoist:
 * light icon `rgb(128, 128, 128)`, light per-button hover background
 * `rgb(238, 238, 238)`; dark icon `rgb(209, 209, 209)`, dark per-button
 * hover background `rgb(77, 77, 77)`; 3px corner radius, both themes.
 * Light was measured in a later review round than dark, not alongside it
 * — `index.css`'s own comment on these tokens has the fuller history. The
 * radius is declared once, undeclared in `.dark` — theme-independent
 * geometry, the identical pattern `--td-popover-width`'s own test file
 * comment (above) already established for `--td-popover-max-height`.
 */
describe("index.css — issue #438's row hover-strip tokens", () => {
  const { light, dark } = parseThemeTokens(readIndexCss());

  it("icon colour — the measured rgb(128,128,128) in light, the measured rgb(209,209,209) in dark", () => {
    expect(light.get("--td-row-action-icon")).toBe("rgb(128, 128, 128)");
    expect(dark.get("--td-row-action-icon")).toBe("rgb(209, 209, 209)");
  });

  it("per-button hover background — the measured rgb(238,238,238) in light, the measured rgb(77,77,77) in dark", () => {
    expect(light.get("--td-row-action-hover")).toBe("rgb(238, 238, 238)");
    expect(dark.get("--td-row-action-hover")).toBe("rgb(77, 77, 77)");
  });

  it("corner radius — theme-independent, not re-declared in dark", () => {
    expect(light.get("--td-row-action-radius")).toBe("3px");
    expect(dark.get("--td-row-action-radius")).toBe("3px");
  });
});

/**
 * Issue #439's own endless month list — the `--td-calendar-list-*` family,
 * deliberately separate from the pre-existing `--td-calendar-selected`/
 * `-today`/`-busy-dot` shared with `upcoming-week-strip.tsx` (index.css's
 * own comment on these tokens has the full reasoning). Values are the
 * issue's own comment correction (2026-09-21, both themes for today/
 * selected) and, for light's own busy dot and both themes' nav-active
 * colour, the documented reuse/default choices that same comment block
 * explains.
 */
describe("index.css — issue #439's month-list tokens (measured values)", () => {
  const { light, dark } = parseThemeTokens(readIndexCss());

  it("today (bold red) — light rgb(211,51,34), dark rgb(226,106,96)", () => {
    expect(light.get("--td-calendar-list-today")).toBe("rgb(211, 51, 34)");
    expect(dark.get("--td-calendar-list-today")).toBe("rgb(226, 106, 96)");
  });

  it("selected (filled circle) — light rgb(220,76,62), dark rgb(222,76,74)", () => {
    expect(light.get("--td-calendar-list-selected")).toBe("rgb(220, 76, 62)");
    expect(dark.get("--td-calendar-list-selected")).toBe("rgb(222, 76, 74)");
  });

  it("weekday letters / greyed weekend / hover info line — one shared token, light rgb(128,128,128), dark rgb(204,204,204)", () => {
    expect(light.get("--td-calendar-list-weekday")).toBe("rgb(128, 128, 128)");
    expect(dark.get("--td-calendar-list-weekday")).toBe("rgb(204, 204, 204)");
  });

  it("busy dot — light reuses the weekday grey (unmeasured on its own), dark is the measured rgb(209,209,209)", () => {
    expect(resolveToken(light, "--td-calendar-list-busy-dot")).toBe("rgb(128, 128, 128)");
    expect(dark.get("--td-calendar-list-busy-dot")).toBe("rgb(209, 209, 209)");
  });

  it("nav active colour (the '›' button) — light falls back to --foreground (unmeasured), dark is the measured rgb(209,209,209)", () => {
    expect(resolveToken(light, "--td-calendar-list-nav-active")).toBe(light.get("--foreground"));
    expect(dark.get("--td-calendar-list-nav-active")).toBe("rgb(209, 209, 209)");
  });
});
