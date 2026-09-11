// Todoist capture pass 2 — STEP 5: Quick Add + scheduler, DARK theme.
// Everything happens inside an UNSAVED draft, discarded with Escape at the
// end. Nothing is submitted; no task is created.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(4000);

// ---- Open Quick Add (creates nothing until submitted) ----
await page.click("button:has-text('Add task') >> nth=0", { label: "open Quick Add" });
await page.waitForTimeout(2000);

out.composer = await page.evaluate(() => {
  const d = document.querySelector('[data-testid="quick-add"]') ?? document.querySelector('[role="dialog"]');
  if (!d) return { found: false, dialogs: document.querySelectorAll('[role="dialog"]').length };
  const s = getComputedStyle(d);
  const r = d.getBoundingClientRect();
  return {
    found: true,
    testid: d.getAttribute("data-testid"),
    ariaLabel: d.getAttribute("aria-label"),
    size: `${Math.round(r.width)}x${Math.round(r.height)}`,
    radius: s.borderRadius,
    padding: s.padding,
    bg: s.backgroundColor,
    border: s.border,
    shadow: s.boxShadow,
    footerButtons: [...d.querySelectorAll("button")]
      .map((b) => (b.getAttribute("aria-label") || b.innerText || "").trim().replace(/\n+/g, " "))
      .filter(Boolean),
  };
});

// ---- Recognition: type "tod" into the unsaved title ----
await page.click('[aria-label="Task name"]', { label: "focus Quick Add title" });
await page.keyboard.type("tod");
await page.waitForTimeout(1500);

out.recognition = await page.evaluate(() => {
  const m = document.querySelector('[data-testid="natural-language-match"]');
  if (!m) return { found: false };
  const s = getComputedStyle(m);
  const r = m.getBoundingClientRect();
  return {
    found: true,
    text: m.textContent,
    matchId: m.getAttribute("data-match-id"),
    highlighted: m.getAttribute("data-highlighted-match"),
    display: s.display,
    paddingLeft: s.paddingLeft,
    paddingRight: s.paddingRight,
    bg: s.backgroundColor,
    color: s.color,
    radius: s.borderRadius,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    width: `${r.width.toFixed(2)}px`,
  };
});
await page.screenshot({ path: `${OUT}/td-quickadd-dark.png` });

// ---- Open the scheduler popover from the footer Date control ----
await page.click("button[aria-label*='date' i] >> nth=0", { label: "open scheduler" }).catch(async () => {
  await page.click("text=Date", { label: "open scheduler (fallback)" });
});
await page.waitForTimeout(2000);

out.scheduler = await page.evaluate(() => {
  const v = document.querySelector('[data-testid="scheduler-view"]');
  if (!v) return { found: false, body: document.body.innerText.slice(0, 300) };
  const s = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  const quick = [...v.querySelectorAll('[class*="scheduler-suggestions-item"], li, button')]
    .map((b) => b.innerText.replace(/\n+/g, " | ").trim())
    .filter((t) => t && t.length < 60);
  return {
    found: true,
    size: `${Math.round(r.width)}x${Math.round(r.height)}`,
    radius: s.borderRadius,
    bg: s.backgroundColor,
    border: s.border,
    shadow: s.boxShadow,
    zIndex: s.zIndex,
    position: s.position,
    quickOptions: quick.slice(0, 20),
    hasRepeatButton: /repeat/i.test(v.innerText),
    hasTimeButton: /time/i.test(v.innerText),
    fullText: v.innerText.replace(/\n+/g, " | ").slice(0, 600),
  };
});
await page.screenshot({ path: `${OUT}/td-scheduler-dark.png` });

// ---- Discard the draft: Escape out of everything ----
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
await page.keyboard.press("Escape");
await page.waitForTimeout(1200);
out.afterEscape = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  bodyHasDiscardPrompt: /discard/i.test(document.body.innerText),
  taskCount: document.querySelectorAll("li[data-item-id]").length,
}));

await fs.writeFile(`${OUT}/td-quickadd-dark.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
