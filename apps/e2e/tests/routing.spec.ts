import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// Client-side routing (ticket 25) — real paths, not hash routing, which
// only works if the server serving the production build falls back to the
// app shell for a path it's never heard of. This is the one thing that's
// genuinely uncertain about the change, so it gets its own spec that loads
// /settings directly and hard-reloads on it, against the real Rust server.

// Every page, Settings included, is reachable directly (ticket 54), and this
// same persistent nav is what proves the way back to the Composer works too.
//
// Settings also carries a Back control again (ADR 0019, partially superseding
// 0018's rejection of one) — but deliberately not exercised here: on a direct
// load like this one there is no history to pop, so Back takes its fallback
// branch and lands on the Composer, which is exactly what the nav link below
// already proves. settings-page.test.tsx covers both of Back's branches.
test("/settings loads directly, survives a hard reload, and its persistent nav returns to a working composer", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByText("Settings")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Settings")).toBeVisible();

  await page.getByRole("link", { name: "Composer" }).click();
  await expect(page).toHaveURL("/");

  const body = uniqueEntryBody("routing");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();
});

// ADR 0019's Back control, against a real browser history rather than the
// memory history settings-page.test.tsx drives. Entering from /history is
// the case the whole decision turns on: a fixed navigate("/") would land on
// the Composer here and look almost right, so History is the only
// destination that proves the pop actually happened.
test("Back on Settings returns to History when Settings was entered from there", async ({
  page,
}) => {
  await page.goto("/history");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");

  await page.getByRole("button", { name: "Back" }).click();

  await expect(page).toHaveURL("/history");
});

// The other branch, in a real browser: loaded directly, Settings has nothing
// behind it in this tab, so location.key is "default" and Back takes its
// fallback to the Composer rather than popping the app off the stack
// entirely (which is what a bare navigate(-1) would do here).
test("Back on a directly-loaded Settings falls back to the Composer", async ({ page }) => {
  await page.goto("/settings");

  await page.getByRole("button", { name: "Back" }).click();

  await expect(page).toHaveURL("/");
});

test("the gear link on the composer navigates to Settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();

  await expect(page).toHaveURL("/settings");
  await expect(page.getByText("Settings")).toBeVisible();
});

// ticket 27 — History becomes its own route, sharing the store and sync
// loop that the composer at "/" opens, via a layout route above both.
//
// getByText("History") is scoped to the app bar (role "banner") rather
// than left unscoped: ticket 54's persistent nav also renders a visible
// "History" text label (the link to this same page), so an unscoped query
// would now match both that link and this page's title.
test("/history loads directly, survives a hard reload, and its persistent nav returns to a working composer", async ({
  page,
}) => {
  await page.goto("/history");
  await expect(page.getByRole("banner").getByText("History", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("banner").getByText("History", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Composer" }).click();
  await expect(page).toHaveURL("/");

  const body = uniqueEntryBody("history-route");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();
});

test("an Entry sent from the composer appears on /history", async ({ page }) => {
  const body = uniqueEntryBody("shared-history");
  await page.goto("/");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();

  await expect(page).toHaveURL("/history");
  await expect(page.getByText(body)).toBeVisible();
});

// Unit tests already cover applyTheme/watchSystemTheme in isolation; what
// only a real page load can prove is that the class survives past a hard
// reload of the actual production build, from real localStorage rather than
// a mock of it.
test("choosing Dark in Settings survives a hard reload", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Dark" }).click();

  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.reload();

  await expect(page.locator("html")).toHaveClass(/dark/);
});

// Surviving a reload isn't the same as surviving it *without a flash*: the
// app bundle is a deferred module, so the stylesheet paints before it runs.
// Delaying the bundle widens that real gap enough to observe. Applying the
// theme only from main.tsx paints white here before switching to dark.
test("the theme is on the document before the app bundle runs", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Dark" }).click();

  await page.route("**/assets/*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });

  await page.goto("/settings", { waitUntil: "commit" });
  await page.waitForTimeout(300);

  expect(await page.locator("html").getAttribute("class")).toContain("dark");
});

// The store is memoized at module scope so a second open can't race the
// first for the OPFS pool lock. Routing away and back remounts EntryStoreLayout
// (ticket 27) and re-runs its effect, which is exactly the path that would
// reopen it — a reopened store surfaces the second-tab message instead of
// the History.
test("routing between /, /history and /settings does not reopen the store", async ({ page }) => {
  const body = uniqueEntryBody("round-trip");
  await page.goto("/");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL("/history");
  await expect(page.getByText(body)).toBeVisible();

  await page.getByRole("link", { name: "Composer" }).click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
  await page.getByRole("link", { name: "Composer" }).click();
  await expect(page).toHaveURL("/");

  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText(/already open in another tab/i)).toHaveCount(0);
});

// ADR 0009's central claim: the sync loop is no longer tied to the
// lifecycle of the component that used to own it, so it keeps running even
// while EntryStoreLayout — and every page nested under it — is unmounted.
// Counting real /v1/sync requests while parked on Settings is a direct
// check of that, rather than inferring it from timing on the way back.
test("the sync loop keeps making requests while the user is on Settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");

  let syncRequestsWhileOnSettings = 0;
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.url().endsWith("/v1/sync")) {
      syncRequestsWhileOnSettings++;
    }
  };
  page.on("request", onRequest);

  // Longer than one poll interval (SYNC_INTERVAL_MS is 5s) so a loop still
  // running fires at least once more while this page sits on Settings.
  await page.waitForTimeout(6_000);

  page.off("request", onRequest);
  expect(syncRequestsWhileOnSettings).toBeGreaterThan(0);
});
