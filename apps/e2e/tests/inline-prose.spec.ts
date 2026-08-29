import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// ADR 0041's guarantee, checked where it can actually fail.
//
// Formatting an Entry's body is only safe because the result stays a single
// line box: the Entry bubble's clock is a right float, and a float can only
// be placed on a line box it is in (ADR 0036). If anything in a body becomes
// a block — or merely grows wide enough to leave no room beside it — the
// clock drops to a line of its own and a one-word Entry costs two.
//
// Nothing in the unit suite can see this. jsdom does not lay out floats, so
// every one of these failures passes there. ADR 0036 already records one
// defect of exactly this shape that "passed every test and was wrong on
// screen; only a screenshot caught it", and building this feature produced a
// second one: a Reference chip with no width cap grew to the full width of
// the body and pushed the clock onto its own line, at 800 unit tests green.
// That is why this spec measures rather than asserts on markup.

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

  // Same rendered text, same length — the only difference is the marks, so
  // any height difference is the formatting's doing and nothing else.
  const word = uniqueEntryBody("fmt");
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

test("no Entry body renders a block element, whatever is typed into it", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  const marker = uniqueEntryBody("blk");
  for (const body of [
    `# heading ${marker}`,
    `- item ${marker}`,
    `> quote ${marker}`,
    `\`\`\`fence ${marker}\`\`\``,
    `<b>html</b> ${marker}`,
  ]) {
    await sendEntry(page, body);
  }
  await expect(page.getByText(`html`).first()).toBeVisible();

  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="bubble-body"]')]
      .flatMap((el) => [
        ...el.querySelectorAll("p,div,ul,ol,li,h1,h2,h3,h4,h5,h6,blockquote,pre,hr,table"),
      ])
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

test("a Reference chip leaves the clock its line", async ({ page }) => {
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
