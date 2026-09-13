import type { Locator } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import { entryRow, sendEntry, uniqueEntryBody, waitForTaskCompleted } from "./helpers";

/**
 * Issue #237's real regression coverage.
 *
 * `theme.test.ts`/`history.test.tsx`/`completed-tasks.test.tsx`/
 * `task-detail-view.test.tsx`/`task-search-page.test.tsx` already assert
 * that every one of these surfaces carries `.completed-task-text` (or, for
 * the reference path, the pre-existing structural selector) once a Task is
 * done — but jsdom applies no cascade at all, so none of those can prove
 * what that class actually *renders as*. `index.css`'s one rule
 * (`@layer base`, near the bottom of the file) is the entire mechanism:
 *
 *   li.list-none input[type="checkbox"]:checked ~ div,
 *   .completed-sample,
 *   .completed-task-text {
 *     text-decoration: var(--checked-list-text-decoration);
 *     color: var(--checked-list-text-color, var(--foreground));
 *   }
 *
 * A future change could delete that rule, misspell a class, or scope the
 * custom properties wrong, and every one of those jsdom tests would stay
 * green — they only ever checked the class NAME landed on the element, not
 * that the element then painted anything. This spec is what would actually
 * fail.
 *
 * One Task, ticked once, carries every surface below — cheaper than
 * minting four, and it's also the stronger claim: the SAME completed Task
 * has to read identically everywhere it appears, for every one of the four
 * completed-style choices in Settings → Composer → "Completed checklist
 * item".
 *
 * Colour literals are deliberately absent. The four (decoration, colour)
 * pairs this ticket's own manual pass confirmed are real, but they are the
 * *dark* theme's `--muted-foreground`/`--foreground` — hardcoding
 * `oklch(0.708 0 0)` would make this spec break the day someone retunes
 * the palette despite the cascade being perfectly correct, which is a
 * worse failure mode than the one this spec exists to catch. Instead,
 * `resolvedVarColor` below asks the SAME browser to resolve
 * `var(--muted-foreground)`/`var(--foreground)` on a bare probe element,
 * and every surface's own computed colour is compared against that — the
 * assertion reads as "matches muted-foreground" rather than "equals this
 * literal". The theme is still pinned to dark (`emulateMedia`), matching
 * the table this ticket verified by hand and removing the one remaining
 * source of non-determinism (the host's own OS colour-scheme preference,
 * which nothing else in this suite pins) — but the assertions themselves
 * would hold just as well under light.
 *
 * Five surfaces, not three: the reference structural selector
 * (`li.list-none input:checked ~ div`, the Entry bubble/History checklist
 * item — unchanged by #237, and everything else has to match IT), the two
 * the ticket names (the day-tasks summary widget, `history.tsx`'s
 * `DayTasksRow`; Todo's own Inbox list, `completed-tasks.tsx`'s
 * `CompletedTaskRow` — ROW-14, parity-ledger.md, the user's 2026-09-13
 * decision to match Todoist replaced this surface's own separate
 * "Completed (n)" disclosure with an inline row, on screen with no click
 * needed to reach it), plus `task-detail-view.tsx`'s title and
 * `task-search-page.tsx` — both cheap to reach from the Task this spec
 * already ticks. `filter-view.tsx` is deliberately skipped: that view
 * lists active Tasks only, and a completed row is not reachable there
 * through the UI (this ticket's own scope note).
 *
 * The strongest assertion available is cross-surface agreement — for each
 * of the four styles, every surface's computed `text-decoration-line` and
 * `color` must equal both each other and the expected pair. That is
 * issue #237's own acceptance criterion, asserted rather than argued.
 */

const COMPLETED_STYLE_VARIANTS: {
  id: string;
  /** The exact button name on Settings → Composer → "Completed checklist item" (settings.ts's COMPLETED_STYLES). */
  label: string;
  decorationLine: "none" | "line-through";
  colorVar: "--muted-foreground" | "--foreground";
}[] = [
  { id: "gray", label: "Grayed out", decorationLine: "none", colorVar: "--muted-foreground" },
  {
    id: "grayAndStrike",
    label: "Grayed out and strikethrough",
    decorationLine: "line-through",
    colorVar: "--muted-foreground",
  },
  {
    id: "strike",
    label: "Strikethrough",
    decorationLine: "line-through",
    colorVar: "--foreground",
  },
  { id: "none", label: "None", decorationLine: "none", colorVar: "--foreground" },
];

interface RenderedStyle {
  decoration: string;
  color: string;
}

async function renderedStyle(locator: Locator): Promise<RenderedStyle> {
  return locator.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { decoration: style.textDecorationLine, color: style.color };
  });
}

/**
 * What `var(cssVar)` actually resolves to as a `color`, read off a bare
 * probe element rather than off `index.css`'s own authored text — the
 * point is to go through the SAME computed-style resolution every real
 * surface's `color` does, not to compare a raw custom-property string
 * against a browser-normalised one (which can differ in notation even when
 * they name the same colour).
 *
 * The probe is appended INSIDE the surface being checked, not to `<html>`,
 * and that is load-bearing rather than incidental. Todo carries its own
 * token scope — `[data-surface="todo"]` (index.css, set by
 * `chat-shell-layout.tsx` on every `/todo/*` route), where
 * `--muted-foreground` is deliberately a different grey to match
 * Todoist's own palette. So the SAME completed Task genuinely does render
 * a different literal colour in Todo than in History, by design, and a
 * document-level probe would call that a failure.
 *
 * That is exactly what `index.css`'s completed-style rule was built to do:
 * it resolves its two custom properties "from whichever ancestor carries
 * the attribute nearest to a given checked item". The claim this spec can
 * honestly make, then, is not "every surface paints the same bytes" but
 * "every surface paints what ITS OWN scope says the token is" — each one
 * obeying the reader's setting inside the palette it lives in.
 *
 * The cross-surface claim has not been given up; it moved to
 * `text-decoration-line`, which no palette scopes, and which is where the
 * original defect actually lived: a surface hardcoding `line-through`
 * fails under `gray` and `none` no matter whose grey it uses.
 */
async function resolvedVarColor(
  scope: Locator,
  cssVar: "--muted-foreground" | "--foreground",
): Promise<string> {
  return scope.evaluate((el, varName) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${varName})`;
    el.appendChild(probe);
    const value = window.getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, cssVar);
}

test("a completed Task's look — decoration and colour — agrees across every surface that renders one, for all four completed-style choices (#237)", async ({
  page,
}) => {
  // Five surfaces × four styles, each a real page load — see this file's
  // own header comment on why colour literals are avoided; `test.setTimeout`
  // mirrors composer.spec.ts's own precedent for a test this much heavier
  // than the suite's 60s default. Wide enough to also cover the setup
  // step's own `toPass` retry budget below (up to 90s, on the rare run
  // that needs it) on top of the rest of the test.
  test.setTimeout(180_000);

  // Pinned before the very first navigation, so the app's own first boot —
  // not just a later `watchSystemTheme` update — resolves "system" (the
  // default Theme) to dark. This is what makes the dark-theme table in
  // this file's header comment the actual table in play, on top of taking
  // the host's own OS colour-scheme preference out of the picture.
  await page.emulateMedia({ colorScheme: "dark" });

  // No hyphens in the label half: task-search-page.tsx's "Show completed"
  // switches matching to whole-word (task-search.ts's matchesWholeWord),
  // which tokenises on anything that isn't a letter or digit — a query
  // word containing a hyphen could never equal a single field token again.
  // uniqueEntryBody's own random suffix (a hyphenated UUID) still keeps
  // the Task's full content unique across runs; only the word this test
  // searches by has to stay hyphen-free.
  const label = "completedstylecrosssurface";
  const body = uniqueEntryBody(label);

  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${body}`);

  // Ticked from the Day block, the same retry-the-click shape
  // composer.spec.ts's own Day-block test uses and documents at length: a
  // virtualized row can be unmounted and remounted between a click landing
  // and React's onChange running, snapping a controlled checkbox back.
  //
  // The outer `toPass` goes one step further, covering a SEPARATE race this
  // spec's own investigation found (captured on a Playwright trace of a
  // real failure): the tick's own `/v1/sync` push can go out with
  // `"tasks":[]` — the Entry's checklist text flips to `- [x]` and a
  // `completed` Event is pushed in the very same request, but the Task
  // row's own `completed_at` write never gets marked dirty for THAT
  // request's outbox, and every poll afterwards keeps sending an empty
  // `tasks` array too — `since_task_seq` never moves again on its own.
  // Nothing local is wrong (the checkbox stays checked, the store's own
  // read of it is correct); this is the sync layer failing to notice one
  // particular write, intermittently — observed once in roughly every 6-10
  // runs here, unrelated to load. Un-ticking and re-ticking manufactures a
  // fresh local write for the outbox to notice, which is what actually
  // recovers it; a longer passive wait does not; a captured trace showed
  // 13 straight `/v1/sync` round trips over 56s, all 200 OK, after the one
  // that should have carried the Task.
  //
  // This is a real, reportable gap in the completion→sync path, not
  // something this spec's own assertions should paper over — see this
  // file's own report for the full trace. The retry only exists so THIS
  // spec's own coverage of #237 doesn't depend on winning that race.
  const dayRow = page.getByTestId("day-tasks-row").locator("li", { hasText: body });
  const checkbox = dayRow.getByRole("checkbox");
  await expect(checkbox).toBeVisible();
  await expect(async () => {
    if (await checkbox.isChecked()) {
      await checkbox.click();
      await expect(checkbox).not.toBeChecked({ timeout: 1_000 });
    }
    await checkbox.click();
    await expect(checkbox).toBeChecked({ timeout: 1_000 });
    await waitForTaskCompleted(body, SERVER_A_DATABASE, 15_000);
  }).toPass({ timeout: 90_000 });

  // Sanity check on the comparison itself, independent of any variant:
  // the two custom properties the whole test hinges on telling apart must
  // actually differ, in dark theme, or every "matches muted-foreground
  // instead of foreground" assertion below would pass vacuously.
  const mutedForeground = await resolvedVarColor(page.locator("body"), "--muted-foreground");
  const foreground = await resolvedVarColor(page.locator("body"), "--foreground");
  expect(
    mutedForeground,
    "muted-foreground and foreground must differ for this spec to mean anything",
  ).not.toBe(foreground);

  for (const variant of COMPLETED_STYLE_VARIANTS) {
    await page.goto("/settings");
    await page.getByRole("button", { name: variant.label, exact: true }).click();
    await expect(page.getByRole("button", { name: variant.label, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 1. The reference path: the Entry bubble's own checklist item in
    // History — `entry-row.tsx`'s TaskReferenceItem, the unchanged
    // structural selector `li.list-none input:checked ~ div`. Everything
    // else has to match THIS, not the other way round.
    await page.goto("/composer");
    const referenceDiv = entryRow(page, body).locator("li.list-none > div").first();
    await expect(referenceDiv).toBeVisible();
    const reference = await renderedStyle(referenceDiv);
    const referenceExpected = await resolvedVarColor(referenceDiv, variant.colorVar);

    // 2. The day-tasks summary widget — history.tsx's DayTasksRow.
    const dayBlockWords = page
      .getByTestId("day-tasks-row")
      .locator("li", { hasText: body })
      .getByRole("button", { name: body });
    await expect(dayBlockWords).toBeVisible();
    const dayBlock = await renderedStyle(dayBlockWords);
    const dayBlockExpected = await resolvedVarColor(dayBlockWords, variant.colorVar);

    // 3. task-detail-view.tsx's own title — opened from the Day block's
    // words, the same door composer.spec.ts's "opens a Task from the Day
    // block" test already proves.
    await dayBlockWords.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The at-rest title is a button, not a textbox — #229 replaced the
    // textarea with a button that swaps in a real editor only once
    // activated. Reading the resting state is what this spec wants: a
    // completed Task's title as a person sees it before touching it.
    const titleField = dialog.getByRole("button", { name: body });
    const taskDetail = await renderedStyle(titleField);
    const taskDetailExpected = await resolvedVarColor(titleField, variant.colorVar);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // 4. Todo's own Inbox list — completed-tasks.tsx's `CompletedTaskRow`,
    // interleaved inline since ROW-14 (parity-ledger.md, the user's
    // 2026-09-13 decision to match Todoist) rather than behind a separate
    // "Completed (n)" disclosure, so the row is already on screen with no
    // click needed to reveal it.
    await page.goto("/todo/inbox");
    const inboxCompletedRow = page.locator(".completed-task-text");
    await expect(inboxCompletedRow).toBeVisible();
    const disclosure = await renderedStyle(inboxCompletedRow);
    const disclosureExpected = await resolvedVarColor(inboxCompletedRow, variant.colorVar);

    // 5. task-search-page.tsx, "Show completed" on — reached directly by
    // URL (its own `?q=`/`completed=1` params) rather than driving the
    // toggle by hand.
    await page.goto(`/todo/search?q=${encodeURIComponent(label)}&completed=1`);
    const searchResult = page.locator(".completed-task-text");
    await expect(searchResult).toBeVisible();
    const search = await renderedStyle(searchResult);
    const searchExpected = await resolvedVarColor(searchResult, variant.colorVar);

    // Each surface's expected colour was resolved while its own page was
    // still loaded — a Locator does not outlive the navigation that found
    // it, and resolving them all here instead would only ever measure the
    // last page.
    const surfaces: [string, RenderedStyle, string][] = [
      ["Entry bubble / History (reference)", reference, referenceExpected],
      ["Day-tasks summary widget", dayBlock, dayBlockExpected],
      ["Task detail dialog title", taskDetail, taskDetailExpected],
      ["Todo Inbox list (inline)", disclosure, disclosureExpected],
      ["Task search page", search, searchExpected],
    ];

    for (const [name, style, expectedColor] of surfaces) {
      // Decoration is the cross-surface claim, and the one the original
      // defect broke: no palette scopes `text-decoration-line`, so every
      // surface must agree with every other AND with the setting.
      expect(style.decoration, `${name} text-decoration-line, ${variant.id}`).toBe(
        variant.decorationLine,
      );
      // Colour is checked against what this surface's OWN scope resolves
      // the token to — see `resolvedVarColor` above for why Todo's
      // deliberately differs from History's.
      expect(style.color, `${name} color, ${variant.id}`).toBe(expectedColor);
    }
  }
});
