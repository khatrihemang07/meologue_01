const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Currently on /app/settings/theme, light media forced, sync=false. Turn
// sync back ON (so polarity follows the forced-light media), reselect
// Todoist, Update.
const syncState = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const cb = boxes[0];
  if (!cb) return { found: false };
  if (!cb.checked) cb.click();
  return { found: true, checked: cb.checked };
});
console.log("sync toggle:", JSON.stringify(syncState));
await page.waitForTimeout(600);

await page.click('button[aria-label="Todoist"]', { label: "select Todoist" });
await page.waitForTimeout(500);

await page.click('text="Update"', { label: "save theme" });
await page.waitForTimeout(1500);

let state = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("immediately after Update:", JSON.stringify(state));

// Close the settings dialog via its Close button (client-side, no reload).
await page.click('button[aria-label="Close settings"]', { label: "close settings dialog" }).catch(() => {});
await page.waitForTimeout(1000);

state = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  url: location.pathname,
}));
console.log("after closing settings dialog:", JSON.stringify(state));

// Now use an in-app SPA link click (not page.goto) to move to Inbox.
await page.click('a[aria-label*="Inbox" i]', { label: "click Inbox link (SPA nav)" }).catch(async (e) => {
  console.log("inbox link click failed:", e.message);
});
await page.waitForTimeout(1500);

state = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  url: location.pathname,
}));
console.log("after SPA nav to inbox:", JSON.stringify(state));
await page.screenshot({ path: `${OUT}/td-inbox-light-spa.png` });
await fs.writeFile(`${OUT}/td-light-spa-nav-state.json`, JSON.stringify(state, null, 2));
