const task = await taskSpace(29);
const page = task.page("p1");
const DIR =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const describeModal = () =>
  page.evaluate(() => {
    const modal =
      document.querySelector('[data-testid="task-details-modal"]') ??
      document.querySelector('[role="dialog"]');
    if (!modal) return { modalPresent: false, dialogs: document.querySelectorAll('[role="dialog"]').length };
    const cs = getComputedStyle(modal);
    return {
      modalPresent: true,
      testid: modal.getAttribute("data-testid"),
      rect: modal.getBoundingClientRect().toJSON(),
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
      boxShadow: cs.boxShadow,
      header: modal.querySelector("header")?.innerText.replace(/\n/g, " | ") ?? null,
      hasPrev: !!modal.querySelector('[aria-label="Previous Task"]'),
      hasNext: !!modal.querySelector('[aria-label="Next Task"]'),
      buttons: [...modal.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.innerText.trim()).filter(Boolean).slice(0, 25),
      text: modal.innerText.slice(0, 400).replace(/\n/g, " | "),
    };
  });

// ---- Open from TODO ----
await page.goto("http://127.0.0.1:5199/todo/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);
await page.click("text=buy milk", { label: "open task from Todo" });
await page.waitForTimeout(1500);
const todoUrl = await page.url();
console.log("=== TODO modal ===", { todoUrl });
console.log(await describeModal());
await page.screenshot({ path: `${DIR}/cmp-todo.png` });

const taskId = todoUrl.split("/todo/task/")[1] ?? "";
console.log("taskId param:", taskId);

// ---- Open the SAME task from COMPOSER ----
const rawId = taskId.includes("-") ? taskId.slice(taskId.lastIndexOf("-") + 1) : taskId;
for (const candidate of [rawId, taskId]) {
  await page.goto(`http://127.0.0.1:5199/composer?task=${candidate}`);
  await page.waitForLoadState();
  await page.waitForTimeout(2500);
  const info = await describeModal();
  console.log(`=== COMPOSER modal (task=${candidate}) ===`);
  console.log(info);
  if (info.modalPresent) {
    await page.screenshot({ path: `${DIR}/cmp-composer.png` });
    break;
  }
}
console.log("screenshots: cmp-todo.png, cmp-composer.png");
