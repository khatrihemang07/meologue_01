const task = await taskSpace(30);
const page = task.page("p1");
console.log(await page.snapshot());
