const task = await taskSpace(31);
const page = task.page("p1");
// We are already on settings/theme page from previous round (persists across reload? better re-navigate to be safe, read-only)
await page.goto("https://app.todoist.com/app/settings/theme", { waitUntil: "load" });
await page.waitForTimeout(1500);

const toggles = await page.evaluate(() => {
  // find toggle-like buttons near "Sync theme" and "Auto Dark Mode" text
  const all = [...document.querySelectorAll('button, [role="switch"], input[type="checkbox"]')];
  const results = [];
  for (const el of all) {
    const container = el.closest('div');
    const text = container ? container.textContent.trim().slice(0, 60) : '';
    if (/sync theme/i.test(text) || /auto dark/i.test(text)) {
      results.push({
        tag: el.tagName,
        ariaChecked: el.getAttribute('aria-checked'),
        checked: el.checked,
        classList: el.className,
        nearText: text,
      });
    }
  }
  return results;
});
console.log("toggles:", JSON.stringify(toggles, null, 2));

const macAppearance = await page.evaluate(() => ({
  prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
  prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  htmlClass: document.documentElement.className,
}));
console.log("mediaCheck:", JSON.stringify(macAppearance, null, 2));
