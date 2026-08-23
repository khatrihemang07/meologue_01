import { expect, type Page, test } from "@playwright/test";

// ADR 0019 dropped the reading column's fixed max-w-2xl cap in favour of a
// proportion of whatever contains it: 97% below Tailwind's `md` breakpoint
// (768px), 85% at or above it. shell.tsx and composer.tsx each hand-carry
// that same "w-[97%] ... md:w-[85%]" pair independently — this spec exists
// to catch the two ever drifting apart, and to prove the percentage itself
// still holds against the *real* rendered layout rather than against the
// class names alone.
//
// The expectation in every assertion below is computed from the container's
// own measured clientWidth, not from the viewport width passed to
// setViewportSize. That's deliberate: at `md` and up the nav rail
// (md:w-20, 80px) sits beside the content in a flex row, so the content's
// containing block is already (viewport − 80px), not the full viewport.
// Deriving the expectation from the viewport would either have to hardcode
// that 80px or be wrong on the wide side of the breakpoint; deriving it from
// the container sidesteps the rail entirely.

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "small tablet, just below the breakpoint", width: 767, height: 1024 },
  { name: "the breakpoint itself", width: 768, height: 1024 },
  { name: "laptop", width: 1512, height: 982 },
  { name: "large desktop", width: 1920, height: 1080 },
] as const;

// Percentages of a fractional container width don't land on a whole pixel
// (Tailwind's arbitrary w-[97%] is exact; the browser's rounding of the
// resulting layout box isn't), so every width comparison below allows a
// couple of pixels of slack rather than asserting exact equality.
const TOLERANCE_PX = 2;

interface ColumnBox {
  x: number;
  width: number;
}

interface Measurement {
  containerWidth: number;
  content: ColumnBox;
  composer: ColumnBox;
}

/**
 * Both columns' boxes plus the width they are a percentage *of*, read in one
 * pass once the app has settled.
 *
 * Three properties of this are load-bearing, and all three were arrived at by
 * watching it fail rather than by taste:
 *
 * 1. **One `evaluate`, querying the DOM fresh.** The app replaces this part of
 *    its tree twice shortly after load — once when the Entry store finishes
 *    opening, once when the first Sync lands — and a `Locator` resolved before
 *    that points at a node React has since detached. A detached node's
 *    `getBoundingClientRect()` is all zeros (and `locator.boundingBox()` is
 *    null), so measuring through three separate round-trips could and did
 *    straddle a re-render: a container width of 0, or a Composer column of 0,
 *    against a content column measured before the swap.
 * 2. **Polled until non-zero.** The gates below prove the columns exist and are
 *    visible, but visibility at time T says nothing about attachment at time
 *    T+1. Retrying is what rides out the re-render; a zero that never resolves
 *    still fails the poll, so a column that genuinely collapses is still caught.
 * 3. **`document.fonts.ready` first.** Geist arrives as a webfont
 *    (@fontsource-variable/geist) and reflows the column when it swaps in.
 *    Widths here are percentages and don't depend on the font, but the reflow
 *    is one more moment at which a stale handle goes stale.
 */
async function measureColumns(page: Page): Promise<Measurement> {
  const scrollRegion = page.getByTestId("shell-scroll-region");
  // The content column is still the scroll region's first child div
  // (shell.tsx) — located from the scroll region's existing testid rather
  // than adding a new one to the column itself. The Composer's inner
  // column has no testid either; it's the Textarea's immediate parent
  // (composer.tsx), so the placeholder — already queried elsewhere in this
  // suite — locates it just as directly.
  //
  // `.first()` (issue #83): History virtualizes its own rows now, and the
  // subtree it renders *inside* the content column is a variable number of
  // item wrapper divs rather than one div per day group — none of that
  // changes which element this locator means to find (still the content
  // column itself, still `region.firstElementChild` in the `evaluate`
  // below), but a plain `scrollRegion.locator("> div")` is strict-mode
  // sensitive to exactly how many direct children the region ends up with,
  // and that's no longer a detail this spec should have to track by hand.
  await expect(scrollRegion.locator("> div").first()).toBeVisible();
  await expect(page.getByPlaceholder("What's on your mind?")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  let measured: Measurement | null = null;
  await expect
    .poll(async () => {
      measured = await page.evaluate(() => {
        const region = document.querySelector("[data-testid='shell-scroll-region']");
        const content = region?.firstElementChild;
        const composer = document.querySelector("textarea")?.parentElement;
        const box = (el: Element | null | undefined) => {
          const rect = el?.getBoundingClientRect();
          return { x: rect?.x ?? 0, width: rect?.width ?? 0 };
        };
        return {
          containerWidth: region?.clientWidth ?? 0,
          content: box(content),
          composer: box(composer),
        };
      });
      return Math.min(measured.containerWidth, measured.content.width, measured.composer.width);
    })
    .toBeGreaterThan(0);

  if (!measured) {
    throw new Error("unreachable: the poll above only resolves with a measurement in hand");
  }
  return measured;
}

for (const viewport of VIEWPORTS) {
  test(`the reading column is proportional, not capped, at ${viewport.name} (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");

    const { containerWidth, content, composer } = await measureColumns(page);
    const expectedFraction = viewport.width < 768 ? 0.97 : 0.85;
    const expectedWidth = containerWidth * expectedFraction;

    expect(content.width).toBeGreaterThan(expectedWidth - TOLERANCE_PX);
    expect(content.width).toBeLessThan(expectedWidth + TOLERANCE_PX);
    expect(composer.width).toBeGreaterThan(expectedWidth - TOLERANCE_PX);
    expect(composer.width).toBeLessThan(expectedWidth + TOLERANCE_PX);

    // The invariant a reader actually notices: the input has to line up
    // with the thread above it. Same left edge, same width — if either
    // drifts, the Composer stops agreeing with History regardless of
    // whether either one, in isolation, still matches its percentage.
    expect(composer.x).toBeGreaterThan(content.x - TOLERANCE_PX);
    expect(composer.x).toBeLessThan(content.x + TOLERANCE_PX);
    expect(composer.width).toBeGreaterThan(content.width - TOLERANCE_PX);
    expect(composer.width).toBeLessThan(content.width + TOLERANCE_PX);
  });
}

// 85% is narrower than 97% at every window size, so the column steps *down*
// right at the breakpoint rather than growing with the rest of the window —
// the same point shell.tsx's own comment makes. Asserting it here as a
// direct 767-vs-768 comparison is what would actually catch a regression
// that swapped the two percentages, or dropped the `md:` prefix, in a way
// the per-viewport checks above could miss if both sides were wrong by the
// same margin.
test("the reading column steps down, not up, across the 768px breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 1024 });
  await page.goto("/");
  const belowBreakpoint = await measureColumns(page);

  await page.setViewportSize({ width: 768, height: 1024 });
  const atBreakpoint = await measureColumns(page);

  expect(atBreakpoint.content.width).toBeLessThan(belowBreakpoint.content.width);
});
