import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// Client-side routing (ticket 25) — real paths, not hash routing, which
// only works if the server serving the production build falls back to the
// app shell for a path it's never heard of. This is the one thing that's
// genuinely uncertain about the change, so it gets its own spec that loads
// /settings directly and hard-reloads on it, against the real Rust server.

test("/settings loads directly, survives a hard reload, and a back link returns to a working composer", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByText("Settings")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Settings")).toBeVisible();

  await page.getByRole("link", { name: /back/i }).click();
  await expect(page).toHaveURL("/");

  const body = uniqueEntryBody("routing");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();
});

test("the gear link on the history page navigates to Settings", async ({ page }) => {
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
// first for the OPFS pool lock. Routing away and back remounts the page and
// re-runs its effect, which is exactly the path that would reopen it — a
// reopened store surfaces the second-tab message instead of the History.
test("routing to Settings and back does not reopen the store", async ({ page }) => {
  const body = uniqueEntryBody("round-trip");
  await page.goto("/");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
  await page.getByRole("link", { name: /back/i }).click();
  await expect(page).toHaveURL("/");

  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText(/already open in another tab/i)).toHaveCount(0);
});
