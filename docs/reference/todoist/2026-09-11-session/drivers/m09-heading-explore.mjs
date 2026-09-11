const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  function describe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      class: el.className,
      text: el.textContent?.trim().slice(0,60),
      rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      textAlign: cs.textAlign,
    };
  }
  // find all elements whose direct text is exactly "Todo"
  const allEls = Array.from(document.querySelectorAll('*'));
  const todoEls = allEls.filter(el => {
    const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    return directText === 'Todo';
  }).map(describe);

  // headings of any level
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).map(describe);

  return { todoEls, headings };
});

console.log(JSON.stringify(result, null, 2));
