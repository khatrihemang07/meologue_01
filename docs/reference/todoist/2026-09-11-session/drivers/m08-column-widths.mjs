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
      rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
      bg: cs.backgroundColor,
    };
  }
  const addBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Add');
  const ancestors = [];
  let node = addBtn;
  for (let i = 0; i < 14 && node; i++) {
    ancestors.push(describe(node));
    node = node.parentElement;
  }
  // find h1 heading
  const h1 = document.querySelector('h1');
  const h1cs = h1 ? getComputedStyle(h1) : null;
  return {
    ancestorsFromAddBtn: ancestors,
    h1: h1 ? { text: h1.textContent, fontSize: h1cs.fontSize, fontWeight: h1cs.fontWeight, lineHeight: h1cs.lineHeight, textAlign: h1cs.textAlign, rect: h1.getBoundingClientRect() } : null,
  };
});

console.log(JSON.stringify(result, null, 2));
