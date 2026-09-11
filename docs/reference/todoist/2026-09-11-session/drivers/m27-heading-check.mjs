const task = await taskSpace(32);
const page = task.page("p1");
const result = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(el => el.textContent.includes('Due today') && el.children.length <= 3);
  const heading = els.find(el => /^(H[1-6])$/.test(el.tagName)) || els[0];
  const cs = heading ? getComputedStyle(heading) : null;
  return {
    tag: heading?.tagName,
    class: heading?.className,
    fontSize: cs?.fontSize,
    fontWeight: cs?.fontWeight,
    lineHeight: cs?.lineHeight,
    textAlign: cs?.textAlign,
    anyH1: document.querySelectorAll('h1').length,
  };
});
console.log(JSON.stringify(result, null, 2));
