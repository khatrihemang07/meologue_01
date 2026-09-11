const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  const listItems = Array.from(document.querySelectorAll('li')).filter(li => li.querySelector('input[type=checkbox], input[aria-label]'));
  const rowMeasures = listItems.map((li, idx) => {
    const r = li.getBoundingClientRect();
    const cs = getComputedStyle(li);
    const buttons = Array.from(li.querySelectorAll('button'));
    const titleBtn = buttons.find(b => b.textContent.trim().length > 0 && !b.getAttribute('aria-label'));
    let titleInfo = null;
    if (titleBtn) {
      const tcs = getComputedStyle(titleBtn);
      titleInfo = { fontSize: tcs.fontSize, lineHeight: tcs.lineHeight, color: tcs.color, text: titleBtn.textContent?.trim() };
    }
    // find date text element (sibling of title button)
    const dateEls = Array.from(li.querySelectorAll('*')).filter(el => el.children.length === 0 && /Today|Tomorrow/.test(el.textContent || ''));
    const dateInfo = dateEls.map(el => {
      const dcs = getComputedStyle(el);
      return { text: el.textContent.trim(), fontSize: dcs.fontSize, color: dcs.color, tag: el.tagName, class: el.className };
    });
    return {
      idx,
      liClass: li.className,
      height: Math.round(r.height),
      width: Math.round(r.width),
      cs_borderBottom: cs.borderBottom,
      cs_borderBottomWidth: cs.borderBottomWidth,
      cs_boxShadow: cs.boxShadow,
      titleInfo,
      dateInfo,
    };
  });
  return { rowMeasures, count: listItems.length };
});

console.log(JSON.stringify(result, null, 2));
