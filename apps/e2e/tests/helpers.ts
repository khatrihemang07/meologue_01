import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";

/** A body unique to this test run, so leftover rows from a prior local run never collide. */
export function uniqueEntryBody(label: string): string {
  return `${label} ${randomUUID()}`;
}

export interface TwoDevices {
  deviceA: BrowserContext;
  deviceB: BrowserContext;
  pageA: Page;
  pageB: Page;
}

/** Two independent BrowserContexts, each already loaded — standing in for two Devices. */
export async function openTwoDevices(browser: Browser): Promise<TwoDevices> {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
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
 * continuous-sync wiring listens to (see continuous-sync-signals.ts).
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
