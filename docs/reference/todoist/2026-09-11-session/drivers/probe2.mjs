const task = await taskSpace(29);
const page = task.page("p1");

const tabs = await task.tabs();
console.log("=== TABS ===");
for (const t of tabs) {
  console.log({
    label: t.label ?? null,
    url: t.url,
    title: t.title,
    active: t.active,
    openedBy: t.openedBy,
  });
}

console.log("=== APP STATE ===");
console.log(
  await page.evaluate(() => {
    const quick = document.querySelector('[aria-label="Add a Task"]');
    return {
      quickTag: quick ? quick.tagName : null,
      quickRole: quick ? quick.getAttribute("role") : null,
      quickDisabled: quick ? quick.hasAttribute("disabled") : null,
      quickContentEditable: quick ? quick.getAttribute("contenteditable") : null,
      taskRowCount: document.querySelectorAll('[data-testid="task-row"]').length,
      liCount: document.querySelectorAll("li").length,
      bodySnippet: document.body.innerText.slice(0, 400),
    };
  }),
);
