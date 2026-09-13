const task = await taskSpace(29);
const page = task.page("p1");
const DIR =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const describeModal = () =>
  page.evaluate(() => {
    const modal =
      document.querySelector('[data-testid="task-details-modal"]') ??
      document.querySelector('[role="dialog"]');
    if (!modal) {
      return {
        modalPresent: false,
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
        body: document.body.innerText.slice(0, 300).replace(/\n+/g, " | "),
      };
    }
    const cs = getComputedStyle(modal);
    const r = modal.getBoundingClientRect();
    return {
      modalPresent: true,
      testid: modal.getAttribute("data-testid"),
      size: `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`,
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
      header: modal.querySelector("header")?.innerText.replace(/\n+/g, " | ") ?? null,
      hasPrev: !!modal.querySelector('[aria-label="Previous Task"]'),
      hasNext: !!modal.querySelector('[aria-label="Next Task"]'),
      text: modal.innerText.slice(0, 350).replace(/\n+/g, " | "),
    };
  });

const readEditor = () =>
  page.evaluate(() => {
    const ed = document.querySelector('[aria-label="Task name"]');
    return {
      editorPresent: !!ed,
      editorText: ed ? ed.textContent : null,
      matches: [...document.querySelectorAll('[data-testid="natural-language-match"]')].map((m) => ({
        text: m.textContent,
        matchId: m.getAttribute("data-match-id"),
      })),
    };
  });

// ================= Open the task from TODO =================
await page.goto("http://127.0.0.1:5199/todo/inbox");
await page.waitForLoadState();
await page.waitForTimeout(2000);
await page.click("button[aria-label='Edit \"buy milk tom\"'] ~ button", { label: "noop" }).catch(() => {});
await page.click("text=buy milk tom", { label: "open task detail from Todo" });
await page.waitForTimeout(1800);
const todoUrl = await page.url();
console.log("=== TODO modal ===", { todoUrl });
console.log(await describeModal());
await page.screenshot({ path: `${DIR}/cmp-todo.png` });

// ---- ISSUE 1b: rename inside the DETAIL title ----
await page.click("text=buy milk tom", { label: "activate detail title editor" });
await page.waitForTimeout(1200);
console.log("=== detail title editor opened ===", await readEditor());
await page.keyboard.type(" tmr");
await page.waitForTimeout(800);
console.log("=== after typing ' tmr' in DETAIL title ===", await readEditor());
await page.keyboard.press("Enter");
await page.waitForTimeout(1800);
console.log("=== DETAIL modal after commit ===", await describeModal());

const taskId = todoUrl.split("/todo/task/")[1] ?? "";
console.log("taskId param:", taskId);

// ================= Open the SAME task from COMPOSER =================
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
