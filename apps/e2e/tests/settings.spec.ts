import type { Locator, Page } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import {
  clearServerSettings,
  entrySeq,
  entrySwipeTarget,
  seedServerSetting,
  sendEntry,
  uniqueEntryBody,
  waitForEntryIdContaining,
} from "./helpers";

/**
 * #128's Settings, checked where it is actually checkable.
 *
 * Every claim here is about layout — a 44px control, five swatches on one
 * row, one spacing shape across five sections, a font size that changes and
 * three that do not. jsdom lays nothing out and reports every box as zero,
 * so none of these can be asserted there without asserting on class names
 * instead, which is a test of the stylesheet's spelling rather than of what
 * a reader sees.
 */

/** The smallest a control may be and still be reliably hit by a thumb. */
const MIN_TOUCH_TARGET_PX = 44;

async function fontSizeOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => window.getComputedStyle(element).fontSize);
}

/**
 * The HSL hue angle of a computed colour, in degrees.
 *
 * Hue rather than the whole colour because an Accent's swatch and the fill it
 * produces are deliberately nothing alike in lightness or chroma — the fill is
 * the swatch mixed most of the way toward the background — and hue is the one
 * component that has to survive that mix intact.
 *
 * Painted onto a canvas rather than parsed out of the string. Chromium hands
 * back `getComputedStyle` in whichever colour space the value was authored
 * in: the swatch comes back as `oklch(...)` and the fill as `oklab(...)`,
 * never as `rgb(...)`. A regex over the numbers in those strings reads an
 * `oklab` lightness as a red channel and produces confident nonsense — which
 * it did, on the first version of this helper.
 */
async function hueOf(locator: Locator, property: "backgroundColor"): Promise<number> {
  return locator.evaluate((element, prop) => {
    const colour = window.getComputedStyle(element)[prop as "backgroundColor"];
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return Number.NaN;
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    const r = (red ?? 0) / 255;
    const g = (green ?? 0) / 255;
    const b = (blue ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) return Number.NaN;
    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
  }, property);
}

async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Export as zip" })).toBeVisible();
}

test("every control on Settings clears the minimum touch target", async ({ page }) => {
  await openSettings(page);

  const controls = page.locator(
    'fieldset button, fieldset input, fieldset a[href], fieldset [role="button"]',
  );
  const count = await controls.count();
  // Three themes, five Accents, three text sizes, Save, Export.
  expect(count).toBeGreaterThanOrEqual(13);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    const name = (await control.getAttribute("aria-label")) ?? (await control.innerText());
    expect(box, `"${name}" has no box`).not.toBeNull();
    expect(
      box?.height ?? 0,
      `"${name}" is shorter than ${MIN_TOUCH_TARGET_PX}px`,
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }
});

test("the five Accent swatches lay out on one row, with none orphaned", async ({ page }) => {
  await openSettings(page);

  const swatches = page.locator('button[aria-label="Green"], button[aria-label="Teal"]').first();
  await expect(swatches).toBeVisible();

  const tops: number[] = [];
  for (const name of ["Green", "Teal", "Blue", "Violet", "Graphite"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, `"${name}" has no box`).not.toBeNull();
    tops.push(box?.y ?? -1);
  }

  // A `flex-wrap` row breaks after four on a phone and leaves the fifth on
  // a line of its own; an even five-column grid cannot.
  expect(new Set(tops.map((top) => Math.round(top))).size).toBe(1);
});

test("Settings' narrowest supported width still keeps all five swatches on one row", async ({
  page,
}) => {
  // The width the grid was sized against — 5 x 44px plus four 8px gaps is
  // 252px, and this is the narrowest Device the app runs on.
  await page.setViewportSize({ width: 360, height: 740 });
  await openSettings(page);

  const tops: number[] = [];
  for (const name of ["Green", "Teal", "Blue", "Violet", "Graphite"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    tops.push(Math.round(box?.y ?? -1));
  }
  expect(new Set(tops).size).toBe(1);
});

test("every Settings section puts the same gap between its label and its control", async ({
  page,
}) => {
  await openSettings(page);

  const gaps = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("fieldset")).map((section) => {
      const legend = section.querySelector("legend");
      // The first thing under the label that is not the label — a hint line
      // where there is one, the control itself where there is not. The gap
      // being measured is "label to whatever comes next", which is what has
      // to be the same everywhere.
      const next = legend?.nextElementSibling;
      if (!legend || !next) return null;
      return Math.round(next.getBoundingClientRect().top - legend.getBoundingClientRect().bottom);
    });
  });

  expect(gaps).not.toContain(null);
  // One shape for all five: no section pairs its tightest gap with its
  // heaviest control, which is exactly what Theme used to do.
  expect(new Set(gaps).size).toBe(1);
});

test("choosing an Accent recolours the reader's own Entries, and it survives a reload", async ({
  page,
}) => {
  const body = uniqueEntryBody("accent-recolours");

  await page.goto("/composer");
  await sendEntry(page, body);
  const bubble = entrySwipeTarget(page, body);
  await expect(bubble).toBeVisible();

  const backgroundOf = () =>
    bubble.evaluate((element) => window.getComputedStyle(element).backgroundColor);
  const before = await backgroundOf();

  await openSettings(page);
  await page.getByRole("button", { name: "Violet", exact: true }).click();

  await page.goto("/composer");
  await expect(bubble).toBeVisible();
  const after = await backgroundOf();
  expect(after).not.toBe(before);

  // A per-Device view preference, persisted the same way theme is.
  await page.reload();
  await expect(bubble).toBeVisible();
  expect(await backgroundOf()).toBe(after);
});

test("text size scales the Entry's own words and leaves the furniture alone", async ({ page }) => {
  const body = uniqueEntryBody("text-size-scales");

  await page.goto("/composer");
  await sendEntry(page, body);
  const prose = page.locator('[data-slot="bubble-body"]').filter({ hasText: body });
  await expect(prose).toBeVisible();

  // The clock time inside the same bubble, and the day pill above the
  // thread. The not-yet-synced tick carries the identical `text-[10px]` as
  // the time and sits in the same span, so measuring the time covers both —
  // and unlike the tick, the time is on screen whether or not this Entry has
  // reached the Server yet.
  const clock = page.locator('[data-slot="bubble"]', { hasText: body }).locator("time");
  const dayPill = page.getByText("Today").first();

  const baseline = {
    prose: await fontSizeOf(prose),
    clock: await fontSizeOf(clock),
    day: await fontSizeOf(dayPill),
  };

  for (const size of ["Large", "Small"]) {
    await openSettings(page);
    await page.getByRole("button", { name: size, exact: true }).click();
    await page.goto("/composer");
    await expect(prose).toBeVisible();

    expect(await fontSizeOf(prose), `${size} did not scale the Entry`).not.toBe(baseline.prose);
    expect(await fontSizeOf(clock), `${size} moved the clock time`).toBe(baseline.clock);
    expect(await fontSizeOf(dayPill), `${size} moved the day label`).toBe(baseline.day);
  }
});

// THE DEFECT THIS TEST EXISTS FOR. The Accent fill is a `color-mix` toward
// the theme's own background, and the first version mixed `in oklch`.
// `--background` is `oklch(1 0 0)` — achromatic, with a hue of 0 that CSS
// Color 4 calls powerless and that Chromium interpolates anyway — so mixing
// the blue Accent (hue 255) toward it took the short way round the circle
// and every bubble rendered PINK. Asserting only that the colour *changed*
// would have passed on pink; asserting the hue is the one the reader picked
// is what actually pins it.
test("an Entry's fill carries the hue of the Accent the reader chose", async ({ page }) => {
  const body = uniqueEntryBody("accent-hue");

  await page.goto("/composer");
  await sendEntry(page, body);
  const bubble = entrySwipeTarget(page, body);
  await expect(bubble).toBeVisible();

  for (const accent of ["Green", "Blue", "Violet"]) {
    await openSettings(page);
    const swatchHue = await hueOf(
      page.getByRole("button", { name: accent, exact: true }).locator("span").first(),
      "backgroundColor",
    );
    await page.getByRole("button", { name: accent, exact: true }).click();

    await page.goto("/composer");
    await expect(bubble).toBeVisible();
    const fillHue = await hueOf(bubble, "backgroundColor");

    // The fill is a heavily desaturated tint, so it is nowhere near the
    // swatch in lightness or chroma — but it must be the same colour.
    const separation = Math.min(Math.abs(fillHue - swatchHue), 360 - Math.abs(fillHue - swatchHue));
    expect(
      separation,
      `${accent} bubbles are ${Math.round(separation)}deg away from ${accent}`,
    ).toBeLessThan(40);
  }
});

/**
 * Issue #163's own acceptance criterion, asserted rather than argued:
 * "Changing the setting rewrites no Entry, triggers no Sync, and marks no
 * Digest stale."
 *
 * It is true by construction — `applyCompletedStyle` writes one attribute on
 * `<html>` and `setCompletedStyle` writes one localStorage key, and neither
 * path can reach the Entry store — but "true by construction" is exactly the
 * kind of claim that stops being true after an innocent refactor, silently,
 * with nothing failing. So it gets a test.
 *
 * `seq` is the strongest available signal, and for the reason `entrySeq`'s
 * own comment gives: ADR 0028 reassigns it on every write, insert or edit,
 * and never on a read. An unchanged `seq` therefore means no UPDATE reached
 * the Server at all — which is simultaneously the "no Entry rewritten" and
 * the "nothing to Sync" halves of the criterion, and the "no Digest stale"
 * half follows from ADR 0039, where staleness is triggered BY an Entry edit.
 *
 * All four values are exercised, not just one: the default is `gray`, so a
 * test that only tried `gray` could pass while writing nothing simply
 * because nothing changed.
 *
 * The Entry has to actually carry a completed checklist to exercise the
 * setting at all — but Promotion (issue #173, ADR 0048) means the body Send
 * commits is not the literal string typed: a bare `- [ ] <label>` mints a
 * Task and gets rewritten to `- [ ] [[task:id|label]]` the instant it
 * reaches the Server, so looking the row up by the full typed string never
 * finds it. `waitForEntryIdContaining` matches on `label` alone — the part
 * Promotion leaves untouched — rather than on the checkbox line as typed.
 */
test("changing the completed-checklist style rewrites no Entry (#163, ADR 0028)", async ({
  page,
}) => {
  const checklistLabel = uniqueEntryBody("call mum");
  await page.goto("/composer");
  await sendEntry(page, `- [ ] ${checklistLabel}`);
  const id = await waitForEntryIdContaining(checklistLabel, SERVER_A_DATABASE);
  expect(id).toBeDefined();
  const before = entrySeq(id as string, SERVER_A_DATABASE);
  expect(before).toBeDefined();

  await openSettings(page);
  for (const label of ["Grayed out and strikethrough", "Strikethrough", "None", "Grayed out"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  expect(entrySeq(id as string, SERVER_A_DATABASE)).toBe(before);
});

/**
 * Issue #203's own acceptance criterion, and the strongest available proof
 * for it: this suite's server A boots with `MEOLOGUE_CONFIG_LOCK=1`
 * (`scripts/e2e-server.sh`) precisely so a stored settings row — written by
 * an earlier spec's own `PATCH /v1/config` (once one exists), or by a
 * developer poking at the Server by hand — can never override the LLM
 * stub configuration the rest of this suite depends on. These two tests
 * check that promise from the client's own Settings page, not just from
 * `settings::resolve`'s Rust unit tests: the "On the server" sub-group must
 * render every row read-only, and a row seeded directly into the database
 * — bypassing the app entirely — must still be reported as coming from the
 * environment, not from what was seeded.
 */
test.describe("server settings (locked e2e Server)", () => {
  test("the server sub-groups render read-only", async ({ page }) => {
    await openSettings(page);

    // "On the server" appears twice — once under AI, once under Sync —
    // and both must say why: this Server was started with
    // MEOLOGUE_CONFIG_LOCK, so nothing here can be changed from a Device.
    const lockedNotices = page.getByTestId("server-config-locked");
    await expect(lockedNotices).toHaveCount(2);

    await expect(page.getByLabel("Chat model")).toBeDisabled();
    await expect(page.getByLabel("Chat base URL")).toBeDisabled();
    await expect(page.getByLabel("Timezone")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save server AI settings" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save timezone" })).toBeDisabled();
    // The three feature toggles' own "On" option, one per row — every one
    // of them read-only too, not just the text fields. Scoped to the server
    // sub-groups and matched exactly: a page-wide `{ name: "On" }` matches
    // by substring, so it also picks up the completed-checklist row's
    // "None" (and 30-odd others), which are Device settings and correctly
    // stay enabled while the Server is locked.
    const serverToggles = page
      .getByTestId("server-group")
      .getByRole("button", { name: "On", exact: true });
    await expect(serverToggles).toHaveCount(3);
    for (const button of await serverToggles.all()) {
      await expect(button).toBeDisabled();
    }
  });

  test("a settings row seeded directly into the database is still reported as coming from the environment", async ({
    page,
  }) => {
    // Bypasses the app entirely — the exact scenario a locked Server exists
    // to make harmless: a row landing in `server_settings` by any means
    // other than a `PATCH` this Server itself accepted.
    seedServerSetting("a-poisoned-model-name", SERVER_A_DATABASE);

    try {
      await openSettings(page);
      const chatModelField = page.getByLabel("Chat model");

      // `scripts/e2e-server.sh` sets `MEOLOGUE_CHAT_MODEL=llm-stub-chat` —
      // the seeded row must lose to that, not win, because this Server is
      // locked (`settings::resolve`'s own doc comment: a locked Server
      // behaves as though its settings row held nothing at all).
      await expect(chatModelField).toHaveValue("llm-stub-chat");
      await expect(chatModelField).not.toHaveValue("a-poisoned-model-name");
      await expect(chatModelField).toBeDisabled();
    } finally {
      // Leaves no trace for whichever spec runs after this one — the same
      // hygiene `deleteDigest` already practises for a seeded Digest.
      clearServerSettings(SERVER_A_DATABASE);
    }
  });
});
