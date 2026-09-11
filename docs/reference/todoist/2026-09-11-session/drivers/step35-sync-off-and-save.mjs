const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// We are already on /app/settings/theme (Todoist selected, Sync theme ON,
// Auto Dark Mode OFF, but rendering dark). Turn Sync theme OFF via JS click
// (dispatches native events so React's onChange fires), then Save via Update
// WITHOUT navigating away in between so the change isn't lost.
const clickResult = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const cb = boxes[0]; // Sync theme
  if (!cb) return { found: false };
  cb.click();
  return { found: true, checkedAfter: cb.checked };
});
console.log("sync toggle click:", JSON.stringify(clickResult));
await page.waitForTimeout(800);

const preSaveState = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return { sync: boxes[0]?.checked, auto: boxes[1]?.checked, bodyBg: getComputedStyle(document.body).backgroundColor };
});
console.log("pre-save state:", JSON.stringify(preSaveState));

await page.click('text="Update"', { label: "save theme + sync toggle change" });
await page.waitForTimeout(2000);

const postSaveState = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  dialogOpen: !!document.querySelector('[role="dialog"][aria-label="Settings"]'),
}));
console.log("post-save state:", JSON.stringify(postSaveState));

// Now do a full reload to confirm server-side persistence.
await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2500);

const afterReload = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("after full reload on inbox:", JSON.stringify(afterReload));
await page.screenshot({ path: `${OUT}/td-inbox-light-verified.png` });

await fs.writeFile(
  `${OUT}/td-light-theme-persist-check.json`,
  JSON.stringify({ clickResult, preSaveState, postSaveState, afterReload }, null, 2),
);
