const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

// JS-level click on the Sync theme checkbox (index 0), dispatching proper
// events so React's controlled state picks it up.
const clickResult = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const cb = boxes[0];
  if (!cb) return { found: false };
  const before = cb.checked;
  cb.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  cb.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  cb.click();
  return { found: true, before, after: cb.checked };
});
console.log("clickResult:", JSON.stringify(clickResult));
await page.waitForTimeout(1000);

let state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return { sync: boxes[0]?.checked, auto: boxes[1]?.checked, htmlClass: document.documentElement.className, bodyBg: getComputedStyle(document.body).backgroundColor };
});
console.log("state after JS toggle:", JSON.stringify(state));

await page.click('button[aria-label="Todoist"]', { label: "select Todoist theme" });
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
console.log("state after selecting Todoist:", JSON.stringify(state));
await page.screenshot({ path: `${OUT}/td-theme-settings-after-js-toggle.png` });
await fs.writeFile(`${OUT}/td-theme-js-toggle-state.json`, JSON.stringify(state, null, 2));
