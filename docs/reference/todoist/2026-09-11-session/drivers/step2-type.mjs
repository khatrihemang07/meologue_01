const task = await taskSpace(30);
const page = task.page("p1");
await page.click('[data-testid="quick-add"] [aria-label="Task name"]', { label: "focus quick add title" }).catch(async (e) => {
  console.log("click by aria-label failed:", e.message);
  await page.click('loc=role:dialog[name="Quick Add"]');
});
await page.keyboard.type("tod");
await page.waitForTimeout(1500);
console.log(await page.snapshot());
