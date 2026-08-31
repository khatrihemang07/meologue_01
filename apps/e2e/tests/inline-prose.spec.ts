import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// What's guaranteed now, checked where it can actually fail.
//
// Issue #149 moved the Entry bubble's clock onto its own row, off the body's
// last line — so ADR 0041's floated-clock guarantee this spec used to
// describe no longer applies to an Entry at all (ADR 0043 supersedes 0041
// for Entry bodies specifically; the Digest/Question/Answer surfaces below
// still render inline-only, unchanged). An Entry's body may now contain a
// real block: a bullet/ordered list, a task-list checkbox. What's still
// guaranteed, and still worth a browser rather than jsdom to check, is
// narrower:
//
//   1. A Reference chip must not wrap the body onto an extra line — a chip
//      has no width cap of its own, and one that grew wider than the bubble
//      pushed the body's own text onto a second line, at every unit test
//      green (jsdom does not lay out anything, so it never saw this).
//   2. The mark set ADR 0043 deliberately left OUT — headings, blockquotes,
//      fenced code, thematic breaks, raw HTML — must render as the literal
//      characters typed and produce no corresponding element, the same
//      structural guarantee 0041 made, now checked against a narrower list.
//
// Nothing in the unit suite can see either failure: jsdom does not lay out
// floats or wraps, and "no block element resulted" needs a real block
// grammar this spec now depends on `parseEntryMarkdown` producing correctly.
// That is why this spec measures/inspects rendered DOM rather than asserting
// on markup in isolation.

const NARROW = { width: 390, height: 844 };

/** The rendered height of the bubble containing `text`. */
async function bubbleHeight(page: import("@playwright/test").Page, text: string) {
  return page.evaluate((needle) => {
    const body = [...document.querySelectorAll('[data-slot="bubble-body"]')].find((el) =>
      (el.textContent ?? "").includes(needle),
    );
    const box = body?.closest("div")?.getBoundingClientRect();
    return box ? box.height : null;
  }, text);
}

test("a formatted Entry is no taller than a plain one, so the clock keeps its line", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  // A SHORT word, not `uniqueEntryBody`'s full uuid. Bold text is genuinely
  // wider than regular, so a long body in semibold legitimately wraps where
  // the same body in regular weight does not — comparing those two measures
  // the font, not the float, and fails for a reason that is not a defect.
  // Kept far short of the wrap width, the only thing left that can add a
  // line is the body ceasing to be one line box, which is what this guards.
  const word = `f${Math.random().toString(36).slice(2, 8)}`;
  await sendEntry(page, word);
  await sendEntry(page, `**${word}**`);
  await expect(page.getByText(word).first()).toBeVisible();

  const heights = await page.evaluate((needle) => {
    const bodies = [...document.querySelectorAll('[data-slot="bubble-body"]')].filter((el) =>
      (el.textContent ?? "").includes(needle),
    );
    const h = (el?: Element) => el?.closest("div")?.getBoundingClientRect().height ?? null;
    return {
      plain: h(bodies.find((el) => el.querySelector("strong") === null)),
      formatted: h(bodies.find((el) => el.querySelector("strong") !== null)),
    };
  }, word);

  expect(heights.plain).not.toBeNull();
  expect(heights.formatted).not.toBeNull();
  expect(Math.abs((heights.formatted ?? 0) - (heights.plain ?? 0))).toBeLessThan(2);
});

test("a list and a checkbox render as real blocks; headings/quotes/fences/rules/HTML stay literal characters", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  const listMarker = uniqueEntryBody("list");
  const taskMarker = uniqueEntryBody("task");
  await sendEntry(page, `- item ${listMarker}`);
  await sendEntry(page, `- [ ] task ${taskMarker}`);

  // ADR 0043: lists and task checkboxes are the mark set's new block
  // structure, and they DO render as the elements they name.
  const listItem = page.locator("li", { hasText: listMarker });
  await expect(listItem.first()).toBeVisible();
  await expect(page.locator('[data-slot="bubble-body"] ul', { has: listItem })).toHaveCount(1);

  const taskItem = page.locator("li", { hasText: taskMarker });
  await expect(taskItem.first()).toBeVisible();
  await expect(taskItem.first().locator('input[type="checkbox"]')).toHaveCount(1);

  const notBlockMarker = uniqueEntryBody("notblk");
  for (const body of [
    `# heading ${notBlockMarker}`,
    `> quote ${notBlockMarker}`,
    `\`\`\`fence ${notBlockMarker}\`\`\``,
    `--- ${notBlockMarker}`,
  ]) {
    await sendEntry(page, body);
  }
  await expect(page.getByText(notBlockMarker).first()).toBeVisible();

  const htmlMarker = uniqueEntryBody("html");
  await sendEntry(page, `<b>html</b> ${htmlMarker}`);
  await expect(page.getByText(htmlMarker).first()).toBeVisible();

  // ADR 0043 removed headings/blockquotes/fences/thematic-breaks from the
  // dialect (not merely filtered them after parsing) and ADR 0041's raw-HTML
  // refusal is untouched — none of the six bodies above may have produced
  // any of these elements anywhere in the rendered History.
  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="bubble-body"]')]
      .flatMap((el) => [...el.querySelectorAll("h1,h2,h3,h4,h5,h6,blockquote,pre,hr,table,b")])
      .map((el) => el.tagName),
  );
  expect(offenders).toEqual([]);
});

test("raw HTML in an Entry is shown, never rendered", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  const marker = uniqueEntryBody("xss");
  await sendEntry(page, `<img src=x onerror="window.__pwned=1"> ${marker}`);
  await expect(page.getByText(marker).first()).toBeVisible();

  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  expect(
    await page.locator('[data-slot="bubble-body"] img, [data-slot="bubble-body"] b').count(),
  ).toBe(0);
});

test("a Reference chip does not wrap the body onto an extra line", async ({ page }) => {
  // The clock is no longer a float sharing the body's own line box (issue
  // #149 moved it to its own row), so this is no longer guarding the clock
  // at all. What it still guards: a chip carries no width cap of its own,
  // and one that renders wider than the bubble can push the body's text
  // onto a second line — a real defect this spec caught once, at every unit
  // test green, since jsdom never lays anything out. `plainH`/`chipH` below
  // measure exactly that: a chip-bearing body should be the same height (up
  // to its own border) as a plain one, not one line taller.
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  const target = uniqueEntryBody("target");
  await sendEntry(page, target);
  await expect(page.getByText(target).first()).toBeVisible();

  const targetId = await page.evaluate((needle) => {
    const body = [...document.querySelectorAll('[data-slot="bubble-body"]')].find((el) =>
      (el.textContent ?? "").includes(needle),
    );
    return body?.closest("[data-entry-id]")?.getAttribute("data-entry-id") ?? null;
  }, target);
  expect(targetId).not.toBeNull();

  const plain = uniqueEntryBody("plain");
  await sendEntry(page, plain);
  await sendEntry(page, `[[e:${targetId}]]`);

  const chip = page.locator(`a[href="/composer?e=${targetId}"]`);
  await expect(chip.first()).toBeVisible();

  const plainH = await bubbleHeight(page, plain);
  const chipH = await page.evaluate((id) => {
    const link = document.querySelector(`a[href="/composer?e=${id}"]`);
    const box = link?.closest('[data-slot="bubble-body"]')?.closest("div")?.getBoundingClientRect();
    return box ? box.height : null;
  }, targetId);

  expect(plainH).not.toBeNull();
  expect(chipH).not.toBeNull();
  // A chip carries a border, so a pixel or two of difference is expected; a
  // whole extra line is the failure this guards.
  expect((chipH ?? 0) - (plainH ?? 0)).toBeLessThan(8);
});

test("a Reference to a day with no Entries is not a link", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  const marker = uniqueEntryBody("empty");
  await sendEntry(page, `nothing happened on [[1999-01-02]] ${marker}`);
  await expect(page.getByText(marker).first()).toBeVisible();

  await expect(page.locator('a[href="/composer?d=1999-01-02"]')).toHaveCount(0);
  await expect(page.getByText("[[1999-01-02]]").first()).toBeVisible();
});
