const task = await taskSpace(32);
const page = task.page("p1");

const result = await page.evaluate(() => {
  function describe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      class: el.className,
      id: el.id,
      rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
      bg: cs.backgroundColor,
    };
  }

  // sidebar: find nav container with "Inbox" link
  const inboxLink = document.querySelector('a[href="/todo/inbox"]');
  const sidebarNav = inboxLink ? inboxLink.closest('nav') || inboxLink.closest('aside') : null;
  let sidebarRoot = inboxLink;
  // walk up ancestors to find likely sidebar wrapper (has width ~280ish or contains "Add task")
  const ancestors = [];
  let node = inboxLink;
  for (let i = 0; i < 12 && node; i++) {
    ancestors.push(describe(node));
    node = node.parentElement;
  }

  // Add a Task field
  const addTaskField = document.querySelector('[aria-label="Add a Task"], [contenteditable="true"]');

  // Row list items
  const rows = Array.from(document.querySelectorAll('li'));

  return {
    ancestorsFromInboxLink: ancestors,
    rowCount: rows.length,
    bodyClassList: document.body.className,
    htmlClassList: document.documentElement.className,
  };
});

console.log(JSON.stringify(result, null, 2));
