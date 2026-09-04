import { expect, test } from "./fixtures";
import { deleteDigest, openDestination, seedDigest } from "./helpers";

/**
 * #128's Digest page, checked at real layout.
 *
 * The defect this replaces: three cards clamped to two lines each while more
 * than half the screen sat empty below them, and the clamp leaked — an
 * ellipsis at the end of the second line with a sliver of a third cut
 * through the glyphs underneath it. Both halves of the fix are measurements,
 * not markup: whether anything is clamped at all depends on how tall the
 * window is, and whether a clamp leaks depends on the rendered line height.
 * jsdom has neither.
 *
 * Seeded straight into the database (see `seedDigest`), for the reason
 * `digest.spec.ts`'s header records: a cold e2e database has no Digests at
 * all until real Entries have been written, embedded and summarised, and
 * none of that is what this page is about.
 */

const DATABASE = "meologue_e2e_a";

/** Distinct prose per Period, and deliberately different lengths. */
function paragraph(label: string, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, index) =>
      `${label} sentence ${index + 1} about a stretch of time and what was written across it.`,
  ).join(" ");
}

const DAY_DATE = "2024-02-01";
const WEEK_DATE = "2024-02-05";
const MONTH_DATE = "2024-02-01";

const DAY_BODY = paragraph("Daily", 6);
const WEEK_BODY = paragraph("Weekly", 14);
const MONTH_BODY = paragraph("Monthly", 30);

interface CardMeasurement {
  label: string;
  /** The clamp, in px, or null when the card is showing all of itself. */
  maxHeight: number | null;
  /** How tall the prose wants to be, regardless of the clamp. */
  naturalHeight: number;
  lineHeight: number;
  affordanceVisible: boolean;
}

async function measureCards(page: import("@playwright/test").Page): Promise<CardMeasurement[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-slot=card]")).map((card) => {
      const prose = card.querySelector("p");
      const wrapper = prose?.parentElement ?? null;
      const affordance = Array.from(card.querySelectorAll("p")).find(
        (paragraph) => paragraph.textContent === "Read the rest",
      );
      const rawMaxHeight = wrapper ? (wrapper as HTMLElement).style.maxHeight : "";
      return {
        label: card.querySelector("[data-slot=card-title]")?.textContent ?? "",
        maxHeight: rawMaxHeight === "" ? null : Number.parseFloat(rawMaxHeight),
        naturalHeight: prose?.scrollHeight ?? 0,
        lineHeight: prose
          ? Number.parseFloat(window.getComputedStyle(prose).lineHeight)
          : Number.NaN,
        affordanceVisible: affordance
          ? window.getComputedStyle(affordance).visibility === "visible"
          : false,
      };
    }),
  );
}

test.beforeEach(() => {
  seedDigest("day", DAY_DATE, DAY_BODY, DATABASE);
  seedDigest("week", WEEK_DATE, WEEK_BODY, DATABASE);
  seedDigest("month", MONTH_DATE, MONTH_BODY, DATABASE);
});

// `/v1/digest/:period` answers with the NEWEST Digest of that Period, and
// `scripts/e2e.sh` recreates the databases once per run rather than once per
// file — so a day Digest seeded here at a later date than `digest.spec.ts`'s
// own would be the one that spec's card showed, whichever of the two ran
// first. Taking these away again is what keeps the two independent.
test.afterAll(() => {
  deleteDigest("day", DAY_DATE, DATABASE);
  deleteDigest("week", WEEK_DATE, DATABASE);
  deleteDigest("month", MONTH_DATE, DATABASE);
});

test("three Digests that fit one screen are not clamped at all", async ({ page }) => {
  // Tall enough that all three fit outright. The old two-line clamp applied
  // here too, which is what left half the screen empty beneath them.
  await page.setViewportSize({ width: 1024, height: 2000 });
  await openDestination(page, "Digest");

  await expect(page.getByText("Last month")).toBeVisible();
  const cards = await measureCards(page);
  expect(cards).toHaveLength(3);

  for (const card of cards) {
    expect(card.maxHeight, `"${card.label}" was clamped with room to spare`).toBeNull();
    expect(card.affordanceVisible, `"${card.label}" offered to read the rest of itself`).toBe(
      false,
    );
  }
});

test("three Digests that overflow are each clamped to whole lines, proportionally", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openDestination(page, "Digest");

  await expect(page.getByText("Last month")).toBeVisible();
  const cards = await measureCards(page);
  expect(cards).toHaveLength(3);

  const clamped = cards.filter((card) => card.maxHeight !== null);
  expect(clamped.length, "nothing was clamped on a window too short for all three").toBeGreaterThan(
    0,
  );

  for (const card of clamped) {
    const maxHeight = card.maxHeight ?? 0;
    // THE DEFECT THIS REPLACES. A clamp that is not a whole number of lines
    // shows part of the next one through underneath the last — which is
    // exactly what the reader saw before, with an ellipsis above it.
    const lines = maxHeight / card.lineHeight;
    expect(
      Math.abs(lines - Math.round(lines)),
      `"${card.label}" is clamped to ${lines} lines, not a whole number`,
    ).toBeLessThan(0.01);
    expect(maxHeight, `"${card.label}" was clamped taller than its own prose`).toBeLessThan(
      card.naturalHeight,
    );
    expect(card.affordanceVisible, `"${card.label}" hid the rest with no way to reach it`).toBe(
      true,
    );
  }

  // Proportional to what each needs: the month has three times the day's
  // prose, so it must not be cut to the same height.
  const day = cards.find((card) => card.label === "Last day");
  const month = cards.find((card) => card.label === "Last month");
  expect(day?.naturalHeight ?? 0).toBeLessThan(month?.naturalHeight ?? 0);
  expect(month?.maxHeight ?? Number.POSITIVE_INFINITY).toBeGreaterThan(day?.maxHeight ?? 0);
});

test("the clamped page fits the window it was clamped for", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openDestination(page, "Digest");
  await expect(page.getByText("Last month")).toBeVisible();

  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector("div.overflow-y-auto");
    if (!scroller) return null;
    return scroller.scrollHeight - scroller.clientHeight;
  });

  expect(overflow).not.toBeNull();
  // The point of clamping proportionally rather than not at all: the three
  // Periods are readable side by side without the reader scrolling to find
  // the third. One line of slack for sub-pixel rounding in the measurement.
  expect(overflow ?? 0).toBeLessThan(28);
});

test("a clamped Digest still opens in full, at its own linkable route", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openDestination(page, "Digest");

  await page.getByText("Last month").click();
  await expect(page).toHaveURL(`/digest/month/${MONTH_DATE}`);
  // The whole of it, not the teaser — the reader route is what the clamp
  // sends people to, so it has to actually hold the rest.
  await expect(page.getByText(MONTH_BODY)).toBeVisible();

  await page.reload();
  await expect(page.getByText(MONTH_BODY)).toBeVisible();
});
