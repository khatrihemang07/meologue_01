const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// Click the Sync theme checkbox (index 0) precisely via nth-of-type selector.
await page.click('input[type="checkbox"] >> nth=0', { label: "turn off Sync theme" });
await page.waitForTimeout(800);

let state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return {
    sync: boxes[0]?.checked,
    auto: boxes[1]?.checked,
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log("after toggling sync off:", JSON.stringify(state));

// Now explicitly select the Todoist (light) theme.
await page.click('button[aria-label="Todoist"]', { label: "select Todoist light theme" });
await page.waitForTimeout(1200);

state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return {
    sync: boxes[0]?.checked,
    auto: boxes[1]?.checked,
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  };
});
console.log("after selecting Todoist:", JSON.stringify(state));
await page.screenshot({ path: `${OUT}/td-theme-settings-light-check.png` });

await fs.writeFile(`${OUT}/td-theme-light-toggle-state.json`, JSON.stringify(state, null, 2));
