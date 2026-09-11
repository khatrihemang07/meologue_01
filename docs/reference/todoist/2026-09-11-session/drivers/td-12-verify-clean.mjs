// Todoist capture pass 2 — STEP 12: is Dark Reader actually restyling
// app.todoist.com, and are the measured colours genuine?
// The popup could not answer this (it reported on `about:`). Test the page.
// Also closes the spare page opened in step 11.
const task = await taskSpace(30);
const page = task.page("p1");

await page.goto("https://app.todoist.com/app/inbox");
await page.waitForLoadState();
await page.waitForTimeout(4500);

const result = await page.evaluate(() => {
  const g = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);

  // --- Is Dark Reader actively restyling THIS page? ---
  const drStyles = [...document.querySelectorAll("style")].filter((s) =>
    (s.className || "").toString().includes("darkreader"),
  );
  const drAny = document.querySelectorAll('[class*="darkreader"]').length;
  // Dark Reader rewrites inline style attributes with --darkreader-inline-*
  const drInline = document.querySelectorAll("[data-darkreader-inline-bgcolor]").length;

  // --- Re-read the colours that the headline finding rests on ---
  const rows = [...document.querySelectorAll("li[data-item-id]")];
  const pick = (n) =>
    rows.find((r) => (r.querySelector("div.task_content")?.innerText || "").includes(n));
  const dateLeaf = (row) => {
    if (!row) return null;
    const spans = [...row.querySelectorAll('[data-testid="due-date-control"] span')].filter(
      (s) => s.children.length === 0 && s.textContent.trim(),
    );
    return spans[0] ? { text: spans[0].textContent.trim(), color: g(spans[0], "color") } : null;
  };
  const ring = (row) => {
    const box = row?.querySelector("button.task_checkbox");
    if (!box) return null;
    const s = [...box.querySelectorAll("span")].find(
      (x) => g(x, "border-color") !== "rgba(0, 0, 0, 0)",
    );
    return s ? { width: g(s, "border-width"), color: g(s, "border-color") } : null;
  };
  const done = rows.find(
    (r) => r.querySelector("button.task_checkbox")?.getAttribute("aria-checked") === "true",
  );

  return {
    darkReader: {
      proxyAttr: document.documentElement.getAttribute("data-darkreader-proxy-injected"),
      injectedStyleCount: drStyles.length,
      anyDarkreaderClassNodes: drAny,
      inlineRewrittenNodes: drInline,
      verdict:
        drStyles.length === 0 && drAny === 0 && drInline === 0
          ? "NOT restyling this page — measurements are genuine"
          : "ACTIVELY restyling — measurements are contaminated",
    },
    theme: document.documentElement.className,
    bodyBg: g(document.body, "background-color"),
    today: dateLeaf(pick("Room clean")),
    tomorrow: dateLeaf(pick("hair wash")),
    completed: done ? dateLeaf(done) : null,
    completedTitleColor: done ? g(done.querySelector("div.task_content"), "color") : null,
    ringP1: ring(pick("hair wash")),
    ringP4: ring(pick("naukri photo update")),
    rowBg: g(pick("Room clean"), "background-color"),
    rowBorder: g(pick("Room clean"), "border-bottom"),
  };
});

console.log(JSON.stringify(result, null, 1));

// --- cleanup: close the spare page opened in step 11 ---
const pages = await task.pages();
for (const p of pages) {
  if (p.label !== "p1") {
    await p.close();
    console.log("closed spare page", p.label);
  }
}
