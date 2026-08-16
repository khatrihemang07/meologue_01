import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { sendEntry, uniqueEntryBody } from "./helpers";

// Ticket 46: Export lives on Settings, a sibling route outside
// EntryStoreLayout (ADR 0008/0009) — it reads the store's Entries and hands
// zip bytes to the web save-file seam (a Blob + a synthetic <a download>
// click), which Playwright observes as a real download event.

test("Export downloads a zip whose manifest and day file both carry the sent Entry", async ({
  page,
}) => {
  const body = uniqueEntryBody("export");
  await page.goto("/");
  await sendEntry(page, body);
  await expect(page.getByText(body)).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");

  const exportButton = page.getByRole("button", { name: "Export as zip" });
  await expect(exportButton).toBeEnabled();

  const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);

  expect(download.suggestedFilename()).toMatch(/^meologue-export-\d{8}-\d{6}\.zip$/);

  const path = await download.path();
  expect(path).not.toBeNull();
  const unzipped = unzipSync(new Uint8Array(readFileSync(path as string)));

  // A real backup, not just a downloaded file: the lossless manifest carries
  // this Entry's exact body, ...
  const manifest = JSON.parse(strFromU8(unzipped["manifest.json"] as Uint8Array)) as {
    entry_count: number;
    entries: { body: string; file: string }[];
  };
  expect(manifest.entry_count).toBeGreaterThan(0);
  const manifestEntry = manifest.entries.find((entry) => entry.body === body);
  expect(manifestEntry).toBeDefined();

  // ...and so does the human-readable day file it names.
  const dayFile = strFromU8(unzipped[manifestEntry?.file ?? ""] as Uint8Array);
  expect(dayFile).toContain(body);
  expect(dayFile).toMatch(/^# \d{4}-\d{2}-\d{2} {2}\(times in [+-]\d{2}:\d{2}\)/);
});
