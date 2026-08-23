import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { deleteEntryViaMenu, sendEntry, uniqueEntryBody } from "./helpers";

// Reflection covered end to end (issue #67): ask a Question, see the
// Answer come back, reload and prove the Conversation survives — the one
// thing a unit test can't tell you (docs/adr/0025 moved the Conversation
// onto the Server precisely so a reload wouldn't lose it) — then find the
// Session in the Sessions list, search for it, and delete it.
//
// `/v1/reflect` only runs at all against apps/e2e/llm-stub.ts's fixed
// double (wired into server A by scripts/e2e-server.sh's MEOLOGUE_CHAT_*/
// MEOLOGUE_EMBED_* variables): the extraction call always resolves to no
// date range and no keyword, and the answering call always returns
// "GROUNDED: yes" plus the same fixed Answer, so nothing here asserts on
// generated prose beyond that fixed text.
const STUB_ANSWER = "Your journal has an Entry from testing meologue.";

test("ask a Question, reload, find it in Sessions, search for it, delete it", async ({ page }) => {
  // A short, unique marker keeps the Question — and so the Session title
  // derived from it (server/src/reflect.rs's derive_title keeps a Question
  // verbatim as the title once it's 60 characters or fewer) — well under
  // that limit, so the title equals the Question exactly with no "…"
  // truncation to account for anywhere below.
  const marker = randomUUID().slice(0, 8);
  const question = `What did I write about reflect-${marker}?`;

  await page.goto("/");

  const entryBody = uniqueEntryBody("reflection-entry");
  await sendEntry(page, entryBody);
  await expect(page.getByText(entryBody)).toBeVisible();

  await page.getByRole("link", { name: "Reflect" }).click();
  await expect(page).toHaveURL("/reflect");

  await page.getByPlaceholder("Ask a Question about your History").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();

  // The null id on the ask is what creates the Session (ADR 0025) — this
  // page navigates to its freshly minted url once the Answer comes back.
  await expect(page).toHaveURL(/\/reflect\/[0-9a-f-]{36}$/);
  await expect(page.getByText(question)).toBeVisible();
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();

  const sessionUrl = page.url();

  // The single most important assertion in this file: the Server holds the
  // Conversation now (ADR 0025), so a reload must not lose it — that's
  // exactly the behaviour unit tests can't exercise.
  await page.reload();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.getByText(question)).toBeVisible();
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();

  // The Sessions list (ticket 62/ADR 0025), reached from Reflect's own
  // app-bar affordance, titled with the Question that started it.
  await page.getByRole("link", { name: "Sessions" }).click();
  await expect(page).toHaveURL("/reflect/list");
  await expect(page.getByRole("link", { name: question })).toBeVisible();

  // Search (issue #64's shared Shell affordance, labelled "Sessions" here
  // rather than "History") narrows the list to a word drawn from the
  // Question; a nonsense term matches nothing.
  await page.getByRole("button", { name: "Search Sessions" }).click();
  const search = page.getByRole("searchbox", { name: "Search Sessions" });

  await search.fill(`reflect-${marker}`);
  await expect(page.getByRole("link", { name: question })).toBeVisible();

  const nonsense = `no-such-session-${randomUUID()}`;
  await search.fill(nonsense);
  await expect(page.getByText(`No Sessions match "${nonsense}"`)).toBeVisible();

  // Back to a query that matches, so the row is on screen again to delete.
  await search.fill(`reflect-${marker}`);
  await expect(page.getByRole("link", { name: question })).toBeVisible();

  // Delete (issue #63): the first click only arms an in-row confirm step —
  // nothing is sent yet.
  await page.getByRole("button", { name: `Delete "${question}"` }).click();
  await expect(page.getByRole("button", { name: "Delete permanently" })).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  // The same search term now matches nothing — the Session is gone from
  // the list.
  await expect(page.getByRole("link", { name: question })).toHaveCount(0);
  await expect(page.getByText(`No Sessions match "reflect-${marker}"`)).toBeVisible();
});

// server/src/reflect.rs's `retrieve_nearest` carries a `deleted_at is
// null` guard alongside its existing `embedding is not null` one (ADR
// 0028's Ticket 2), so a deleted Entry can't come back through
// Reflection's own door even though CONTEXT.md's Grounding disclosure is
// otherwise the one place History gets re-displayed outside `/` (issue #75
// deleted `/history`, the collection's other former display). Every Entry
// here gets the same fixed embedding (llm-stub.ts's constant vector), so
// which of the two survives retrieval is entirely down to that guard, not
// wording or similarity.
test("a deleted Entry does not come back through Reflection's Grounding", async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const keptBody = uniqueEntryBody(`grounding-kept-${marker}`);
  const deletedBody = uniqueEntryBody(`grounding-deleted-${marker}`);

  await page.goto("/");
  await sendEntry(page, keptBody);
  await sendEntry(page, deletedBody);
  await expect(page.getByText(keptBody)).toBeVisible();
  await expect(page.getByText(deletedBody)).toBeVisible();

  // Delete one of the two, and give its tombstone real time to reach the
  // Server — this only proves anything once `deleted_at` is actually set
  // there, not just locally. The wait also gives the kept Entry's
  // embedding (computed off a sync hint, embedding.rs) plenty of room to
  // be ready before the Question below is asked.
  await deleteEntryViaMenu(page, deletedBody);
  await expect(page.getByText(deletedBody)).toHaveCount(0);
  await page.waitForTimeout(8_000);

  const question = `What did I write about grounding-${marker}?`;
  await page.getByRole("link", { name: "Reflect" }).click();
  await page.getByPlaceholder("Ask a Question about your History").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page).toHaveURL(/\/reflect\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();

  // Expand the Grounding disclosure (a collapsed <details>/<summary> —
  // grounding-disclosure.tsx) and check its contents directly, rather than
  // trusting the summary's count alone.
  const summary = page.getByText(/Grounded in \d+ Entr|\d+ recent Entr/);
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await summary.click();

  await expect(page.getByText(keptBody)).toBeVisible();
  await expect(page.getByText(deletedBody)).toHaveCount(0);
});
