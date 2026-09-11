// Todoist capture pass 2 — STEP 2: read-only row anatomy + canary, DARK theme.
// Clicks nothing, types nothing, submits nothing. Pure measurement.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(5000);

const data = await page.evaluate(() => {
  const cs = (el, prop, pseudo) =>
    el ? getComputedStyle(el, pseudo ?? null).getPropertyValue(prop) : null;

  // Sidebar: record the live nav order, including anything the corpus
  // never saw (a "Reporting" row appeared since the last capture).
  const nav = [...document.querySelectorAll('nav a[aria-label], nav button[aria-label]')].map(
    (a) => ({
      label: a.getAttribute("aria-label"),
      href: a.getAttribute("href"),
      text: a.innerText.replace(/\n+/g, " | ").trim(),
    }),
  );

  // Rows. Todoist's task rows carry data-item-id on the <li>.
  const rows = [...document.querySelectorAll("li[data-item-id]")].map((li) => {
    const content = li.querySelector('[data-testid="task-content"]') ?? li;
    const titleEl =
      li.querySelector(".task_content") ?? content.querySelector("div[dir], span");
    const dateEl =
      li.querySelector('[data-testid="task-due-date"]') ??
      [...li.querySelectorAll("span,div")].find((n) =>
        /today|tomorrow|yesterday|mon|tue|wed|thu|fri|sat|sun|\d{1,2} \w{3}/i.test(
          n.innerText ?? "",
        ) && n.children.length === 0,
      );
    const checkbox = li.querySelector('[class*="task_checkbox"], button[aria-label^="Complete"]');
    return {
      id: li.getAttribute("data-item-id"),
      fullText: li.innerText.replace(/\n+/g, " | "),
      title: titleEl ? titleEl.innerText.trim() : null,
      titleFontSize: cs(titleEl, "font-size"),
      titleLineHeight: cs(titleEl, "line-height"),
      titleColor: cs(titleEl, "color"),
      rowHeight: Math.round(li.getBoundingClientRect().height),
      dateText: dateEl ? dateEl.innerText.trim() : null,
      dateColor: cs(dateEl, "color"),
      checkboxClass: checkbox ? checkbox.className : null,
      checkboxBorderColor: cs(checkbox, "border-color"),
      checkboxBg: cs(checkbox, "background-color"),
      checkboxSize: checkbox
        ? `${Math.round(checkbox.getBoundingClientRect().width)}x${Math.round(checkbox.getBoundingClientRect().height)}`
        : null,
    };
  });

  return {
    theme: document.documentElement.className,
    bodyBg: cs(document.body, "background-color"),
    contentBg: cs(document.querySelector("main") ?? document.body, "background-color"),
    nav,
    rowCount: rows.length,
    rows,
  };
});

await fs.writeFile(`${OUT}/td-rows-dark.json`, JSON.stringify(data, null, 2));
console.log("wrote td-rows-dark.json");
console.log("theme:", data.theme, "bodyBg:", data.bodyBg, "contentBg:", data.contentBg);
console.log("rowCount:", data.rowCount);
console.log("NAV:", JSON.stringify(data.nav, null, 1));
console.log("ROWS:", JSON.stringify(data.rows, null, 1).slice(0, 4000));

await page.screenshot({ path: `${OUT}/td-inbox-dark.png` });
console.log("wrote td-inbox-dark.png");
