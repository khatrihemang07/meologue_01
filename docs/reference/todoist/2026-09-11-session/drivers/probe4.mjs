const task = await taskSpace(29);
const page = task.page("p1");

const read = () =>
  page.evaluate(() => {
    const ed = document.querySelector('[aria-label="Task name"]');
    return {
      editorPresent: !!ed,
      editorText: ed ? ed.textContent : null,
      matches: [...document.querySelectorAll('[data-testid="natural-language-match"]')].map((m) => ({
        text: m.textContent,
        matchId: m.getAttribute("data-match-id"),
        highlighted: m.getAttribute("data-highlighted-match"),
      })),
    };
  });

const rowOf = (needle) =>
  page.evaluate((n) => {
    const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(n));
    return li ? li.innerText.replace(/\n+/g, " | ") : "NOT FOUND";
  }, needle);

await page.goto("http://127.0.0.1:5199/todo/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);

console.log("=== C0. row before rename ===", await rowOf("buy milk"));

// ============ ISSUE 1a: INLINE ROW RENAME (Edit pencil) ============
await page.click("button[aria-label='Edit \"buy milk\"']", { label: "open inline title editor" });
await page.waitForTimeout(1000);
console.log("=== D. inline rename editor opened ===");
console.log(await read());

await page.keyboard.type(" tom");
await page.waitForTimeout(800);
console.log("=== E. after typing ' tom' in INLINE rename ===");
console.log(await read());

await page.keyboard.press("Enter");
await page.waitForTimeout(1800);
console.log("=== F. row after committing INLINE rename ===", await rowOf("buy milk"));

// ============ ISSUE 1b: DETAIL VIEW TITLE RENAME ============
await page.click("button[aria-label='Date \"buy milk tom\"']", { label: "probe row exists" }).catch(() => {});
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
