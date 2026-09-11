const task = await taskSpace(32);
const page = task.page("p1");
// full reload to inbox to attempt to reclaim lock
await page.goto("http://127.0.0.1:5188/todo/inbox");
await page.waitForTimeout(1500);
const locked = await page.evaluate(() => document.body.innerText.includes("already open in another window"));
console.log("locked after reload to inbox:", locked);
if (locked) {
  await page.reload();
  await page.waitForTimeout(1500);
  const locked2 = await page.evaluate(() => document.body.innerText.includes("already open in another window"));
  console.log("locked after explicit reload:", locked2);
}
console.log(await page.snapshot());
