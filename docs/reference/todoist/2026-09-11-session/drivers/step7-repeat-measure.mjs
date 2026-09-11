const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

out.repeat = await page.evaluate(() => {
  const v = [...document.querySelectorAll('[role="menu"]')].find((el) => /repeat/i.test(el.getAttribute("aria-label") || "") || /every day/i.test(el.innerText));
  if (!v) return { found: false, menus: document.querySelectorAll('[role="menu"]').length };
  const s = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  const items = [...v.querySelectorAll('[role="menuitem"]')].map((mi) => mi.innerText.replace(/\n+/g, " "));
  return {
    found: true,
    ariaLabel: v.getAttribute("aria-label"),
    size: `${Math.round(r.width)}x${Math.round(r.height)}`,
    radius: s.borderRadius,
    bg: s.backgroundColor,
    border: s.border,
    shadow: s.boxShadow,
    zIndex: s.zIndex,
    position: s.position,
    items,
  };
});
await page.screenshot({ path: `${OUT}/td-repeat-dark.png` });

await page.keyboard.press("Escape");
await page.waitForTimeout(800);
out.afterEscape = await page.evaluate(() => ({
  repeatMenuGone: !document.querySelector('[role="menu"]'),
  schedulerStillOpen: !!document.querySelector('[data-testid="scheduler-view"]'),
  quickAddStillOpen: !!document.querySelector('[data-testid="quick-add"]'),
}));

await fs.writeFile(`${OUT}/td-repeat-dark.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
