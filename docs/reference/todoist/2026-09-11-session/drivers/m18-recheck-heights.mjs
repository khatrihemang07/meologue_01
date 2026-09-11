const task = await taskSpace(32);
const page = task.page("p1");
await page.waitForTimeout(500);

const result = await page.evaluate(() => {
  const rowBoxes = Array.from(document.querySelectorAll('[data-task-row-box]'));
  return rowBoxes.map((el) => {
    const r = el.getBoundingClientRect();
    const titleBtn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.trim().length > 0 && !b.getAttribute('aria-label'));
    const titleCs = titleBtn ? getComputedStyle(titleBtn) : null;
    // description leaf (a span/div with class truncate maybe, sibling of title container)
    const allLeaves = Array.from(el.querySelectorAll('*')).filter(x => x.children.length === 0);
    const descLeaf = allLeaves.find(x => /shampoo/.test(x.textContent||''));
    const descCs = descLeaf ? getComputedStyle(descLeaf) : null;
    return {
      height: Math.round(r.height),
      title: titleBtn ? titleBtn.textContent.trim().slice(0,50) : null,
      titleWhiteSpace: titleCs?.whiteSpace,
      titleOverflow: titleCs?.textOverflow,
      titleLineClamp: titleCs?.webkitLineClamp,
      titleClass: titleBtn?.className,
      descText: descLeaf ? descLeaf.textContent.trim() : null,
      descWhiteSpace: descCs?.whiteSpace,
      descClass: descLeaf?.className,
    };
  });
});

console.log(JSON.stringify(result, null, 2));
