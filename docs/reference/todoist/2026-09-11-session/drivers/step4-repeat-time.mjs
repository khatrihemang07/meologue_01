// Locate Repeat & Time buttons inside the open scheduler popover, then open
// each in turn, capture, Escape back to scheduler. No selection is made.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

out.schedulerButtons = await page.evaluate(() => {
  const v = document.querySelector('[data-testid="scheduler-view"]');
  if (!v) return { found: false };
  return [...v.querySelectorAll("button")].map((b) => ({
    label: (b.getAttribute("aria-label") || b.innerText || "").trim().replace(/\n+/g, " "),
    testid: b.getAttribute("data-testid"),
  }));
});

await fs.writeFile(`${OUT}/td-scheduler-buttons.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
