const task = await taskSpace(30);
const page = task.page("p1");

// List ALL checkbox inputs on the page with their bounding rect + nearest
// preceding label text found by walking backward through the DOM order.
const info = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  return boxes.map((cb, i) => {
    const r = cb.getBoundingClientRect();
    // Find nearest text by looking at siblings / ancestor row
    let row = cb.parentElement;
    for (let h = 0; h < 3 && row; h++) {
      const txt = row.innerText?.trim();
      if (txt) return { i, checked: cb.checked, rect: `${Math.round(r.x)},${Math.round(r.y)}`, rowText: txt.slice(0, 60) };
      row = row.parentElement;
    }
    return { i, checked: cb.checked, rect: `${Math.round(r.x)},${Math.round(r.y)}`, rowText: null };
  });
});
console.log(JSON.stringify(info, null, 2));
