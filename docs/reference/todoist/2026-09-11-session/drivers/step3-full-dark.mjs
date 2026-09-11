// Full DARK capture: composer, recognition span, backspace behavior,
// scheduler popover, Repeat dialog, Time dialog. All inside an UNSAVED draft.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";
const out = {};

// Sanity: dialog should already be open with "tod" typed from previous round.
out.preState = await page.evaluate(() => {
  const d = document.querySelector('[data-testid="quick-add"]');
  const tf = d ? d.querySelector('[aria-label="Task name"], [contenteditable="true"], textarea') : null;
  return {
    dialogPresent: !!d,
    text: tf ? tf.textContent || tf.value : null,
  };
});

// ---- 1. Composer geometry (full, with toolbar present) ----
out.composer = await page.evaluate(() => {
  const d = document.querySelector('[data-testid="quick-add"]');
  if (!d) return { found: false };
  const s = getComputedStyle(d);
  const r = d.getBoundingClientRect();
  return {
    found: true,
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

// ---- 2. Recognition span for "tod" ----
out.recognitionBefore = await page.evaluate(() => {
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

// ---- Backspace once: should withdraw recognition, delete NO character ----
await page.keyboard.press("Backspace");
await page.waitForTimeout(700);
out.afterBackspace1 = await page.evaluate(() => {
  const d = document.querySelector('[data-testid="quick-add"]');
  const tf = d.querySelector('[aria-label="Task name"], [contenteditable="true"]');
  const m = document.querySelector('[data-testid="natural-language-match"]');
  return {
    text: tf ? tf.textContent : null,
    matchStillPresent: !!m,
    matchHighlighted: m ? m.getAttribute("data-highlighted-match") : null,
  };
});

// ---- Backspace again: now a character should be deleted ----
await page.keyboard.press("Backspace");
await page.waitForTimeout(700);
out.afterBackspace2 = await page.evaluate(() => {
  const d = document.querySelector('[data-testid="quick-add"]');
  const tf = d.querySelector('[aria-label="Task name"], [contenteditable="true"]');
  const m = document.querySelector('[data-testid="natural-language-match"]');
  return {
    text: tf ? tf.textContent : null,
    matchStillPresent: !!m,
  };
});

// Retype "tod" so the scheduler-open step below is representative (date chip present)
await page.keyboard.type("tod");
await page.waitForTimeout(1000);

// ---- 3. Open scheduler popover from footer "Set date" control ----
await page.click('loc=role:button[name="Set date"]', { label: "open scheduler popover" }).catch((e) => {
  out.schedulerOpenError = e.message;
});
await page.waitForTimeout(1200);

out.scheduler = await page.evaluate(() => {
  const candidates = [
    '[data-testid="scheduler-view"]',
    '[data-testid="scheduler"]',
    '[role="dialog"][aria-label*="date" i]',
  ];
  let v = null;
  for (const sel of candidates) {
    v = document.querySelector(sel);
    if (v) break;
  }
  if (!v) {
    // fall back: any newly appeared dialog/popover other than quick-add
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="menu"]')];
    v = dialogs.find((el) => el.getAttribute("data-testid") !== "quick-add") || null;
  }
  if (!v) return { found: false, dialogCount: document.querySelectorAll('[role="dialog"]').length };
  const s = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  const rows = [...v.querySelectorAll("button, [role='option'], li")]
    .map((b) => b.innerText.replace(/\n+/g, " | ").trim())
    .filter((t) => t && t.length < 80);
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
    position: s.position,
    rows: rows.slice(0, 25),
    hasRepeatButton: /repeat/i.test(v.innerText),
    hasTimeButton: /^time$|\btime\b/i.test(v.innerText),
    fullText: v.innerText.replace(/\n+/g, " | ").slice(0, 900),
  };
});
await page.screenshot({ path: `${OUT}/td-scheduler-dark.png` });

await fs.writeFile(`${OUT}/td-quickadd-dark.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
