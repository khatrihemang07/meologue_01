const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

await page.keyboard.press("Escape");
await page.waitForTimeout(800);
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);

const state1 = await page.evaluate(() => ({
  quickAddOpen: !!document.querySelector('[data-testid="quick-add"]'),
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  bodyHasDiscardPrompt: /discard/i.test(document.body.innerText),
}));

// If a discard confirmation appeared, we must NOT click a save/discard button
// that submits anything; but Todoist's discard confirm is safe to accept via
// Escape again, or we detect and report if a modal blocks Escape.
let state2 = null;
if (state1.bodyHasDiscardPrompt) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  state2 = await page.evaluate(() => ({
    quickAddOpen: !!document.querySelector('[data-testid="quick-add"]'),
    bodyHasDiscardPrompt: /discard/i.test(document.body.innerText),
  }));
}

await page.reload();
await page.waitForLoadState();
await page.waitForTimeout(2500);

const afterReload = await page.evaluate(() => ({
  taskTitles: [...document.querySelectorAll('[data-item-id], li')].map((n) => n.innerText).filter(Boolean).slice(0, 30),
  hasToOrTod: /(^|\W)(to|tod|totod)(\W|$)/i.test(document.body.innerText),
}));

const out = { state1, state2, afterReload };
await fs.writeFile(`${OUT}/td-discard-check.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
