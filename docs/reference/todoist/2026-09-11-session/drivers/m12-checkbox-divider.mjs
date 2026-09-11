const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  function measureCheckbox(label) {
    const input = document.querySelector(`input[aria-label="${label}"]`);
    if (!input) return null;
    const cs = getComputedStyle(input);
    const r = input.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      boxShadow: cs.boxShadow,
      borderRadius: cs.borderRadius,
    };
  }
  const roomClean = measureCheckbox('Room clean');
  const hairWash = measureCheckbox('hair wash');

  // divider: data-task-row-box elements
  const rowBoxes = Array.from(document.querySelectorAll('[data-task-row-box]'));
  const dividerInfo = rowBoxes.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const li = el.closest('li');
    const liRect = li ? li.getBoundingClientRect() : null;
    return {
      x: Math.round(r.x),
      width: Math.round(r.width),
      liX: liRect ? Math.round(liRect.x) : null,
      liWidth: liRect ? Math.round(liRect.width) : null,
      borderBottomWidth: cs.borderBottomWidth,
      borderBottomStyle: cs.borderBottomStyle,
      borderBottomColor: cs.borderBottomColor,
      paddingLeft: cs.paddingLeft,
    };
  });

  return { roomClean, hairWash, dividerInfo };
});

console.log(JSON.stringify(result, null, 2));
