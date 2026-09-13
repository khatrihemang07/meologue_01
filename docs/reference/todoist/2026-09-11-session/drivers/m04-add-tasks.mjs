const task = await taskSpace(32);
const page = task.page("p1");

async function addTask(text) {
  const snap = await page.snapshot();
  // find the Add a Task textfield
  await page.click("loc=role:textbox[name='Add a Task']").catch(async () => {
    await page.click("text=Add a Task");
  });
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
}

await addTask("Room clean tod");
await addTask("hair wash tmr p1");
await addTask("naukri photo update tmr");
await page.waitForTimeout(800);
console.log(await page.snapshot());
