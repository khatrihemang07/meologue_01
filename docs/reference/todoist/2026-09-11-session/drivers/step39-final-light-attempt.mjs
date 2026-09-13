const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Re-apply light media emulation fresh.
await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});
await page.waitForTimeout(300);

// We should currently be on /app/settings/theme (Todoist selected, Sync
// theme OFF from step35). Turn Sync theme back ON via JS click so the app
// actively re-evaluates system (now forced-light) preference, then Update.
const syncState = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const cb = boxes[0];
  if (!cb) return { found: false };
  if (!cb.checked) cb.click();
  return { found: true, checked: cb.checked };
});
console.log("sync re-enabled:", JSON.stringify(syncState));
await page.waitForTimeout(500);

// Make sure "Todoist" is the selected radio.
await page.click('button[aria-label="Todoist"]', { label: "ensure Todoist theme selected" }).catch(() => {});
await page.waitForTimeout(500);

await page.click('text="Update"', { label: "save with light media forced" });
await page.waitForTimeout(1500);

const state = await page.evaluate(() => ({
  matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("state after save (no reload):", JSON.stringify(state));
await page.screenshot({ path: `${OUT}/td-light-noreload-check.png` });
await fs.writeFile(`${OUT}/td-light-noreload-state.json`, JSON.stringify(state, null, 2));
