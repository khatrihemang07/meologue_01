// Todoist capture pass 2 — STEP 1: read-only reconnaissance.
// Writes nothing. Establishes: are we logged in, what theme is active,
// what data exists, and what the Inbox canary looks like before anything.
const task = await taskSpace("todoist capture pass 2");
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(6000);

console.log("SPACE_ID:", task.spaceId);
console.log("URL:", await page.url());
console.log("TITLE:", await page.title());

console.log(
  await page.evaluate(() => {
    const root = document.documentElement;
    const text = document.body.innerText;
    return {
      looksLoggedIn: !/log in|sign up/i.test(text.slice(0, 300)),
      htmlClass: root.className,
      dataTheme: root.getAttribute("data-theme"),
      colorScheme: getComputedStyle(root).colorScheme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodyFontSize: getComputedStyle(document.body).fontSize,
      // The Inbox canary: exact task names + count, so anything this
      // pass creates or changes can be proven reverted afterwards.
      taskCount: document.querySelectorAll('[data-item-id]').length,
      taskNames: [...document.querySelectorAll('[data-item-id]')]
        .map((n) => n.innerText.split("\n")[0])
        .slice(0, 30),
      bodySnippet: text.slice(0, 500),
    };
  }),
);

console.log("=== SNAPSHOT ===");
console.log(await page.snapshot());
