// Todoist capture pass 2 — STEP 8: test the force-dark hypothesis.
// Two different themes returned IDENTICAL row/border/title colours
// (rgb(24,26,27) / rgb(53,57,59) / rgb(212,208,202)). Distinct themes can't
// share those — that is Chromium's auto-dark-mode inverter repainting a
// LIGHT page. Disable it via CDP and re-measure.
const task = await taskSpace(30);
const page = task.page("p1");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

async function killForceDark() {
  const tried = [];
  try {
    await page.cdp("Emulation.setAutoDarkModeOverride", { enabled: false });
    tried.push("setAutoDarkModeOverride(false) OK");
  } catch (e) {
    tried.push("setAutoDarkModeOverride FAILED: " + String(e).slice(0, 100));
  }
  try {
    await page.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    tried.push("emulate prefers-color-scheme:light OK");
  } catch (e) {
    tried.push("setEmulatedMedia FAILED: " + String(e).slice(0, 100));
  }
  console.log(tried.join(" | "));
}

const measure = (tag) =>
  page.evaluate((t) => {
    const g = (el, p) => getComputedStyle(el).getPropertyValue(p);
    const rows = [...document.querySelectorAll("li[data-item-id]")];
    const pick = (needle) =>
      rows.find((r) => (r.querySelector("div.task_content")?.innerText || "").includes(needle));
    const dateOf = (row) => {
      const s = row
        ? [...row.querySelectorAll('[data-testid="due-date-control"] span')].filter(
            (x) => x.children.length === 0 && x.textContent.trim(),
          )
        : [];
      return s[0] ? { text: s[0].textContent.trim(), color: g(s[0], "color") } : null;
    };
    const ringOf = (row) => {
      const box = row?.querySelector("button.task_checkbox");
      const spans = box ? [...box.querySelectorAll("span")] : [];
      const ring = spans.find((s) => g(s, "border-color") !== "rgba(0, 0, 0, 0)");
      return ring ? { w: g(ring, "border-width"), c: g(ring, "border-color") } : null;
    };
    const today = pick("Room clean");
    const tomorrow = pick("hair wash"); // P1 task, due Tomorrow
    const done = rows.find((r) => r.querySelector("button.task_checkbox")?.getAttribute("aria-checked") === "true");
    const p4 = pick("naukri photo update");
    return {
      tag: t,
      htmlClass: document.documentElement.className,
      prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      bodyBg: g(document.body, "background-color"),
      bodyColor: g(document.body, "color"),
      rowBg: today ? g(today, "background-color") : null,
      rowBorder: today ? g(today, "border-bottom") : null,
      titleColor: today ? g(today.querySelector("div.task_content"), "color") : null,
      completedTitle: done ? g(done.querySelector("div.task_content"), "color") : null,
      completedDecoration: done ? g(done.querySelector("div.task_content"), "text-decoration-line") : null,
      dateToday: dateOf(today),
      dateTomorrow: dateOf(tomorrow),
      dateCompleted: dateOf(done),
      ringP1: ringOf(tomorrow),
      ringP4: ringOf(p4),
    };
  }, tag);

async function pickTheme(name) {
  await page.goto("https://app.todoist.com/app/settings/theme");
  await page.waitForLoadState();
  await page.waitForTimeout(4000);
  await page.click(`button[role="radio"]:has-text("${name}")`, { label: `select ${name}` });
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Update")', { label: "persist theme" });
  await page.waitForTimeout(3000);
  await page.goto("https://app.todoist.com/app/inbox");
  await page.reload();
  await page.waitForLoadState();
  await page.waitForTimeout(5500);
}

await killForceDark();
await pickTheme("Todoist");
await killForceDark();
await page.reload();
await page.waitForLoadState();
await page.waitForTimeout(5500);

const light = await measure("Todoist-with-forcedark-off");
console.log("\n=== TODOIST THEME, auto-dark disabled ===");
console.log(JSON.stringify(light, null, 1));
await page.screenshot({ path: `${OUT}/td-light-REAL.png` });

const [r, g2, b] = (light.bodyBg.match(/\d+/g) ?? []).map(Number);
console.log(r > 200 && g2 > 200 && b > 200 ? "*** GENUINE LIGHT THEME CAPTURED ***" : "*** still dark ***");

// ---- Unconditional restore ----
try { await page.cdp("Emulation.setAutoDarkModeOverride", { enabled: false }); } catch {}
try { await page.cdp("Emulation.setEmulatedMedia", { features: [] }); } catch {}
await pickTheme("Dark");
const restored = await measure("restored");
console.log("\n=== RESTORE CHECK ===");
console.log(JSON.stringify({ htmlClass: restored.htmlClass, bodyBg: restored.bodyBg, dateToday: restored.dateToday }, null, 1));
console.log(
  restored.htmlClass.includes("theme_dark") && restored.bodyBg === "rgb(38, 38, 38)"
    ? "RESTORE OK"
    : "RESTORE FAILED — INVESTIGATE",
);
