import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// Client-side routing (ticket 25) — real paths, not hash routing, which
// only works if the server serving the production build falls back to the
// app shell for a path it's never heard of. This is the one thing that's
// genuinely uncertain about the change, so it gets its own spec that loads
// /settings directly and hard-reloads on it, against the real Rust server.

// Every page, Settings included, is reachable directly (ticket 54), and this
// same persistent nav is what proves the way back to the Composer works
// too. Settings lost its Back control when issue #75 made it a Nav
// destination in its own right (ADR 0018's "an always-reachable destination
// doesn't need Back" then applied to it the same way it always did to
// Composer/Reflect/Digest) — the nav link below is now the only way back,
// and this test is what proves it still works.
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

// Issue #75: Settings moved from a gear-shaped app-bar action into the
// persistent Nav's fourth destination — same navigation outcome as before,
// reached a different way, and this is what proves the new way works.
test("the Settings destination in the persistent nav navigates there from the composer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();

  await expect(page).toHaveURL("/settings");
  await expect(page.getByText("Settings")).toBeVisible();
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
// the History. Routes through /reflect (issue #75 removed /history, this
// spec's original second EntryStoreLayout child) on the way to Settings and
// back, so this still exercises a round trip through two different pages
// nested under the layout plus the sibling Settings route outside it.
test("routing between /, /reflect and /settings does not reopen the store", async ({ page }) => {
  const body = uniqueEntryBody("round-trip");
  await page.goto("/");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await page.getByRole("link", { name: "Reflect" }).click();
  await expect(page).toHaveURL("/reflect");

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
