const task = await taskSpace(32);
const page = task.page("p1");
console.log(await page.snapshot());
