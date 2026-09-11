const task = await taskSpace(29);
const page = task.page("p1");
const DIR =
  "/private/tmp/claude-501/-Users-mandalorian-Documents-Code-meologue-01-todoist-parity/4c1a0462-3bbb-4cf8-b3d6-49ca90a54d6b/scratchpad";

const TASK_UUID = "01a08f46-7ca3-76d0-8bff-21c02342958f";

const describeModal = () =>
  page.evaluate(() => {
    const locked = document.body.innerText.includes("already open in another window");
    const modal =
      document.querySelector('[data-testid="task-details-modal"]') ??
      document.querySelector('[role="dialog"]');
    if (!modal) {
      return {
        modalPresent: false,
        locked,
        dialogCount: document.querySelectorAll('[role="dialog"]').length,
        body: document.body.innerText.slice(0, 250).replace(/\n+/g, " | "),
      };
    }
    const cs = getComputedStyle(modal);
    const r = modal.getBoundingClientRect();
    return {
      modalPresent: true,
      locked,
      testid: modal.getAttribute("data-testid"),
      size: `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`,
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
      header: modal.querySelector("header")?.innerText.replace(/\n+/g, " | ") ?? null,
      hasPrev: !!modal.querySelector('[aria-label="Previous Task"]'),
      hasNext: !!modal.querySelector('[aria-label="Next Task"]'),
      hasClose: !!modal.querySelector('[aria-label="Close"]'),
      text: modal.innerText.slice(0, 350).replace(/\n+/g, " | "),
    };
  });

async function settle(url, label) {
  await page.goto(url);
  await page.waitForLoadState();
  await page.waitForTimeout(2500);
  let info = await describeModal();
  if (info.locked) {
    console.log(`[${label}] single-window lock seen — reloading once`);
    await page.reload();
    await page.waitForLoadState();
    await page.waitForTimeout(3000);
    info = await describeModal();
  }
  return info;
}

console.log("=== COMPOSER overlay ===");
const composer = await settle(`http://127.0.0.1:5199/composer?task=${TASK_UUID}`, "composer");
console.log(composer);
if (composer.modalPresent) {
  await page.screenshot({ path: `${DIR}/cmp-composer.png` });
  console.log("wrote cmp-composer.png");
}

console.log("=== TODO overlay (same task, for comparison) ===");
const todo = await settle(`http://127.0.0.1:5199/todo/task/${TASK_UUID}`, "todo");
console.log(todo);
if (todo.modalPresent) {
  await page.screenshot({ path: `${DIR}/cmp-todo.png` });
  console.log("wrote cmp-todo.png");
}
