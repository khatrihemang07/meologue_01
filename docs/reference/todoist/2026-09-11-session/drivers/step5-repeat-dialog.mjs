// Open Repeat dialog from inside the open scheduler popover, capture, Escape.
// No selection made.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

await page.click('button[data-testid="recurrence-menu-button"]', { label: "open Repeat dialog" });
await page.waitForTimeout(1000);

out.repeat = await page.evaluate(() => {
  // Find the newest popover/menu that isn't the scheduler view or quick-add.
  const candidates = [...document.querySelectorAll('[role="dialog"], [role="menu"], [class]')].filter((el) => {
    const t = el.getAttribute("data-testid") || "";
    return /recurrence|repeat/i.test(t);
  });
  let v = candidates.find((el) => el.getAttribute("data-testid") !== "recurrence-menu-button") || candidates[0];
  if (!v) {
    // fallback: look for any element containing "Repeat" as a heading that is not the button itself
    const all = [...document.querySelectorAll("div, section")];
    v = all.find((el) => /repeat/i.test(el.getAttribute("aria-label") || "") && el.getAttribute("data-testid") !== "recurrence-menu-button");
  }
  if (!v) return { found: false };
  const s = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  return {
    found: true,
    testid: v.getAttribute("data-testid"),
    role: v.getAttribute("role"),
    size: `${Math.round(r.width)}x${Math.round(r.height)}`,
    radius: s.borderRadius,
    bg: s.backgroundColor,
    border: s.border,
    shadow: s.boxShadow,
    zIndex: s.zIndex,
    fullText: v.innerText.replace(/\n+/g, " | ").slice(0, 800),
  };
});
await page.screenshot({ path: `${OUT}/td-repeat-dark.png` });

await page.keyboard.press("Escape");
await page.waitForTimeout(800);
out.afterEscape = await page.evaluate(() => ({
  schedulerStillOpen: !!document.querySelector('[data-testid="scheduler-view"]'),
  quickAddStillOpen: !!document.querySelector('[data-testid="quick-add"]'),
}));

await fs.writeFile(`${OUT}/td-repeat-dark.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
