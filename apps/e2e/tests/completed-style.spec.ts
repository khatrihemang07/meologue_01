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
 * `DayTasksRow`; Todo's own Inbox list, `task-row-content.tsx`'s title
 * button rendering a completed Task — ROW-14, parity-ledger.md, the
 * user's 2026-09-13 decision to match Todoist replaced this surface's own
 * separate "Completed (n)" disclosure with an inline row rendered through
 * the same row component an active Task uses, on screen with no click
 * needed to reach it), plus `task-detail-view.tsx`'s title and
 * `task-search-page.tsx` — both cheap to reach from the Task this spec
 * already ticks. `filter-view.tsx` is deliberately skipped: that view
 * lists active Tasks only, and a completed row is not reachable there
 * through the UI (this ticket's own scope note).
 *
 * THE RULING (issue #333). Cross-surface agreement is still the strongest
 * assertion available, but it no longer holds across all five surfaces —
 * it splits along the same line `index.css`'s `[data-surface="todo"]`
 * block draws, and that split is a ratified product decision, not a defect:
 *
 *   - STILL OBEYS `data-completed-style` (matches the loop's own
 *     `variant.decorationLine`/`colorVar`): the Entry bubble / History
 *     reference (`entry-row.tsx`) and the Day-tasks summary widget
 *     (`history.tsx`'s `DayTasksRow`). Both render on `/composer`
 *     (History reuses the identical component), and neither ever sits
 *     inside `[data-surface="todo"]` — that scope is claimed only by a
 *     `/todo/*` route or an open Task detail overlay (see below), and
 *     these two are neither.
 *   - ALWAYS STRIKES, in Todoist's own grey, regardless of which of the
 *     four Settings options is active: the Task detail dialog title
 *     (`task-detail-view.tsx`), Todo's own Inbox list
 *     (`task-row-content.tsx`), and the Task search page
 *     (`task-search-page.tsx`). Issue #250 / ROW-15 re-pointed
 *     `--checked-list-text-decoration`/`-color` inside
 *     `[data-surface="todo"]` unconditionally — not behind any
 *     `[data-completed-style="…"]` selector — because
 *     `pass2-2026-09-11.md` §1 measured Todoist always striking a
 *     completed title through, in its own grey
 *     (`rgb(128, 128, 128)`, distinct from Todo's own
 *     `--muted-foreground`), regardless of any app preference.
 *
 *     The Task detail dialog belongs in this group even though this test
 *     opens it from `/composer`, not a `/todo/*` route: the dialog is a
 *     Radix portal into `document.body`, outside the route tree, so
 *     `composer-page.tsx` claims the Todo token scope itself for as long
 *     as the overlay is open (`useTodoSurface(openTask !== null)`,
 *     `lib/todo-surface.ts` — a ref count, because the route and the
 *     overlay are two independent claimants on the same
 *     `documentElement` attribute). `chat-shell-layout.tsx`'s own header
 *     comment documents the same overlay-outlives-the-route problem for
 *     `--td-*` tokens; this is the same mechanism keeping
 *     `--checked-list-text-decoration` resolved correctly instead.
 *
 * `filter-view.tsx` is the fourth always-strikes consumer of
 * `.completed-task-text` inside `[data-surface="todo"]` — it would belong
 * in the second group too, but this spec still cannot reach a completed
 * row there through the UI (the scope note above).
 *
 * `index.css`'s own comment on the `[data-surface="todo"]` block names
 * the always-strikes files as `completed-tasks.tsx`, `task-detail-view.tsx`,
 * `filter-view.tsx`, `task-search-page.tsx` — checked against the actual
 * source rather than copied, because a comment in this repo has a track
 * record of asserting decisions it never made. **`completed-tasks.tsx`
 * does not exist.** ROW-14 (parity-ledger.md) folded Todo's separate
 * "Completed (n)" disclosure into `task-row-content.tsx`'s own `TaskRow`/
 * `TaskRowContent` — the same component an active Task renders through —
 * which is what this file's own comment two paragraphs up already
 * documents correctly; `index.css`'s file list was already one refactor
 * out of date the day ROW-15 landed. A second, independent copy of the
 * same stale name sits lower in `index.css`, on the `.completed-task-text`
 * rule's own comment, which also lists `history.tsx`'s `DayTasksRow`
 * alongside the four always-strikes files as if it were one of them — it
 * is not; `DayTasksRow` sits outside `[data-surface="todo"]` and is one of
 * the two surfaces that still obeys the setting, above.
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
 * The cross-surface claim moved to `text-decoration-line` — **and that
 * claim has since split too (issue #333)**. It was true when this comment
 * was first written that no palette scoped `text-decoration-line`, which
 * is where the original defect actually lived: a surface hardcoding
 * `line-through` fails under `gray` and `none` no matter whose grey it
 * uses. Issue #250 / ROW-15 then gave `[data-surface="todo"]` its own,
 * unconditional override of both `--checked-list-text-decoration` and
 * `--checked-list-text-color` — a deliberate, ratified exception, not a
 * regression of this claim — so `resolvedVarColor` below is now only the
 * right tool for the two surfaces this file's header comment says still
 * obey the setting. `resolvedTodoStrikeColor`, further down, is its
 * counterpart for the three that don't.
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

/**
 * The Todo-scope counterpart to `resolvedVarColor` above, for the three
 * surfaces issue #333's ruling says always strike: rather than resolving
 * `--muted-foreground`/`--foreground` (the Settings-driven pair those
 * surfaces have been carved out of), this resolves the exact expression
 * `index.css`'s `.completed-task-text` rule itself paints with —
 * `var(--checked-list-text-color, var(--foreground))` — through the SAME
 * `[data-surface="todo"]` override `resolvedVarColor`'s own probe would
 * never see, since it only ever asks for one bare custom property. Doing
 * it this way, rather than asserting the literal `rgb(128, 128, 128)`
 * `index.css`'s own comment measures, means this spec still doesn't
 * hardcode a colour (this file's header comment on why) even for the
 * variant-independent half of the ruling.
 */
async function resolvedTodoStrikeColor(scope: Locator): Promise<string> {
  return scope.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--checked-list-text-color, var(--foreground))";
    el.appendChild(probe);
    const value = window.getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
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
  // Only the CLICK is retried, and only for that reason.
  //
  // Issue #244 is why this used to be more than that. An outer `toPass`
  // wrapped an un-tick/re-tick recovery around `waitForTaskCompleted` too,
  // on a 90s budget, because the tick's own `/v1/sync` push could go out
  // with `"tasks":[]` and never recover — the Entry's checklist flipping to
  // `- [x]` and a `completed` Event going out in the very same request
  // while the Task row's completion was silently dropped from the outbox
  // forever. That was a real lost write, not a slow one: sync's
  // acknowledgement arm wrote Tasks through `TaskStore.upsert()` wholesale,
  // so an acknowledgement for the Task's creation, landing after the tick,
  // stamped a `seq` over the `seq: null` the completion had just set and
  // `pending()` never saw the row again. Fixed by
  // `TaskStore.applyAcknowledged` (ADR 0068's #244 amendment), so the wait
  // below is an ordinary wait again and belongs outside the retry, exactly
  // where composer.spec.ts keeps its own.
  const dayRow = page.getByTestId("day-tasks-row").locator("li", { hasText: body });
  const checkbox = dayRow.getByRole("checkbox");
  await expect(checkbox).toBeVisible();
  await expect(async () => {
    await checkbox.click();
    await expect(checkbox).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // `waitForTaskCompleted`'s own default budget, not the 15s this used to
  // pass. The short budget was an *inner* step of a 90s retry and only made
  // sense as one; standing alone it would be tighter than every other wait
  // in this suite, against a helper whose default is deliberately wide for
  // machine-load variance (issue #112, that helper's own doc comment).
  await waitForTaskCompleted(body, SERVER_A_DATABASE);

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
    //
    // `getByRole("button", { name: body })`, the same shape issue #333's
    // OWN locator repair (above, `task-detail-title`) had to move away
    // from once DET-02 removed the button entirely. Confirmed
    // deliberately rather than assumed to still be valid here:
    // `history.tsx`'s `DayTasksRow` (~L695) renders the completed Task's
    // words as a real `<button type="button" onClick={...}>{task.content}</button>`
    // — DET-02 only ever touched `task-detail-view.tsx`'s title, not this
    // component, so there is still a role and an accessible name to match.
    // Playwright's own name matching is substring-based (a plain
    // `getByRole` here, without `exact`, would also match any OTHER button
    // whose name merely contains `body`), but the `.locator("li", {
    // hasText: body })` immediately above already narrows to the one `<li>`
    // holding this exact Task, and that `<li>` contains exactly one
    // button — so the substring match cannot resolve onto a sibling row.
    const dayBlockWords = page
      .getByTestId("day-tasks-row")
      .locator("li", { hasText: body })
      .getByRole("button", { name: body });
    await expect(dayBlockWords).toBeVisible();
    const dayBlock = await renderedStyle(dayBlockWords);
    const dayBlockExpected = await resolvedVarColor(dayBlockWords, variant.colorVar);

    // 3. task-detail-view.tsx's own title — opened from the Day block's
    // words, the same door composer.spec.ts's "opens a Task from the Day
    // block" test already proves. Per this file's header-comment ruling,
    // this surface always strikes (issue #333): opening it from
    // `/composer` still lands inside `[data-surface="todo"]`, because the
    // overlay claims that scope itself for as long as it is open
    // (`lib/todo-surface.ts`), independent of the route underneath it.
    await dayBlockWords.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The at-rest title, which is what this spec wants: a completed Task's
    // title as a person sees it before touching it, not the editor that
    // swaps in once it is activated.
    //
    // Located by `data-testid`, and that is forced rather than preferred.
    // This read `getByRole("button", { name: body })` — true when #229
    // replaced the textarea with a button, and **false since 5e826b3
    // (2026-09-13)**, where parity item DET-02 matched Todoist's own
    // `div.task_content` and made the resting title a plain `<div>` with no
    // `role` and `tabIndex={-1}`. That commit did not touch this file, so
    // the locator has been waiting for an element that cannot exist ever
    // since — failing not as an assertion but by exhausting the whole
    // test's 180s budget, which is why it reads as a hang rather than a
    // break. There is no accessible name and no role to match by design
    // now, so the testid is the only stable handle left. Confirmed present:
    // `task-detail-view.tsx` (~L1971) sets `data-testid="task-detail-title"`
    // on the same element that gets `completed-task-text`.
    const titleField = dialog.getByTestId("task-detail-title");
    const taskDetail = await renderedStyle(titleField);
    const taskDetailExpected = await resolvedTodoStrikeColor(titleField);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // 4. Todo's own Inbox list — rendered through the same `TaskRow`/
    // `TaskRowContent` an active Task uses, interleaved inline since
    // ROW-14 (parity-ledger.md, the user's 2026-09-13 decision to match
    // Todoist) rather than behind a separate "Completed (n)" disclosure,
    // so the row is already on screen with no click needed to reveal it.
    // Always strikes (issue #333's ruling, above): `/todo/inbox` is a
    // `/todo/*` route, always inside `[data-surface="todo"]`.
    await page.goto("/todo/inbox");
    const inboxCompletedRow = page.locator(".completed-task-text");
    await expect(inboxCompletedRow).toBeVisible();
    const disclosure = await renderedStyle(inboxCompletedRow);
    const disclosureExpected = await resolvedTodoStrikeColor(inboxCompletedRow);

    // 5. task-search-page.tsx, "Show completed" on — reached directly by
    // URL (its own `?q=`/`completed=1` params) rather than driving the
    // toggle by hand. Always strikes for the same reason as Inbox above:
    // `/todo/search` is a `/todo/*` route.
    await page.goto(`/todo/search?q=${encodeURIComponent(label)}&completed=1`);
    const searchResult = page.locator(".completed-task-text");
    await expect(searchResult).toBeVisible();
    const search = await renderedStyle(searchResult);
    const searchExpected = await resolvedTodoStrikeColor(searchResult);

    // Each surface's expected colour was resolved while its own page was
    // still loaded — a Locator does not outlive the navigation that found
    // it, and resolving them all here instead would only ever measure the
    // last page.
    //
    // Split into two groups rather than one flat list — issue #333's
    // ruling (this file's header comment) is that these two groups no
    // longer make the same claim, and folding them back into one loop
    // would either weaken the Todo group's assertion (checking it only
    // against the setting, the stale claim #333 was filed to retire) or
    // wrongly tighten the setting group's (checking it against a strike
    // it was never meant to always show).
    const settingObeyingSurfaces: [string, RenderedStyle, string][] = [
      ["Entry bubble / History (reference)", reference, referenceExpected],
      ["Day-tasks summary widget", dayBlock, dayBlockExpected],
    ];
    const alwaysStrikeSurfaces: [string, RenderedStyle, string][] = [
      ["Task detail dialog title", taskDetail, taskDetailExpected],
      ["Todo Inbox list (inline)", disclosure, disclosureExpected],
      ["Task search page", search, searchExpected],
    ];

    for (const [name, style, expectedColor] of settingObeyingSurfaces) {
      // These two surfaces sit outside `[data-surface="todo"]`
      // (issue #333's ruling, this file's header comment) and still make
      // #237's original claim: every one of THEM agrees with every other
      // AND with the Settings choice.
      expect(style.decoration, `${name} text-decoration-line, ${variant.id}`).toBe(
        variant.decorationLine,
      );
      // Colour is checked against what this surface's OWN scope resolves
      // the token to — see `resolvedVarColor` above for why Todo's
      // deliberately differs from History's.
      expect(style.color, `${name} color, ${variant.id}`).toBe(expectedColor);
    }

    for (const [name, style, expectedColor] of alwaysStrikeSurfaces) {
      // Issue #250 / ROW-15: `[data-surface="todo"]` re-points
      // `--checked-list-text-decoration` to `line-through`
      // unconditionally, so these three surfaces agree with each other and
      // with Todoist's own always-struck title, NOT with `variant` — that
      // is issue #333's ruling, not a weakening of #237's, since the claim
      // being asserted is still "every surface in this group agrees, every
      // time," just no longer against the Settings-driven pair.
      expect(
        style.decoration,
        `${name} text-decoration-line, ${variant.id} (Todo always strikes — #250/ROW-15)`,
      ).toBe("line-through");
      // Colour is Todoist's own grey (`resolvedTodoStrikeColor`, above),
      // not `variant.colorVar` — that pair belongs to the Settings-driven
      // group only.
      expect(
        style.color,
        `${name} color, ${variant.id} (Todo's own grey, not the Settings token — #250/ROW-15)`,
      ).toBe(expectedColor);
    }
  }
});
