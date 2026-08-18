import { expect, test } from "@playwright/test";
import { sendEntry, uniqueEntryBody } from "./helpers";

// The web app installs and keeps working with the network off (ticket 45).
// vite.config.ts's VitePWA plugin precaches the app shell, its assets, and
// the SQLite WASM binary that opening the store depends on — this proves
// the whole chain by actually cutting the network rather than mocking any
// part of it.

test("History still renders after a reload with the network off", async ({ page, context }) => {
  await page.goto("/");

  const body = uniqueEntryBody("pwa-offline");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  // Registration happens on this same load (main.tsx calls
  // registerServiceWorker() unconditionally on the web target), but a
  // service worker never controls the page that was already loading when
  // it was installed — only a later navigation is. `serviceWorker.ready`
  // resolves once there's an active worker for the scope; reloading after
  // that is what puts *this* page under its control, which the
  // `controller` check below confirms before the network gets cut.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await context.setOffline(true);

  // A fresh navigation to a client-side route, not just a reload of "/" —
  // this is what exercises navigateFallback (vite.config.ts's workbox
  // config) rather than only the precached exact URL a plain reload of "/"
  // would hit.
  await page.goto("/history");

  // Scoped to the app bar (a <header>, implicit role "banner"): ticket 54's
  // persistent nav also renders a visible "History" text label (the link to
  // this same page), so an unscoped getByText("History") would now match
  // both that link and this page's title.
  await expect(page.getByRole("banner").getByText("History", { exact: true })).toBeVisible();
  await expect(page.getByText(body)).toBeVisible();

  await context.setOffline(false);
});
