// Todoist capture pass 2 — STEP 7: decisive light-theme retry.
// Hypothesis the previous agent missed: prefers-color-scheme is dark at the
// browser level. Force it to light FIRST, verify inside the page, and only
// then switch themes. Restores "Dark" at the end unconditionally.
const task = await taskSpace(30);
const page = task.page("p1");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

async function forceLight() {
  await page.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
}

const measure = (tag) =>
  page.evaluate((t) => {
    const g = (el, p) => getComputedStyle(el).getPropertyValue(p);
    const row = document.querySelector("li[data-item-id]");
    const title = row?.querySelector("div.task_content");
    const dateSpans = row
      ? [...row.querySelectorAll('[data-testid="due-date-control"] span')].filter(
          (s) => s.children.length === 0 && s.textContent.trim(),
        )
      : [];
    return {
      tag: t,
      htmlClass: document.documentElement.className,
      prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      bodyBg: g(document.body, "background-color"),
      bodyColor: g(document.body, "color"),
      contentBg: row ? g(row.parentElement, "background-color") : null,
      rowBg: row ? g(row, "background-color") : null,
      rowBorderBottom: row ? g(row, "border-bottom") : null,
      titleColor: title ? g(title, "color") : null,
      dateText: dateSpans[0]?.textContent.trim() ?? null,
      dateColor: dateSpans[0] ? g(dateSpans[0], "color") : null,
    };
  }, tag);

async function pickTheme(name) {
  await page.goto("https://app.todoist.com/app/settings/theme");
  await page.waitForLoadState();
  await page.waitForTimeout(4000);
  await page.click(`button[role="radio"]:has-text("${name}")`, { label: `select ${name} theme` });
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Update")', { label: "persist theme" });
  await page.waitForTimeout(3000);
  await page.goto("https://app.todoist.com/app/inbox");
  await page.reload();
  await page.waitForLoadState();
  await page.waitForTimeout(5000);
}

await forceLight();
console.log("pre-check:", JSON.stringify(await measure("before"), null, 1));

for (const name of ["Todoist", "Moonstone"]) {
  await forceLight();
  await pickTheme(name);
  const m = await measure(name);
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(m, null, 1));
  await page.screenshot({ path: `${OUT}/td-retry-${name.toLowerCase()}.png` });
  if (m.bodyBg && !/rgb\((\d+), (\d+), (\d+)\)/.test(m.bodyBg)) continue;
  const [r, g2, b] = (m.bodyBg.match(/\d+/g) ?? []).map(Number);
  if (r > 200 && g2 > 200 && b > 200) {
    console.log(`*** ${name} IS LIGHT — bodyBg ${m.bodyBg} ***`);
    break;
  }
}

// ---- Unconditional restore ----
await page.cdp("Emulation.setEmulatedMedia", { features: [] });
await pickTheme("Dark");
const restored = await measure("restored");
console.log("\n=== RESTORE CHECK ===");
console.log(JSON.stringify(restored, null, 1));
console.log(
  restored.htmlClass.includes("theme_dark") && restored.bodyBg === "rgb(38, 38, 38)"
    ? "RESTORE OK"
    : "RESTORE FAILED — INVESTIGATE",
);
