const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Clear any CDP media emulation override so we're back to the browser's real
// default reporting (no artificial forcing) before restoring the theme.
await page.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
await page.cdp("Emulation.setEmulatedMedia", { features: [] });

// Navigate cleanly (no ?theme= query param) to settings/theme.
await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2000);

const pre = await page.evaluate(() => {
  const radios = [...document.querySelectorAll('button[role="radio"]')].map((b) => ({
    label: b.getAttribute("aria-label"),
    checked: b.getAttribute("aria-checked"),
  }));
  return { radios, htmlClass: document.documentElement.className };
});
console.log("PRE restore:", JSON.stringify(pre));

await page.click('button[aria-label="Dark"]', { label: "select Dark theme (restore)" });
await page.waitForTimeout(800);

// Click Update if it appears (it should, since Todoist -> Dark is a real change).
await page.click('text="Update"', { label: "save Dark theme restore" }).catch(async (e) => {
  console.log("Update click not needed/found:", e.message);
});
await page.waitForTimeout(1500);

const postImmediate = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));
console.log("POST immediate:", JSON.stringify(postImmediate));

// Close settings, then do a full clean reload to verify server persistence.
await page.click('button[aria-label="Close settings"]', { label: "close settings" }).catch(() => {});
await page.waitForTimeout(800);

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2500);

const final = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("FINAL after clean reload:", JSON.stringify(final));
await page.screenshot({ path: `${OUT}/td-dark-restored-final.png` });
await fs.writeFile(`${OUT}/td-dark-restore-verify.json`, JSON.stringify({ pre, postImmediate, final }, null, 2));
