const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const out = await page.evaluate(() => {
  const body = document.body;
  const sidebar = document.querySelector('[class*="sidebar" i], nav');
  const main = document.querySelector('[aria-label="Main Content"], main, [role="main"]');
  const li = document.querySelector('li[data-item-id]');
  const g = (el) => (el ? getComputedStyle(el).backgroundColor : null);
  const gc = (el) => (el ? getComputedStyle(el).color : null);
  return {
    htmlClass: document.documentElement.className,
    bodyBg: g(body),
    bodyColor: gc(body),
    sidebarBg: g(sidebar),
    mainBg: g(main),
    rowBg: g(li),
    rowBorderBottom: li ? getComputedStyle(li).borderBottom : null,
    rowHeight: li ? Math.round(li.getBoundingClientRect().height) : null,
    titleLeafColor: (() => {
      const t = li ? li.querySelector("div.task_content") : null;
      if (!t) return null;
      // walk to find leaf text node's span
      const span = t.querySelector("span, div");
      return { wrapper: getComputedStyle(t).color, innerLeaf: span ? getComputedStyle(span).color : null };
    })(),
  };
});

await fs.writeFile(`${OUT}/td-bg-check-light.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
