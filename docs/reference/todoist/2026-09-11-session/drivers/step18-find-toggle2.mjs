const task = await taskSpace(30);
const page = task.page("p1");

const info = await page.evaluate(() => {
  const findByText = (txt) => [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent.trim() === txt);
  const syncLabel = findByText("Sync theme");
  const autoDarkLabel = findByText("Auto Dark Mode");
  const describeArea = (labelEl) => {
    if (!labelEl) return null;
    // climb up to find a row container, then list its buttons/inputs
    let row = labelEl;
    for (let i = 0; i < 4 && row; i++) row = row.parentElement;
    const controls = row ? [...row.querySelectorAll("button, input, [role]")].map((c) => ({
      tag: c.tagName,
      role: c.getAttribute("role"),
      ariaChecked: c.getAttribute("aria-checked"),
      ariaLabel: c.getAttribute("aria-label"),
      type: c.getAttribute("type"),
      checked: c.checked,
    })) : [];
    return { rowText: row?.innerText?.slice(0, 150), controls };
  };
  return {
    sync: describeArea(syncLabel),
    autoDark: describeArea(autoDarkLabel),
  };
});
console.log(JSON.stringify(info, null, 2));
