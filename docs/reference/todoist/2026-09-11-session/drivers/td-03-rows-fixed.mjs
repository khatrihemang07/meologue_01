// Todoist capture pass 2 — STEP 3: row anatomy, CORRECTED selectors.
// Uses the corpus's own verified selectors (div.task_content,
// button[data-testid="due-date-control"], button.task_checkbox + its
// nested visible ring span). Read-only: no clicks, no typing.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const capture = () =>
  page.evaluate(() => {
    const g = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop) : null);

    const rows = [...document.querySelectorAll("li[data-item-id]")].map((li) => {
      const title = li.querySelector("div.task_content");
      const dateBtn = li.querySelector('[data-testid="due-date-control"]');
      const box = li.querySelector("button.task_checkbox");
      // The corpus: the visible ring is a NESTED span, ~18x18, border-radius 50%.
      const ring = box
        ? [...box.querySelectorAll("span")].find((s) => {
            const r = s.getBoundingClientRect();
            return r.width > 12 && r.width < 24 && getComputedStyle(s).borderRadius !== "0px";
          })
        : null;
      // Which group/section is this row under? Walk up to the nearest
      // container that carries a heading, and read that heading's text.
      let heading = null;
      let node = li;
      while (node && !heading) {
        node = node.parentElement;
        if (!node) break;
        const h = node.querySelector("h1,h2,h3,[role='heading']");
        if (h && h.innerText.trim()) heading = h.innerText.trim().split("\n")[0];
      }
      return {
        id: li.getAttribute("data-item-id"),
        title: title ? title.innerText.trim().slice(0, 60) : null,
        section: heading,
        ariaChecked: box ? box.getAttribute("aria-checked") : null,
        checkboxClasses: box ? box.className : null,
        titleColor: g(title, "color"),
        titleDecoration: g(title, "text-decoration-line"),
        dateText: dateBtn ? dateBtn.innerText.trim() : null,
        dateColor: g(dateBtn, "color"),
        ringSize: ring
          ? `${Math.round(ring.getBoundingClientRect().width)}x${Math.round(ring.getBoundingClientRect().height)}`
          : null,
        ringBorder: g(ring, "border"),
        ringBorderColor: g(ring, "border-color"),
        ringBg: g(ring, "background-color"),
        rowHeight: Math.round(li.getBoundingClientRect().height),
        rowBg: g(li, "background-color"),
        rowBorderBottom: g(li, "border-bottom"),
      };
    });

    // Every heading actually present, in document order — tells us how the
    // list is grouped (e.g. an "Overdue" group) without guessing.
    const headings = [...document.querySelectorAll("h1,h2,h3,[role='heading']")]
      .map((h) => h.innerText.trim().split("\n")[0])
      .filter(Boolean);

    return { url: location.pathname, headings, rowCount: rows.length, rows };
  });

const out = {};
await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(4500);
out.inbox = await capture();
await page.screenshot({ path: `${OUT}/td-inbox-dark.png` });

await page.goto("https://app.todoist.com/app/today");
await page.waitForLoadState();
await page.waitForTimeout(4500);
out.today = await capture();
await page.screenshot({ path: `${OUT}/td-today-dark.png` });

await fs.writeFile(`${OUT}/td-rows-fixed.json`, JSON.stringify(out, null, 2));
for (const view of ["inbox", "today"]) {
  const v = out[view];
  console.log(`\n===== ${view.toUpperCase()} (${v.url}) rows=${v.rowCount} =====`);
  console.log("headings:", JSON.stringify(v.headings));
  for (const r of v.rows) {
    console.log(
      `[${r.section ?? "-"}] ${JSON.stringify(r.title)} checked=${r.ariaChecked} ` +
        `title=${r.titleColor}/${r.titleDecoration} date=${JSON.stringify(r.dateText)}:${r.dateColor} ` +
        `ring=${r.ringSize} ${r.ringBorder} h=${r.rowHeight}`,
    );
  }
}
