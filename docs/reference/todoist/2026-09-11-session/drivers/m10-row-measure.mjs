const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  function leafColor(el, propGetter) {
    // walk descendants, find leaf text nodes' parent computed style
    const results = [];
    function walk(node) {
      if (node.children.length === 0) {
        results.push({ tag: node.tagName, class: node.className, text: node.textContent?.trim().slice(0,30), value: propGetter(getComputedStyle(node)) });
      } else {
        Array.from(node.children).forEach(walk);
      }
    }
    walk(el);
    return results;
  }

  const listItems = Array.from(document.querySelectorAll('li')).filter(li => li.querySelector('input[type=checkbox], input[aria-label]'));
  const rowMeasures = listItems.map((li, idx) => {
    const r = li.getBoundingClientRect();
    const cs = getComputedStyle(li);
    // title button
    const titleBtn = li.querySelector('button');
    let titleInfo = null;
    if (titleBtn) {
      const tcs = getComputedStyle(titleBtn);
      titleInfo = { fontSize: tcs.fontSize, lineHeight: tcs.lineHeight, color: tcs.color, text: titleBtn.textContent?.trim() };
    }
    return {
      idx,
      height: Math.round(r.height),
      width: Math.round(r.width),
      borderBottom: cs.borderBottom,
      borderTop: cs.borderTop,
      paddingLeft: cs.paddingLeft,
      titleInfo,
    };
  });

  return { rowMeasures, count: listItems.length };
});

console.log(JSON.stringify(result, null, 2));
