// A minimal OpenAI-compatible stand-in for the chat/embedding endpoint
// `MEOLOGUE_CHAT_*`/`MEOLOGUE_EMBED_*` point Server A at (issue #67) — see
// scripts/e2e-server.sh. Reflection needs *some* endpoint answering both
// shapes before `/v1/reflect` and `/v1/sessions` even get registered
// (server/src/lib.rs gates both on `LlmConfig::reflect_config()` resolving
// — server/src/llm.rs), and a real model is wrong for a test suite three
// ways at once: ~7s a call, non-deterministic prose, and a process this
// repo doesn't manage. Plain `node:http`, no new dependency — this is a
// fixed-response double, not a server.
//
// Started by playwright.config.ts's webServer array, same as
// scripts/e2e-server.sh and scripts/e2e-server-b.sh, and only ever pointed
// at by server A — server B stays unconfigured on purpose (see
// scripts/e2e-server-b.sh), so multi-server.spec.ts's isolation still holds.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 41237);

// 640 dimensions matches Entries.embedding's column width
// (server/migrations/0002_add_entry_embeddings.sql). A constant vector is
// fine for this suite: it puts every Entry — and the Question itself, via
// `embed_query` — at cosine similarity 1.0 with each other, so which
// Entries retrieval returns is deterministic and independent of wording.
const STUB_EMBEDDING = Array(640).fill(0.1);

// The fixed Answer reflection.spec.ts asserts against — the prose half of
// whichever script below ends in an ordinary reply rather than another
// `<tool_call>` or a simulated failure. `run_reflect_stream_inner`
// (server/src/reflect.rs) reads `grounded`/`tool_called` off what the
// tools it actually ran surfaced, not off a verdict the model writes, so
// this text carries no marker of its own — it's just prose.
const STUB_ANSWER = "Your journal has an Entry from testing meologue.";

// The fixed reply for the Digest worker's one chat call
// (`server/src/digest.rs::write_digest_for`), keyed on the same
// leading-phrase trick `isDigestCall` below uses to recognise it.
// digest.spec.ts
// (issue #73) doesn't actually assert on this text — that spec seeds its
// own `digests` rows with SQL rather than waiting on the worker, since a
// cold e2e database never has a completed Period with Entries in it for
// the worker to find (see that spec's own header comment). This constant
// exists so a call the worker *does* happen to make during a run — its
// `SCAN_INTERVAL` ticks every 5 minutes, so a long-running suite could see
// one — gets recognised for what it is rather than silently falling
// through to `STUB_ANSWER` and writing Reflection's own Answer text into
// the `digests` table as if it were Digest prose.
const STUB_DIGEST = "This is the Digest writer's fixed reply for meologue's e2e suite.";

// A date range guaranteed to hold no Entries: every Entry this suite ever
// writes is dated "now" (2026 and later), so `entries_in_range` over a
// pair of dates from the year 2000 always comes back empty without
// depending on `similar_entries`' own always-matches trick — see the
// no-match script below.
const NO_MATCH_FROM = "2000-01-01";
const NO_MATCH_TO = "2000-01-02";

/**
 * Issue #96: `/v1/reflect` no longer makes two fixed-purpose calls
 * (extraction, then answering) — it runs `harness::agent_loop` against
 * `harness::prompted::PromptedToolClient`, which can make as many calls as
 * the model asks for, in the literal `<tool_call>{"name": ...,
 * "arguments": ...}</tool_call>` tag protocol that module's own doc
 * comment specifies (server/src/harness/prompted.rs). This stub plays a
 * model whose reply on any given call depends on two things read straight
 * off the request body, never off anything this process remembers between
 * calls:
 *
 * - **which scenario** — a marker substring embedded in the Question
 *   itself (`multistep-`, `nomatch-`, `midstreamerror-`, or none of
 *   those, which plays the plain one-tool-call-then-answer script
 *   reflection.spec.ts's first two tests rely on). The Question is the
 *   first thing the harness ever sends (`messages[1]`, right after the
 *   system prompt `PromptedToolClient::render_system_prompt` builds), and
 *   `render_message` (prompted.rs) never rewrites or drops a past
 *   message, so it's still present, verbatim, in every later call's own
 *   message history too — `messageHistoryText` below scans the *whole*
 *   history, not just the latest message, for exactly that reason.
 *
 * - **which turn** — how many `<tool_result` tags (`render_tool_result`'s
 *   own wire format) already appear anywhere in that same history. Turn
 *   zero has none; a script that calls one tool and then answers reads
 *   that count to know it's now on the reply *after* the first result;
 *   the multi-step script reads it a second time to know it's on the
 *   reply after the *second*.
 *
 * "Content-derived" here means exactly that these two facts are recomputed
 * fresh from the request body on every single call, never carried in a
 * mutable variable this process remembers between them. Every call the
 * harness makes resends the whole Conversation so far
 * (`PromptedToolClient::stream`'s own `messages.extend(...)`), so nothing
 * here has to be told which turn or which run it's on — it's already
 * legible in what was sent. Reading it off content rather than a mutable
 * `Map` keyed by some session id sidesteps a whole category of bug a real
 * in-memory tracker would risk: two Questions in flight at once (a real
 * risk once Playwright's specs run with more than one worker) can never
 * desync this stub's own idea of "which scenario, which turn" from what
 * the harness actually sent, because there is no shared state to desync.
 */
function messageHistoryText(body: { messages?: Array<{ content?: string }> }): string {
  return (body.messages ?? []).map((message) => message.content ?? "").join("\n");
}

/** How many tool results this run's history already carries — see `messageHistoryText`'s doc comment above for why this, not a remembered counter, is what "which turn is this" reads off. */
function toolResultCount(body: { messages?: Array<{ content?: string }> }): number {
  const matches = messageHistoryText(body).match(/<tool_result/g);
  return matches === null ? 0 : matches.length;
}

/**
 * The Question this run is actually about, read off the request's own
 * last message — before any tool has run, that's simply the Question
 * itself, since nothing else has been said yet. Used only by the default
 * script's own tool call below, so the stub's own request is at least
 * legible in a trace, even though which query text is sent makes no
 * difference to what comes back — every Entry and every query embeds to
 * the identical `STUB_EMBEDDING` below, so `similar_entries` always
 * returns every non-deleted Entry regardless of wording (the
 * deterministic-retrieval trick this suite already relied on before issue
 * #96, carried over unchanged).
 */
function lastMessageContent(body: { messages?: Array<{ content?: string }> }): string {
  return body.messages?.at(-1)?.content ?? "";
}

/**
 * Tells the Digest worker's call apart from Reflection's own loop calls by
 * content, the same leading-phrase sniff the scenario markers above use a
 * different marker for. `digest_system_prompt` (server/src/digest.rs)
 * already documents this exact leading phrase —
 * "You are the Digest writer" — as a **test contract, not a stylistic
 * choice**, on its own side: today it names `server/tests/digest.rs`'s
 * Rust-side fake chat client as the thing that would silently break if
 * the phrase changed. This function is that same contract's e2e-side
 * counterpart, sniffing the identical phrase for the identical reason —
 * so a future edit to that opening line needs to satisfy both matchers,
 * this one included, not just the Rust one that doc comment names today.
 */
function isDigestCall(body: { messages?: Array<{ content?: string }> }): boolean {
  const first = body.messages?.[0]?.content ?? "";
  return first.includes("You are the Digest writer");
}

/** One `<tool_call>` tag naming `name`/`arguments` — the wire format `harness::prompted::ToolCallScanner` parses back out (server/src/harness/prompted.rs). */
function toolCallReply(name: string, args: Record<string, unknown>): string {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

/** One chat/completions reply this stub can give: ordinary prose, or a deliberate non-2xx response standing in for the chat endpoint itself failing mid-run (`OpenAiCompatibleClient::chat`'s own `bail!` on a non-success status — server/src/llm.rs). */
type ChatOutcome =
  | { kind: "reply"; content: string }
  | { kind: "error"; status: number; body: string };

const reply = (content: string): ChatOutcome => ({ kind: "reply", content });

// Any Question containing this substring plays a script that makes two
// tool calls, in order, before answering — the shortest script that
// exercises a genuinely multi-step run
// (`step_start → ... → tool_execution_end → step_start → ... →
// tool_execution_end → step_start → ... → agent_end`), which is what
// issue #109's "steps render live, in order" scenario needs. The two
// tools are picked so their finished labels (`reflect-live-run.ts`'s
// `finishedLabel`) are never confusable with each other in a rendered
// list: `similar_entries` always finds every Entry (`STUB_EMBEDDING`'s
// own trick), `search_entries` for a query that appears in no Entry body
// always finds none — the point of this script is the *order* the two
// steps render in, not what either one returns.
const MULTI_STEP_MARKER = "multistep-";
const MULTI_STEP_QUERY_ONE = "step-one-of-two";
const MULTI_STEP_QUERY_TWO = "step-two-of-two";
// Gives a real browser room to observe both steps rendered as "done" —
// and, by the same waiting, both still present in the DOM at once — before
// the final Answer arrives and the live view unmounts (`LiveRunView`,
// reflection-page.tsx, only renders while `pending !== null`). Without
// this, a local stub answering in single-digit milliseconds could in
// principle close that window before even a fast poll observes it; the
// order assertion itself doesn't depend on this delay (the steps array
// only ever appends, in the order events actually arrived), but a comfortable
// window is what keeps the assertion from being a race against the stub's
// own speed.
const MULTI_STEP_FINAL_DELAY_MS = 600;

// Any Question containing this substring plays a script whose one tool
// call is guaranteed to find nothing — `entries_in_range` over
// `NO_MATCH_FROM`..`NO_MATCH_TO` above, a date range no Entry this suite
// ever writes can fall inside. Deliberately not `similar_entries`: every
// Entry and every query embed identically (`STUB_EMBEDDING`'s own doc
// comment), so `similar_entries` can never be made to return empty here —
// only a tool whose result genuinely depends on the data can exercise the
// no-match path this way.
const NO_MATCH_MARKER = "nomatch-";

// Any Question containing this substring plays a script that answers its
// first tool call normally and then fails the very next chat call — a
// mid-stream failure *after* a tool result has already reached the
// client, not before the run ever gets going. Server-side, this is
// `OpenAiCompatibleClient::chat` bailing on a non-2xx status
// (server/src/llm.rs), which `PromptedToolClient::stream`
// (server/src/harness/prompted.rs) turns into a terminal
// `StopReason::Error` `AssistantMessage` rather than a propagated `Err` —
// `run_reflect_stream` (server/src/reflect.rs) is what turns *that* into
// the stream's own `agent_end {"status": "error"}` frame.
const MID_STREAM_ERROR_MARKER = "midstreamerror-";

/** Decides this stub's whole reply for one `/v1/chat/completions` call — see the module doc comment above for how "which scenario, which turn" is read off `body` alone. */
function chatOutcomeFor(body: { messages?: Array<{ content?: string }> }): ChatOutcome {
  if (isDigestCall(body)) {
    return reply(STUB_DIGEST);
  }

  const history = messageHistoryText(body);
  const turn = toolResultCount(body);

  if (history.includes(MULTI_STEP_MARKER)) {
    if (turn === 0) {
      return reply(toolCallReply("similar_entries", { query: MULTI_STEP_QUERY_ONE }));
    }
    if (turn === 1) {
      return reply(toolCallReply("search_entries", { query: MULTI_STEP_QUERY_TWO }));
    }
    return reply(STUB_ANSWER);
  }

  if (history.includes(NO_MATCH_MARKER)) {
    if (turn === 0) {
      return reply(toolCallReply("entries_in_range", { from: NO_MATCH_FROM, to: NO_MATCH_TO }));
    }
    return reply(STUB_ANSWER);
  }

  if (history.includes(MID_STREAM_ERROR_MARKER)) {
    if (turn === 0) {
      return reply(toolCallReply("similar_entries", { query: "mid-stream-probe" }));
    }
    return { kind: "error", status: 500, body: "llm-stub: simulated mid-stream failure" };
  }

  // The plain script reflection.spec.ts's first two tests rely on: one
  // `similar_entries` call, then the fixed Answer.
  return turn === 0
    ? reply(toolCallReply("similar_entries", { query: lastMessageContent(body) }))
    : reply(STUB_ANSWER);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? {} : JSON.parse(raw);
}

function sendJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = (await readJsonBody(req)) as { messages?: Array<{ content?: string }> };
      const outcome = chatOutcomeFor(body);
      if (outcome.kind === "error") {
        res.writeHead(outcome.status, { "content-type": "text/plain" });
        res.end(outcome.body);
        return;
      }
      // Only the multi-step script's final, answering call ever needs the
      // deliberate pause `MULTI_STEP_FINAL_DELAY_MS` documents — both tool
      // results are already in `body`'s own history by then (`turn === 2`),
      // which is the same condition `chatOutcomeFor` used to pick this reply.
      if (messageHistoryText(body).includes(MULTI_STEP_MARKER) && toolResultCount(body) === 2) {
        await sleep(MULTI_STEP_FINAL_DELAY_MS);
      }
      sendJson(res, { choices: [{ message: { content: outcome.content } }] });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/embeddings") {
      await readJsonBody(req); // drained, unused — every input gets the same vector.
      sendJson(res, { data: [{ embedding: STUB_EMBEDDING }] });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  })();
});

server.listen(PORT, () => {
  console.log(`llm-stub listening on :${PORT}`);
});
