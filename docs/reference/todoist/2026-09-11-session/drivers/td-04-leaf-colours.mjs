// Todoist capture pass 2 — STEP 4: exhaustive leaf-level colour probe.
// Runs 2 and 3 disagreed because each guessed WHICH element is painted.
// This guesses nothing: it walks every descendant of the date control and
// the checkbox and reports each node's own computed colour/border, so the
// painted node is identified rather than assumed. Read-only.
const task = await taskSpace(30);
const page = task.page("p1");
const fs = await import("node:fs/promises");
const OUT =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(4500);

const data = await page.evaluate(() => {
  const describe = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 50),
      text: (el.textContent || "").trim().slice(0, 24),
      leaf: el.children.length === 0,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      color: s.color,
      borderWidth: s.borderWidth,
      borderColor: s.borderColor,
      bg: s.backgroundColor,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      svgFill: s.fill,
      svgStroke: s.stroke,
    };
  };
  const walk = (root) => {
    if (!root) return null;
    const out = [describe(root)];
    for (const el of root.querySelectorAll("*")) out.push(describe(el));
    return out;
  };

  return [...document.querySelectorAll("li[data-item-id]")].slice(0, 9).map((li) => {
    const box = li.querySelector("button.task_checkbox");
    return {
      title: (li.querySelector("div.task_content")?.innerText || "").trim().slice(0, 45),
      checked: box?.getAttribute("aria-checked"),
      checkboxClasses: box?.className,
      dateTree: walk(li.querySelector('[data-testid="due-date-control"]')),
      checkboxTree: walk(box),
    };
  });
});

await fs.writeFile(`${OUT}/td-leaf-colours.json`, JSON.stringify(data, null, 2));

for (const row of data) {
  console.log(`\n##### ${JSON.stringify(row.title)}  checked=${row.checked}`);
  console.log(`  classes: ${row.checkboxClasses}`);
  console.log("  -- DATE control tree --");
  for (const n of row.dateTree ?? []) {
    console.log(
      `    ${n.leaf ? "LEAF" : "    "} <${n.tag}> ${JSON.stringify(n.text)} color=${n.color} fill=${n.svgFill} size=${n.size} fs=${n.fontSize}`,
    );
  }
  console.log("  -- CHECKBOX tree --");
  for (const n of row.checkboxTree ?? []) {
    console.log(
      `    ${n.leaf ? "LEAF" : "    "} <${n.tag}> size=${n.size} bw=${n.borderWidth} bc=${n.borderColor} bg=${n.bg} fill=${n.svgFill}`,
    );
  }
}
