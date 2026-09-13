const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  const details = document.querySelector('details');
  if (!details) return { found: false };
  const li = details.querySelector('li');
  const titleEl = li ? li.querySelector('*') : null;
  // find the text node holding the title itself (first leaf with text)
  function firstLeafWithText(el) {
    if (!el) return null;
    if (el.children.length === 0 && el.textContent.trim()) return el;
    for (const child of el.children) {
      const found = firstLeafWithText(child);
      if (found) return found;
    }
    return null;
  }
  const leaf = firstLeafWithText(li);
  const cs = leaf ? getComputedStyle(leaf) : null;
  const dateSpans = li ? Array.from(li.querySelectorAll('*')).filter(el => /Today|Tomorrow|\d/.test(el.textContent||'') && el.children.length===0) : [];
  return {
    found: true,
    liHTML: li ? li.outerHTML.slice(0, 500) : null,
    leafTag: leaf ? leaf.tagName : null,
    leafText: leaf ? leaf.textContent.trim() : null,
    leafColor: cs ? cs.color : null,
    leafTextDecoration: cs ? cs.textDecorationLine : null,
    hasCheckboxInCompleted: !!li?.querySelector('input[type=checkbox]'),
    dateSpanTexts: dateSpans.map(d => d.textContent.trim()),
  };
});

console.log(JSON.stringify(result, null, 2));
