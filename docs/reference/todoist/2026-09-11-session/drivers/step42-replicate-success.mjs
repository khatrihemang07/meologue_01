const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Re-assert light media forcing right before this attempt.
await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});

await page.goto("https://app.todoist.com/app/settings/theme");
await page.waitForLoadState();
await page.waitForTimeout(2500);

const pre = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return {
    matchesLight: window.matchMedia("(prefers-color-scheme: light)").matches,
    sync: boxes[0]?.checked,
    auto: boxes[1]?.checked,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log("PRE:", JSON.stringify(pre));

// Do NOT touch the sync/auto checkboxes at all this time. Just reselect
// Todoist (even if already selected, a fresh click forces a state update)
// and Update immediately.
await page.click('button[aria-label="Todoist"]', { label: "select Todoist" });
await page.waitForTimeout(600);
await page.click('text="Update"', { label: "save" });
await page.waitForTimeout(2000);

const post = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
}));
console.log("POST (immediately after Update, no nav):", JSON.stringify(post));
await page.screenshot({ path: `${OUT}/td-replicate-attempt.png` });
await fs.writeFile(`${OUT}/td-replicate-attempt.json`, JSON.stringify({ pre, post }, null, 2));
