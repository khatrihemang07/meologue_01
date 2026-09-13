const task = await taskSpace(29);
const page = task.page("p1");

await page.goto("http://127.0.0.1:5199/todo/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);

// --- Step 1: quick-add "buy milk tom" ---
await page.click('[aria-label="Add a Task"]', { label: "focus quick add field" });
await page.keyboard.type("buy milk tom");
await page.waitForTimeout(600);

console.log("=== A. QUICK ADD, before submit ===");
console.log(
  await page.evaluate(() => {
    const ed = document.querySelector('[aria-label="Add a Task"]');
    return {
      editorText: ed ? ed.textContent : null,
      matches: [...document.querySelectorAll('[data-testid="natural-language-match"]')].map((m) => ({
        text: m.textContent,
        matchId: m.getAttribute("data-match-id"),
        highlighted: m.getAttribute("data-highlighted-match"),
      })),
    };
  }),
);

await page.keyboard.press("Enter");
await page.waitForTimeout(1500);

console.log("=== B. AFTER SUBMIT: what got stored ===");
console.log(
  await page.evaluate(() => ({
    bodyText: document.body.innerText.slice(0, 900),
  })),
);

console.log("=== C. SNAPSHOT ===");
console.log(await page.snapshot());
