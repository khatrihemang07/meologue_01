const task = await taskSpace(31);
const page = task.page("p1");

await page.cdp("Page.reload", { ignoreCache: true });
await page.waitForLoadState("load");
await page.waitForTimeout(3000);

const state = await page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  bodyColor: getComputedStyle(document.body).color,
  darkReaderStyleCount: document.querySelectorAll("style.darkreader").length,
  darkReaderClassCount: document.querySelectorAll('[class*="darkreader"]').length,
  darkReaderInlineBgCount: document.querySelectorAll('[data-darkreader-inline-bgcolor]').length,
  readyState: document.readyState,
  url: location.href,
}));
console.log("DARK RESTORE VERIFY:", JSON.stringify(state, null, 2));

const path = await page.screenshot({ path: "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad/l13-dark-restored.png" });
console.log("screenshot:", path);

// Also navigate to Today to confirm the theme swatch state and task list is unchanged
await page.goto("https://app.todoist.com/app/today");
await page.waitForTimeout(2000);
const counts = await page.evaluate(() => {
  const inbox = document.querySelector('a[aria-label^="Inbox"]')?.getAttribute("aria-label");
  const today = document.querySelector('a[aria-label^="Today"]')?.getAttribute("aria-label");
  const gettingStarted = document.querySelector('a[aria-label^="Getting Started"]')?.getAttribute("aria-label");
  return { inbox, today, gettingStarted };
});
console.log("TASK COUNTS:", JSON.stringify(counts, null, 2));
