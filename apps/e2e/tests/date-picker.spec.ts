import { expect, test } from "@playwright/test";
import { advanceDateByDays, installDateOffset, sendEntry, uniqueEntryBody } from "./helpers";

// `.first()` on every getByText below is deliberate, not defensive noise: an
// Entry's text appears both on the bubble's outer div (whose text also
// includes the clock) and on the inner body span, so a bare getByText is a
// strict-mode violation every time rather than intermittently.

// Issue #146: both day markers in History — the sticky pill that floats at
// the top while scrolling, and the inline separator between two days' worth
// of Entries — now open `DatePickerSheet`. This spec covers the two things
// nothing in the unit suite can: real scroll geometry (ADR 0030's own
// constraint on the sticky pill's wrapper) and a real navigation round trip
// (confirming a date actually moves History, the way inline-prose.spec.ts's
// own header comment records for a Reference chip's rendered geometry).

const NARROW = { width: 390, height: 844 };

test("the sticky day pill's wrapper never changes height as its own label shows and hides (ADR 0030)", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  // Enough Entries that the thread is taller than one screen, with room to
  // scroll from "the topmost visible row is the day separator itself" (the
  // pill stays hidden — history.tsx's own comment on why it doesn't repeat
  // the separator's own label) to "the topmost visible row is deep inside
  // that day's own Entries" (the pill shows "Today"). One day is enough:
  // the pill toggles on scroll position within a day, not on which day it
  // is.
  const marker = uniqueEntryBody("pillheight");
  for (let index = 0; index < 25; index += 1) {
    await sendEntry(page, `${marker} ${index}`);
  }
  await expect(page.getByText(`${marker} 24`).first()).toBeVisible();

  const scrollRegion = page.getByTestId("shell-scroll-region");
  // Added to history.tsx solely for this measurement — a plain data
  // attribute, so it carries no layout weight of its own to confound what
  // is being measured here.
  const wrapper = page.getByTestId("day-pill-wrapper");

  // Composer starts pinned to the newest Entry (the bottom), which for 25
  // short Entries on a 390x844 viewport is already well past the single
  // day separator at the very top — the pill should already be showing
  // "Today".
  await expect(wrapper).toContainText("Today");
  const shownBox = await wrapper.boundingBox();
  expect(shownBox).not.toBeNull();

  // Scroll all the way up: the topmost visible row becomes the day
  // separator itself, and the always-present pill withholds its own label
  // rather than showing the same day's name twice on screen at once.
  await scrollRegion.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(wrapper).not.toContainText("Today");
  const hiddenBox = await wrapper.boundingBox();
  expect(hiddenBox).not.toBeNull();

  // The one assertion ADR 0030 actually depends on. Turning the pill's
  // `<span>` into a `<button>` (issue #146) must not have made its box
  // sensitive to whether it's carrying text — jsdom cannot see this at all
  // (it never lays out real geometry), which is exactly why this
  // measurement lives here and not in history.test.tsx.
  expect(hiddenBox?.height).toBe(shownBox?.height);
  // A `<button>`'s own box, mounted or not — a wrapper collapsing to 0
  // would trivially "match" a 0 measured elsewhere and hide a real defect.
  expect(hiddenBox?.height).toBeGreaterThan(0);

  // The thread survived the round trip: scrolling back down still finds
  // the newest Entry exactly where it was, not shifted by whatever the old
  // `<span>`-toggle defect this replaces used to cost (history.tsx's own
  // comment: "still worth 16px of jump per toggle, measured in a real
  // browser").
  await scrollRegion.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText(`${marker} 24`).first()).toBeVisible();
});

test("tapping a day marker opens the date picker, and confirming a day with no Entries seeks there without spinning", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await page.goto("/composer");

  const marker = uniqueEntryBody("seek");
  await sendEntry(page, marker);
  await expect(page.getByText(marker).first()).toBeVisible();

  // The inline day separator sitting above today's one Entry — its
  // accessible name is the thing issue #146 actually adds (history.tsx: a
  // `title` alone was never enough). Found by its own testid rather than
  // role+name alone: on a thread this short, the sticky pill can already be
  // showing the very same day, which would make the accessible name
  // ambiguous between the two markers.
  const separator = page.getByTestId("day-separator");
  await expect(separator).toBeVisible();
  await separator.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Land on a month certain to hold no Entries at all, then pick a day
  // squarely inside it (the 15th, the same choice date-picker-sheet.test.tsx
  // makes and for the same reason: it can't collide with an overflow day
  // from the neighbouring month, which only ever fills the first/last
  // week's leading or trailing few cells).
  for (let month = 0; month < 3; month += 1) {
    await dialog.getByRole("button", { name: "Go to the Previous Month" }).click();
  }
  await dialog.getByRole("button", { name: /15th/ }).click();
  await dialog.getByRole("button", { name: /^Confirm/ }).click();

  await expect(dialog).not.toBeVisible();

  // Confirming pushed `?d=` into the URL, the exact route a date
  // Reference's own chip uses (composer-page.tsx, entry-row.tsx's
  // `DateReferenceLink`). There's only ever the one Entry loaded here, so
  // `pagination.hasMore` is false from the start and the seek should
  // settle — clearing the param again — almost immediately rather than
  // paging forever looking for a day that was never going to arrive.
  await expect.poll(() => new URL(page.url()).searchParams.has("d")).toBe(false);

  // The thread itself is still there and responsive afterward — the seek
  // landing at the boundary didn't leave History stuck or empty.
  await expect(page.getByText(marker).first()).toBeVisible();
});

// Issue #147: "a day shows what Refers to it" adds a whole new row next to
// the day separator (`DayReferrersRow`, history.tsx) — its own, deliberately
// separate row rather than anything folded into the separator or the sticky
// pill, precisely so it can never touch either one's box (ADR 0030, and see
// the sibling test above for the property this one extends). Nothing in the
// unit suite can see this either, for the same reason the sibling test
// can't: jsdom never lays out real geometry.
//
// A real Referrers row needs a *later* Entry Referring back to an earlier
// day — day-referrers.ts explicitly excludes a same-day self-Reference, so
// this needs two distinct local days inside one test, and real wall-clock
// time can't run a day backward. `installDateOffset` patches the browser's
// own no-argument `new Date()`/`Date.now()`, which is exactly what
// `use-history.ts` stamps a new Entry's `createdAt` from (a main-thread
// call, never inside the SQLite worker), so advancing it here genuinely
// produces an Entry captured "the next day" — see that helper's own
// comment for why this isn't built on Playwright's `page.clock` instead
// (it also freezes `requestAnimationFrame`, which this app's own
// scroll-to-newest depends on).
test("the sticky day pill's wrapper is unaffected by a day's own Referrers row, even with real content in it (issue #147, ADR 0030)", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await installDateOffset(page);
  await page.goto("/composer");

  // Day A is real, unshifted "today" — the local calendar day
  // `entryDayKey` (apps/web/src/lib/entry-day.ts) would compute for the
  // Device running this test, read the same way in Node so the `[[...]]`
  // mark built below names the exact day the app itself will group these
  // Entries under, whatever day this suite happens to run on.
  const now = new Date();
  const dayAKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;

  // Enough Entries on day A that the thread is taller than one screen —
  // the same reason the sibling test needs 25.
  const marker = uniqueEntryBody("referrers-pill");
  for (let index = 0; index < 25; index += 1) {
    await sendEntry(page, `${marker} ${index}`);
  }
  await expect(page.getByText(`${marker} 24`).first()).toBeVisible();

  // Advance to day B and Refer back to day A — a genuine later Reference,
  // not a self-Reference.
  await advanceDateByDays(page, 1);
  const referrerBody = uniqueEntryBody("referrer");
  await sendEntry(page, `looking back on [[${dayAKey}]] — ${referrerBody}`);
  await expect(page.getByText(referrerBody, { exact: false }).first()).toBeVisible();

  const scrollRegion = page.getByTestId("shell-scroll-region");
  const wrapper = page.getByTestId("day-pill-wrapper");

  // Pinned to the newest Entry — with 25 short day-A Entries plus day B's
  // one, the viewport's own top edge still lands inside day A's own run
  // (its own separator scrolled well out of view above), so the pill
  // shows day A's label here, not day B's "Today" — either is a genuine
  // "shown" state; which day's name it is isn't the point.
  await expect(wrapper).not.toHaveText("");
  const shownBox = await wrapper.boundingBox();
  expect(shownBox).not.toBeNull();

  // Scroll to the very top: day A's separator is now the topmost visible
  // row — the pill withholds its own label (same rule as the sibling test:
  // the topmost visible row already names the day itself) — and its own
  // Referrers row, immediately below it, now shows real content ("Referred
  // to by 1 Entry:") rather than nothing.
  await scrollRegion.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByText("Referred to by 1 Entry:").first()).toBeVisible();
  // Deliberately NOT asserting the pill's label here. Which day it names at
  // the top of the thread depends on whether the topmost visible row is a
  // separator or an Entry, and with two days in play that is incidental to
  // what this test is for. The property ADR 0030 cares about is the box, and
  // the box is what gets measured.
  const hiddenBox = await wrapper.boundingBox();
  expect(hiddenBox).not.toBeNull();

  // The one assertion ADR 0030 actually depends on: a real Referrers row,
  // with real rendered content, sitting immediately below the day A
  // separator, must not have changed the pill wrapper's own fixed box.
  expect(hiddenBox?.height).toBe(shownBox?.height);
  expect(hiddenBox?.height).toBeGreaterThan(0);
});
