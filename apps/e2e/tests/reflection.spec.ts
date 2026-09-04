import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { SERVER_A_DATABASE } from "../servers";
import { expect, test } from "./fixtures";
import {
  deleteEntryViaMenu,
  openDestination,
  sendEntry,
  uniqueEntryBody,
  waitForEmbedding,
  waitForEntryId,
  waitForTombstone,
} from "./helpers";

// Reflection covered end to end against the tool-calling loop issue #96
// built (`harness::agent_loop` over `harness::prompted::PromptedToolClient`
// — server/src/harness/prompted.rs), not the fixed extraction-then-answer
// pipeline issue #99 deleted. `/v1/reflect` only runs at all against
// apps/e2e/llm-stub.ts's fixed double (wired into server A by
// scripts/e2e-server.sh's MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_* variables),
// which plays a small set of scripts keyed off a marker embedded in each
// Question's own text (see llm-stub.ts's own doc comment for how and
// why) — one tool call then the fixed Answer below by default, and three
// more deliberate scripts the tests further down each ask for by name:
// two tool calls in order, one that finds nothing, and one that fails
// after the first tool result is already in.
//
// Five scenarios in total, across this file: a single-step Question and a
// Session surviving reload (both in the first test below, incidentally —
// asking is what creates the reload-worthy Session in the first place), a
// multi-step Question whose steps render live and in order, the no-match
// path, and a mid-stream failure that leaves Reflection usable afterwards.
const STUB_ANSWER = "Your journal has an Entry from testing meologue.";

test("ask a Question, reload, find it in Sessions, search for it, delete it", async ({ page }) => {
  // A short, unique marker keeps the Question — and so the Session title
  // derived from it (server/src/reflect.rs's derive_title keeps a Question
  // verbatim as the title once it's 60 characters or fewer) — well under
  // that limit, so the title equals the Question exactly with no "…"
  // truncation to account for anywhere below.
  const marker = randomUUID().slice(0, 8);
  const question = `What did I write about reflect-${marker}?`;

  await page.goto("/composer");

  const entryBody = uniqueEntryBody("reflection-entry");
  await sendEntry(page, entryBody);
  await expect(page.getByText(entryBody)).toBeVisible();

  await openDestination(page, "Reflect");
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

  await page.goto("/composer");
  await sendEntry(page, keptBody);
  await sendEntry(page, deletedBody);
  await expect(page.getByText(keptBody)).toBeVisible();
  await expect(page.getByText(deletedBody)).toBeVisible();

  // Capture the about-to-be-deleted Entry's id while `body` still
  // identifies it — a delete blanks `body` server-side (see
  // `waitForEntryId`'s own doc comment), so this is the only handle left
  // once it's gone. Polling rather than a bare `select` also folds in
  // waiting for the initial sync to land at all.
  const deletedId = await waitForEntryId(deletedBody, SERVER_A_DATABASE);

  await deleteEntryViaMenu(page, deletedBody);
  await expect(page.getByText(deletedBody)).toHaveCount(0);

  // Issue #112: a fixed `waitForTimeout` here used to guess how long two
  // pieces of Server-side background work take — the tombstone reaching
  // the Server (`deleted_at` actually set, not just removed locally) and
  // the kept Entry's embedding becoming ready (embedding.rs, off the
  // `/v1/sync` hint) — plenty on a quiet machine, not on a loaded one.
  // Polling for both conditions directly removes the guess. Order matters
  // a little: confirming the tombstone first is what rules out the kept
  // Entry's embedding racing ahead of the delete and the Question below
  // catching the deleted Entry mid-flight, still un-tombstoned.
  await waitForTombstone(deletedId, SERVER_A_DATABASE);
  await waitForEmbedding(keptBody, SERVER_A_DATABASE);

  const question = `What did I write about grounding-${marker}?`;
  await openDestination(page, "Reflect");
  await page.getByPlaceholder("Ask a Question about your History").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page).toHaveURL(/\/reflect\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();

  // Expand the Grounding disclosure (a collapsed <details>/<summary> —
  // grounding-disclosure.tsx) and check its contents directly, rather than
  // trusting the summary's count alone. "N Entries read" is
  // `summaryLabel`'s own current wording (issue #99's carry-over #2
  // deliberately dropped "Grounded in N Entries" — that phrasing claimed a
  // relationship between the Answer and those Entries the Server has no
  // way to verify under the tool-calling loop; issue #111 then found that
  // its own replacement, "N Entries returned," still read as a relevance
  // claim and sat as an apparent contradiction beneath an Answer that said
  // nothing was found — see `summaryLabel`'s own doc comment).
  const summary = page.getByText(/\d+ Entr(y|ies) read/);
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await summary.click();

  await expect(page.getByText(keptBody)).toBeVisible();
  await expect(page.getByText(deletedBody)).toHaveCount(0);

  // #128: the disclosure sits under an Answer bubble rather than beside it.
  // Its left edge lines up with the Answer's own first character (the
  // bubble's `px-3`), and its right edge stops where the Answer's does (the
  // bubble's `pr-[12%]`) — before this it was flush against the pane's left
  // edge and 85% of a width the bubble had not used since ADR 0036 gave it
  // a side. Measured rather than asserted from class names, because the
  // inset is a percentage of a width jsdom does not have.
  const answerBubble = page
    .locator('[data-slot="bubble"][data-side="in"]')
    .filter({ hasText: STUB_ANSWER })
    .locator("> div")
    .first();
  const answerBox = await answerBubble.boundingBox();
  const summaryBox = await summary.boundingBox();
  expect(answerBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  // Within a pixel: the bubble's own horizontal padding is what the caption
  // is indented by, so the two text edges coincide.
  expect(Math.abs((summaryBox?.x ?? 0) - ((answerBox?.x ?? 0) + 12))).toBeLessThan(1.5);
  // And it is a target a finger can hit — the one control an Answer carries.
  expect(summaryBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});

/**
 * Navigates to /reflect. Named (and kept as its own function, over the
 * three call sites below just inlining the two lines) for what it used to
 * also do: driving a real browser directly showed ReflectionPage's first
 * mount in a session was followed, well under a second later, by an
 * unrelated internal remount (a second `GET /v1/models` fired shortly
 * after the first, with no test action in between), which aborted
 * whatever `/v1/reflect` fetch happened to already be in flight when it
 * landed. Issue #110 traced that remount to EntryStoreLayout
 * (entry-store-layout.tsx): it used to switch which element type sat at
 * this page's exact position in the tree once the Entry store finished
 * opening, and React tears down and rebuilds a subtree whenever the type
 * at a position changes. Fixed there — the type at that position is now
 * constant across every render — so there is no longer a remount here to
 * wait out, and the `page.waitForLoadState("networkidle")` this function
 * used to end with is gone. The two tests above never needed it in the
 * first place: both reach Reflect only after real work on the Composer
 * page first (sending an Entry, waiting on assertions), which happened to
 * outlast the window by accident, before there was anything to wait for.
 */
async function openReflectAndSettle(page: Page): Promise<void> {
  await openDestination(page, "Reflect");
  await expect(page).toHaveURL("/reflect");
}

// llm-stub.ts's multi-step script (keyed off the "multistep-" marker below)
// makes two tool calls, in order — similar_entries naming
// MULTI_STEP_QUERY_ONE, then search_entries naming MULTI_STEP_QUERY_TWO —
// before answering, and deliberately holds its final reply back long
// enough (MULTI_STEP_FINAL_DELAY_MS) that both steps are still on screen,
// both finished, before the Answer replaces this live view
// (`LiveRunView`, reflection-page.tsx, only renders while a Question is
// still pending). These two literals must keep matching llm-stub.ts's own
// constants of the same name — nothing enforces that beyond this comment,
// since the spec can't import from a file that starts an HTTP server on
// load.
const MULTI_STEP_QUERY_ONE = "step-one-of-two";
const MULTI_STEP_QUERY_TWO = "step-two-of-two";

test("a multi-step run renders its steps live, in the order they actually ran", async ({
  page,
}) => {
  const marker = randomUUID().slice(0, 8);
  const question = `What did I write about multistep-${marker}?`;

  await page.goto("/composer");
  await openReflectAndSettle(page);
  await page.getByPlaceholder("Ask a Question about your History").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();

  // Both steps' *finished* labels, not merely their running ones —
  // `reflect-live-run.ts`'s `finishedLabel` is what a tool call's own
  // <li> reads once its `tool_execution_end` has arrived, which is also
  // exactly the state llm-stub.ts's delay is holding open below.
  const stepOneDone = page.getByText(
    new RegExp(`Searched your Entries by meaning for "${MULTI_STEP_QUERY_ONE}" — \\d+ Entr`),
  );
  const stepTwoDone = page.getByText(
    new RegExp(`Searched your Entries for "${MULTI_STEP_QUERY_TWO}" — \\d+ Entr`),
  );
  await expect(stepOneDone).toBeVisible();
  await expect(stepTwoDone).toBeVisible();

  // The order assertion this scenario actually exists for: a test that
  // only checked both labels were present somewhere on the page would
  // pass identically whether the two steps rendered in this order or the
  // reverse — `reflect-live-run.ts`'s `steps` array only ever appends, so
  // reading it back off the DOM's own order is what tells the two cases
  // apart.
  const stepTexts = await page.locator('ul[aria-live="polite"] li').allTextContents();
  const indexOne = stepTexts.findIndex((text) => text.includes(MULTI_STEP_QUERY_ONE));
  const indexTwo = stepTexts.findIndex((text) => text.includes(MULTI_STEP_QUERY_TWO));
  expect(indexOne).toBeGreaterThanOrEqual(0);
  expect(indexTwo).toBeGreaterThan(indexOne);

  // The run still finishes normally once llm-stub.ts's delay elapses.
  await expect(page).toHaveURL(/\/reflect\/[0-9a-f-]{36}$/);
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();
});

// llm-stub.ts's no-match script (keyed off the "nomatch-" marker) calls
// entries_in_range over a date range no Entry this suite ever writes can
// fall inside, rather than trying to starve `similar_entries` of a match —
// every Entry and every query embed identically in this suite
// (`STUB_EMBEDDING`'s own doc comment in llm-stub.ts), so `similar_entries`
// can never genuinely come back empty here. Only a tool whose result
// actually depends on the data exercises this path honestly.
test("a run that genuinely finds nothing says so, not a fabricated Answer", async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const question = `What did I write about nomatch-${marker}?`;

  await page.goto("/composer");
  await openReflectAndSettle(page);
  await page.getByPlaceholder("Ask a Question about your History").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page).toHaveURL(/\/reflect\/[0-9a-f-]{36}$/);
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();

  // `groundingOutcome` (lib/conversation.ts) reads a tool call that ran and
  // came back with no Entries as "nothingFound" — distinct from
  // "neverLooked" (issue #103: a run that never checked at all) — and this
  // is the caption `GroundingNote` (reflection-page.tsx) renders for it.
  await expect(page.getByText("Nothing in your History matched this Question.")).toBeVisible();
});

// llm-stub.ts's mid-stream-error script (keyed off the "midstreamerror-"
// marker) answers its first tool call normally — so this failure happens
// strictly after a `tool_execution_end` has already reached the client,
// not before the run ever gets going — and then fails the very next chat
// call outright (a non-2xx response, standing in for the chat endpoint
// itself going down mid-run). Server-side that becomes the stream's own
// `agent_end {"status": "error"}` frame (`run_reflect_stream`,
// server/src/reflect.rs); `reflectTransport`'s `agent-error` branch
// (lib/reflect-transport.ts) is what turns it into `handleAsk`'s failure
// path (reflection-page.tsx).
test("a mid-stream failure leaves Reflection usable afterwards", async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const question = `What did I write about midstreamerror-${marker}?`;

  await page.goto("/composer");
  await openReflectAndSettle(page);
  const composer = page.getByPlaceholder("Ask a Question about your History");
  await composer.fill(question);
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page.getByText("Reflection couldn't answer that. Try again.")).toBeVisible();

  // Recoverable means more than "an error appeared": the failed Question
  // is handed straight back into the composer rather than lost
  // (`handleAsk`'s `setRestore`), and nothing was persisted — issue #102's
  // guarantee — so this is still a bare, Session-less /reflect with no
  // Turn ever rendered.
  await expect(composer).toHaveValue(question);
  await expect(page).toHaveURL("/reflect");

  // sonner's own toast sits over the Ask button (both bottom-anchored) and
  // intercepts pointer events until it dismisses itself. It also pauses
  // its own dismiss timer while the pointer rests over it — exactly where
  // clicking Ask just left the cursor — so a real user's next move here
  // (reading the message, then looking back at the composer to retype)
  // is also what releases sonner's own pause; this moves the mouse there
  // for the same reason. Waiting it out from there, rather than forcing a
  // click through it, is closer to the actual recovery this scenario is about.
  await composer.hover();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });

  // The strongest form of "recoverable": asking again actually works. A
  // fresh Question rather than a resubmit of the restored one — llm-stub.ts's
  // script fails the "midstreamerror-" marker deterministically every time,
  // so resending the identical Question would only prove it fails twice,
  // not that the composer still works.
  const followUp = `What did I write about reflect-${marker}?`;
  await composer.fill(followUp);
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page).toHaveURL(/\/reflect\/[0-9a-f-]{36}$/);
  await expect(page.getByText(STUB_ANSWER)).toBeVisible();
});
