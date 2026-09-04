import { expect, test } from "./fixtures";
import { openDestination, sendEntry, uniqueEntryBody } from "./helpers";

// Client-side routing (ticket 25) — real paths, not hash routing, which
// only works if the server serving the production build falls back to the
// app shell for a path it's never heard of. This is the one thing that's
// genuinely uncertain about the change, so it gets its own spec that loads
// /settings directly and hard-reloads on it, against the real Rust server.

// Playwright's default `Desktop Chrome` viewport is 1280px, which is above
// ADR 0036's 900px breakpoint — so the chat list is pinned beside the open
// destination there and Back is deliberately absent, because the list it
// would return to is already on screen. The push-and-Back shape these three
// tests are about is a narrow-window behaviour, so they say so rather than
// inheriting a width that quietly tests the other layout.
const NARROW = { width: 390, height: 844 };

// Every destination is still reachable directly (ticket 54), and Back is now
// what proves the way out. ADR 0036 gave Settings its Back control back:
// ADR 0018 argued an always-reachable destination does not need one, and
// issue #75 applied that to Settings when it became a Nav destination — but
// retiring the persistent nav removes the premise, because a destination
// pushed over the root screen is not always reachable any more.
test("/settings loads directly, survives a hard reload, and Back reaches a working Composer", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await page.goto("/settings");
  await expect(page.getByRole("banner").getByText("Settings")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("banner").getByText("Settings")).toBeVisible();

  await page.getByRole("link", { name: "Back to chats" }).click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Composer" }).click();
  await expect(page).toHaveURL("/composer");

  const body = uniqueEntryBody("routing");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();
});

// ADR 0036's headline shape: `/` is a list of exactly five rows you navigate
// away from, and opening one is a full-bleed push. The count is asserted
// here for the same reason the retired `nav.test.tsx` asserted it — every
// ADR since 0018 kept it at four, inside Material 3's three-to-five bound,
// until issue #168's Todo (ADR 0047) actually reached the fifth slot ADR
// 0036 declined to give Reflect's Sessions.
test("the root screen is a list of five destinations, each of which opens", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/");

  const rows = page.getByRole("navigation", { name: "Chats" }).getByRole("link");
  await expect(rows).toHaveCount(5);

  for (const [name, url] of [
    ["Composer", "/composer"],
    ["Reflect", "/reflect"],
    ["Digest", "/digest"],
    // `/todo` itself redirects to `/todo/inbox` (App.tsx) — the URL this
    // opens onto, not the row's own `to`.
    ["Todo", "/todo/inbox"],
    ["Settings", "/settings"],
  ] as const) {
    await page.goto("/");
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("link", { name: "Back to chats" })).toBeVisible();
  }
});

// The open destination has to be identifiable without sight of which pane is
// highlighted — the half of the debt ADR 0036 owes for retiring a landmark
// that carried `aria-current` for free.
//
// Asserted at the wide breakpoint, and only there, because that is where the
// question exists: the list and the open destination are on screen together.
// On a narrow window the list is only ever showing when nothing is open, so
// there is no current row to mark and no reader who could be confused about
// which one it is.
test("the pinned list marks the open destination as current, and only that one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/digest");

  const chats = page.getByRole("navigation", { name: "Chats" });
  await expect(chats.getByRole("link", { name: "Digest" })).toHaveAttribute("aria-current", "page");
  await expect(chats.getByRole("link", { name: "Composer" })).not.toHaveAttribute("aria-current");
  await expect(chats.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
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
  // Polls rather than a fixed 300ms sleep-then-check: the class is applied
  // synchronously by an inline script well before the deliberately delayed
  // bundle above ever resolves, so this should settle almost immediately —
  // the 900ms ceiling (under the route handler's 1_000ms delay) is what
  // keeps this proving "before the bundle runs" rather than just "true
  // eventually."
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 900 });
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
  await page.goto("/composer");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await openDestination(page, "Reflect");
  await expect(page).toHaveURL("/reflect");

  await openDestination(page, "Composer");
  await expect(page).toHaveURL("/composer");

  await openDestination(page, "Settings");
  await expect(page).toHaveURL("/settings");
  await openDestination(page, "Composer");
  await expect(page).toHaveURL("/composer");

  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText(/already open in another tab/i)).toHaveCount(0);
});

// ADR 0009's central claim: the sync loop is no longer tied to the
// lifecycle of the component that used to own it, so it keeps running even
// while EntryStoreLayout — and every page nested under it — is unmounted.
// Counting real /v1/sync requests while parked on Settings is a direct
// check of that, rather than inferring it from timing on the way back.
test("the sync loop keeps making requests while the user is on Settings", async ({ page }) => {
  await openDestination(page, "Settings");
  await expect(page).toHaveURL("/settings");

  let syncRequestsWhileOnSettings = 0;
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.url().endsWith("/v1/sync")) {
      syncRequestsWhileOnSettings++;
    }
  };
  page.on("request", onRequest);

  // Polls for the actual condition (at least one more request) instead of
  // sleeping a fixed multiple of the poll interval (SYNC_TICK_MS,
  // helpers.ts) and checking once — same pattern opt-in-sync.spec.ts
  // already uses for the same kind of request-count assertion. Resolves as
  // soon as the loop's next tick fires rather than always paying the full
  // wait, and the generous ceiling covers a loaded machine delaying that
  // tick past one interval.
  await expect.poll(() => syncRequestsWhileOnSettings, { timeout: 20_000 }).toBeGreaterThan(0);

  page.off("request", onRequest);
});
