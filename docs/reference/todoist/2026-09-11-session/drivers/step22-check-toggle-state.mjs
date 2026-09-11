const task = await taskSpace(30);
const page = task.page("p1");

const info = await page.evaluate(() => {
  const findByText = (txt) => [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent.trim() === txt);
  const syncLabel = findByText("Sync theme");
  const autoLabel = findByText("Auto Dark Mode");
  const getCheckbox = (labelEl) => {
    let row = labelEl;
    for (let i = 0; i < 4 && row; i++) row = row.parentElement;
    return row ? row.querySelector('input[type="checkbox"]') : null;
  };
  const syncCb = getCheckbox(syncLabel);
  const autoCb = getCheckbox(autoLabel);
  return {
    htmlClass: document.documentElement.className,
    syncChecked: syncCb ? syncCb.checked : null,
    autoChecked: autoCb ? autoCb.checked : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log(JSON.stringify(info, null, 2));
