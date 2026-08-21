import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { SERVER_A_URL } from "../servers";

/** A body unique to this test run, so leftover rows from a prior local run never collide. */
export function uniqueEntryBody(label: string): string {
  return `${label} ${randomUUID()}`;
}

/**
 * A Playwright `storageState` that seeds `meologue.server-url` for the app's
 * own origin before any page script runs — sync is opt-in (ADR 0011), so
 * without this every context would load with sync off and none of the
 * suite's assertions about syncing would ever be exercised. Every context
 * the suite opens (the config's default `page` fixture, and each device
 * `openTwoDevices` creates) needs this seeded explicitly; there is no
 * implicit fallback left to fall back on.
 */
export function serverUrlStorageState(serverUrl: string) {
  return {
    cookies: [],
    origins: [
      { origin: SERVER_A_URL, localStorage: [{ name: "meologue.server-url", value: serverUrl }] },
    ],
  };
}

export interface TwoDevices {
  deviceA: BrowserContext;
  deviceB: BrowserContext;
  pageA: Page;
  pageB: Page;
}

export interface TwoDevicesOptions {
  /** The Server URL each Device's context is seeded with — defaults to the suite's one Server. */
  serverUrlA?: string;
  serverUrlB?: string;
}

/**
 * Two independent BrowserContexts, each already loaded and each seeded with
 * a Server URL — standing in for two Devices. Defaults to both pointing at
 * the same Server; multi-server.spec.ts overrides `serverUrlA`/`serverUrlB`
 * to prove a Device follows whichever Server URL it was given, not which
 * origin served its page.
 */
export async function openTwoDevices(
  browser: Browser,
  options: TwoDevicesOptions = {},
): Promise<TwoDevices> {
  const { serverUrlA = SERVER_A_URL, serverUrlB = SERVER_A_URL } = options;
  const deviceA = await browser.newContext({ storageState: serverUrlStorageState(serverUrlA) });
  const deviceB = await browser.newContext({ storageState: serverUrlStorageState(serverUrlB) });
  const pageA = await deviceA.newPage();
  const pageB = await deviceB.newPage();
  await pageA.goto("/");
  await pageB.goto("/");
  return { deviceA, deviceB, pageA, pageB };
}

export async function closeDevices(devices: TwoDevices): Promise<void> {
  await devices.deviceA.close();
  await devices.deviceB.close();
}

export async function sendEntry(page: Page, body: string): Promise<void> {
  await page.getByPlaceholder("What's on your mind?").fill(body);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Real OS-level tab backgrounding isn't controllable through Playwright, so
 * this drives the Page Visibility API directly, the same signal `apps/web`'s
 * continuous-sync wiring listens to (see wake-signals.web.ts).
 */
export async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", {
      value: hidden ? "hidden" : "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/**
 * Opens the Radix ContextMenu (ADR 0028) wired onto a History row —
 * entry-row.tsx's `actions` prop — by right-clicking the row identified by
 * its exact body text, the pointer-device trigger for the same menu a
 * long-press opens on touch. `body` must be exact and unique in the DOM
 * (uniqueEntryBody's randomUUID suffix guarantees that), since this
 * targets the row via its own rendered text.
 */
export async function openEntryMenu(page: Page, body: string): Promise<void> {
  await page.getByText(body, { exact: true }).click({ button: "right" });
}

/**
 * Edit -> Composer flow (ADR 0028): opens the row's menu, chooses Edit
 * (which seeds the docked Composer with the Entry's current body — see
 * composer.tsx's `editingEntry`), replaces the field's contents with
 * `newBody`, and commits via the same Send control `sendEntry` above uses
 * (Composer routes Send to `onCommitEdit` while `editingEntry` is set,
 * rather than `onSend` — see composer.tsx's own `send()`).
 */
export async function editEntryViaMenu(
  page: Page,
  currentBody: string,
  newBody: string,
): Promise<void> {
  await openEntryMenu(page, currentBody);
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByPlaceholder("What's on your mind?").fill(newBody);
  await page.getByRole("button", { name: "Send" }).click();
}

/** Delete via the row's menu (ADR 0028) — fires immediately, no confirm step; use-history.ts offers Undo via a toast instead. */
export async function deleteEntryViaMenu(page: Page, body: string): Promise<void> {
  await openEntryMenu(page, body);
  await page.getByRole("menuitem", { name: "Delete" }).click();
}
