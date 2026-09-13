const task = await taskSpace(31);
const page = task.page("p1");

// Dark Reader contamination check
const darkReader = await page.evaluate(() => {
  const styleDR = document.querySelectorAll('style.darkreader').length;
  const classDR = document.querySelectorAll('[class*="darkreader"]').length;
  const inlineDR = document.querySelectorAll('[data-darkreader-inline-bgcolor]').length;
  const proxyInjected = document.documentElement.getAttribute('data-darkreader-proxy-injected');
  return { styleDR, classDR, inlineDR, proxyInjected };
});
console.log("darkReaderCheck:", JSON.stringify(darkReader, null, 2));

// Navigate read-only to settings > theme to read current selection without changing anything
await page.goto("https://app.todoist.com/app/settings/theme", { waitUntil: "load" });
await page.waitForTimeout(2000);

const settingsSnap = await page.evaluate(() => {
  const html = document.documentElement;
  const checked = [...document.querySelectorAll('[role="radio"], input[type="radio"]')].map(el => ({
    tag: el.tagName,
    name: el.getAttribute('aria-label') || el.getAttribute('name') || el.closest('label')?.textContent?.trim() || el.textContent?.trim(),
    checked: el.getAttribute('aria-checked') || el.checked,
  }));
  // toggles
  const switches = [...document.querySelectorAll('[role="switch"]')].map(el => ({
    label: el.getAttribute('aria-label') || el.closest('label')?.textContent?.trim() || el.closest('div')?.textContent?.trim()?.slice(0,80),
    checked: el.getAttribute('aria-checked'),
  }));
  return {
    htmlClass: html.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    radios: checked,
    switches,
  };
});
console.log("settingsSnap:", JSON.stringify(settingsSnap, null, 2));

const shot = await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/l02-settings-theme.png" });
console.log("screenshot:", shot);
