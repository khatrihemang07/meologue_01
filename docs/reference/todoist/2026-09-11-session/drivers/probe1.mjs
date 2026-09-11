const task = await taskSpace("meologue todoist parity nuances");
const page = task.page("p1");
await page.goto("http://127.0.0.1:5199/todo/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2500);
console.log("spaceId:", task.spaceId);
console.log("URL:", await page.url());
console.log(
  await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    wide: window.matchMedia("(min-width: 900px)").matches,
    lockText: document.body.innerText.includes("already open in another window"),
  })),
);
console.log(await page.snapshot());
