const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

out.time = await page.evaluate(() => {
  const v = document.querySelector('[role="dialog"][aria-label="Select start and end time"]');
  if (!v) return { found: false };
  const s = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  return {
    found: true,
    size: `${Math.round(r.width)}x${Math.round(r.height)}`,
    radius: s.borderRadius,
    bg: s.backgroundColor,
    border: s.border,
    shadow: s.boxShadow,
    zIndex: s.zIndex,
    position: s.position,
    fullText: v.innerText.replace(/\n+/g, " | ").slice(0, 500),
  };
});
await page.screenshot({ path: `${OUT}/td-time-dark.png` });

await page.keyboard.press("Escape");
await page.waitForTimeout(800);
out.afterEscape1 = await page.evaluate(() => ({
  timeDialogGone: !document.querySelector('[role="dialog"][aria-label="Select start and end time"]'),
  schedulerStillOpen: !!document.querySelector('[data-testid="scheduler-view"]'),
  quickAddStillOpen: !!document.querySelector('[data-testid="quick-add"]'),
}));

await fs.writeFile(`${OUT}/td-time-dark.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
