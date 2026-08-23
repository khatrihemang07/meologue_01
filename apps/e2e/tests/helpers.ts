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
 * Hovers the History row identified by its exact body text, revealing the
 * row's Edit/Delete buttons (issue #78). They are plain `<button>`s behind
 * `@media (hover: hover)` and `opacity-0` until the row is hovered — a
 * headless Chromium reports as hover-capable, so they are in the DOM; the
 * hover is what makes them a target a real user could hit, and asserting
 * against them without it would pass for the wrong reason.
 *
 * `body` must be exact and unique in the DOM (uniqueEntryBody's randomUUID
 * suffix guarantees that), since this targets the row via its rendered text.
 */
export async function hoverEntryRow(page: Page, body: string): Promise<void> {
  await page.getByText(body, { exact: true }).hover();
}

/**
 * Edit -> Composer flow: reveals the row's actions, chooses Edit (which
 * seeds the docked Composer with the Entry's current body — see
 * composer.tsx's `editingEntry`), replaces the field's contents with
 * `newBody`, and commits via the Send control, since Composer routes Send
 * to `onCommitEdit` while `editingEntry` is set rather than to `onSend`.
 *
 * Send is a click, not the keyboard: issue #76 made plain Enter insert a
 * newline, and the chord that does send differs by build target, so a
 * click is the one gesture that means "send" on every platform this suite
 * might run against.
 */
export async function editEntryViaMenu(
  page: Page,
  currentBody: string,
  newBody: string,
): Promise<void> {
  await hoverEntryRow(page, currentBody);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByPlaceholder("What's on your mind?").fill(newBody);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Delete via the row's actions, then through the confirmation issue #82
 * put in front of it. Delete no longer fires on the spot and there is no
 * Undo toast any more — confirmation replaced it rather than joining it,
 * so a test that stops at the first click deletes nothing at all.
 */
export async function deleteEntryViaMenu(page: Page, body: string): Promise<void> {
  await hoverEntryRow(page, body);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
}
