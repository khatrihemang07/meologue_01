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
// setViewportSize. That was deliberate when an 80px nav rail sat beside the
// content at `md` and up, and it survives ADR 0036 retiring that rail for a
// reason worth stating rather than leaving as luck: at 900px and up the chat
// list pane and its divider now take that space instead, and they take a
// *draggable* amount of it. Deriving the expectation from the viewport would
// have had to hardcode 80px before and would have to track a reader's own
// divider position now; deriving it from the container sidesteps both.

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
  // column has no testid either; it's the editable field's immediate
  // parent (composer.tsx), so the placeholder — already queried elsewhere in
  // this suite — locates it just as directly.
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
        // The Composer's own column — the row that holds the editable field
        // AND the Send button beside it, which is the box that actually has
        // to line up with the thread above.
        //
        // This used to be `querySelector("textarea")?.parentElement`, which
        // was wrong twice over. Issue #155 replaced the `<textarea>` with a
        // ProseMirror `contenteditable`, so the query started returning null
        // and every measurement here came back 0 — the poll below could
        // never resolve and these cases timed out. Fixing only that exposed
        // the older mistake underneath: the field's immediate parent is the
        // `flex-1` wrapper INSIDE the row, so it measures the column minus
        // the Send button and the gap (294px against the content column's
        // 378px at phone width). That mismatch predates issue #155 — the
        // same element measures the same 294px on the commit this branch
        // started from — so these assertions were failing there too, just
        // with a different number than the one the timeout later produced.
        //
        // The Send button's own parent IS the row, and `aria-label="Send"`
        // is a contract this suite already relies on elsewhere, so it
        // locates the column without depending on Tailwind classes or on
        // how many wrappers sit between the row and the field.
        const composer = document.querySelector('[aria-label="Send"]')?.parentElement;
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
    await page.goto("/composer");

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
  await page.goto("/composer");
  const belowBreakpoint = await measureColumns(page);

  await page.setViewportSize({ width: 768, height: 1024 });
  const atBreakpoint = await measureColumns(page);

  expect(atBreakpoint.content.width).toBeLessThan(belowBreakpoint.content.width);
});

// ADR 0036's wide layout: at 900px and up the chat list stops being a screen
// you navigate away from and becomes a pane beside the one you opened, with
// a handle between them. Below that breakpoint exactly one pane is ever on
// screen, which is what makes Back the only way out of a destination.
test("the chat list pins beside the open destination only at the wide breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 899, height: 900 });
  await page.goto("/composer");
  await expect(page.getByPlaceholder("What's on your mind?")).toBeVisible();

  await expect(page.getByTestId("pane-divider")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Chats" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to chats" })).toBeVisible();

  await page.setViewportSize({ width: 1200, height: 900 });

  await expect(page.getByTestId("pane-divider")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Chats" })).toBeVisible();
  // Back disappears rather than merely being redundant: the list it would
  // return to is already on screen and clickable.
  await expect(page.getByRole("link", { name: "Back to chats" })).toHaveCount(0);
});

// The divider is draggable and its width is remembered per Device, on every
// platform. Keyboard stepping is what this asserts rather than a pointer
// drag: it exercises the same clamp and the same persistence through a route
// Playwright can drive deterministically, where a synthesised drag mostly
// proves the browser can dispatch pointer events.
test("the divider resizes the list and remembers the width across a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/composer");

  const divider = page.getByTestId("pane-divider");
  await expect(divider).toBeVisible();
  const before = Number(await divider.getAttribute("aria-valuenow"));

  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");

  const after = Number(await divider.getAttribute("aria-valuenow"));
  expect(after).toBeGreaterThan(before);

  await page.reload();
  await expect(page.getByTestId("pane-divider")).toHaveAttribute("aria-valuenow", String(after));
});
