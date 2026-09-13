// Todoist capture pass 2 — STEP 10: hard numbers for NAV-09 / NAV-10.
// The ledger records NAV-09 as "~750px" with no measurement, and NAV-10
// only qualitatively. Both are visually confirmed; measure them. Read-only.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(4500);

const data = await page.evaluate(() => {
  const g = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      left: Math.round(r.left),
      right: Math.round(r.right),
    };
  };

  const firstRow = document.querySelector("li[data-item-id]");
  const list = firstRow?.closest("ul");

  // The view-name heading inside the content column (NAV-09).
  const heading = [...document.querySelectorAll("h1,h2,[role='heading']")].find((h) =>
    /^(Inbox|Today|Upcoming)$/i.test(h.innerText.trim()),
  );

  // The "+ Add task" affordance (NAV-10) — where does it sit relative to
  // the list: before the first row, or after the last?
  const addRow = [...document.querySelectorAll("button,div[role='button']")].find(
    (b) => b.innerText.trim() === "Add task" && b.closest("main,[role='main']"),
  );

  const sidebar = document.querySelector("nav")?.closest("div,aside");

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    heading: heading
      ? {
          text: heading.innerText.trim(),
          tag: heading.tagName.toLowerCase(),
          box: box(heading),
          fontSize: g(heading, "font-size"),
          fontWeight: g(heading, "font-weight"),
          lineHeight: g(heading, "line-height"),
          color: g(heading, "color"),
        }
      : null,
    list: { box: box(list), maxWidth: g(list, "max-width") },
    firstRow: { box: box(firstRow) },
    sidebar: { box: box(sidebar), bg: g(sidebar, "background-color") },
    addTaskRow: addRow
      ? {
          text: addRow.innerText.trim(),
          box: box(addRow),
          color: g(addRow, "color"),
          fontSize: g(addRow, "font-size"),
          // Decisive for NAV-10: is it above or below the first task row?
          isBelowFirstRow: firstRow
            ? addRow.getBoundingClientRect().top > firstRow.getBoundingClientRect().top
            : null,
        }
      : null,
  };
});

await fs.writeFile(`${OUT}/td-nav-geometry.json`, JSON.stringify(data, null, 2));
console.log(JSON.stringify(data, null, 1));
