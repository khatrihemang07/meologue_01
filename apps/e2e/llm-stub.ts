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
// the *second* reply in this stub's own two-call script (see
// `isToolResultFollowUp` below): no "GROUNDED: yes" marker any more, since
// that belonged to the fixed pipeline issue #93 replaced with a real
// tool-calling loop (`harness::agent_loop`) — `run_reflect_stream_inner`
// (server/src/reflect.rs) reads `grounded` off whether any tool call
// actually surfaced an Entry, not off a verdict the model writes.
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

/**
 * Issue #96: `/v1/reflect` no longer makes two fixed-purpose calls
 * (extraction, then answering) — it runs `harness::agent_loop` against
 * `harness::prompted::PromptedToolClient`, which can make as many calls as
 * the model asks for, in the literal `<tool_call>{"name": ...,
 * "arguments": ...}</tool_call>` tag protocol that module's own doc
 * comment specifies (server/src/harness/prompted.rs). This stub plays a
 * model that always takes exactly two turns: a `<tool_call>` on the first,
 * then prose on the second — the shortest script that still exercises a
 * genuinely multi-step run (`step_start → ... → tool_execution_end →
 * step_start → ... → agent_end`), which is the whole reason issue #96
 * asked for this stub to be stateful at all.
 *
 * "Stateful" here means reading it off the request's own message history,
 * not off any variable this process remembers between calls: every call
 * the harness makes resends the whole Conversation so far
 * (`PromptedToolClient::stream`'s own `messages.extend(...)`), so whether
 * this is turn one or turn two of the *same* Question is already fully
 * determined by whether a `<tool_result>` tag — `render_tool_result`'s own
 * wire format, always the last message once a tool has actually run — is
 * present. Reading it off content rather than a mutable `Map` keyed by
 * some session id sidesteps a whole category of bug a real in-memory
 * tracker would risk: two Questions in flight at once (a real risk once
 * Playwright's specs run with more than one worker) can never desync this
 * stub's own idea of "which turn is this" from what the harness actually
 * sent, because there is no shared state to desync.
 */
function isToolResultFollowUp(body: { messages?: Array<{ content?: string }> }): boolean {
  const last = body.messages?.at(-1)?.content ?? "";
  return last.includes("<tool_result");
}

/**
 * The Question this run is actually about, read off the request's own
 * last message — on the first call (before `isToolResultFollowUp` is
 * true) that's simply the Question itself, since nothing else has been
 * said yet. Used to build the `similar_entries` tool call below, so the
 * stub's own request is at least legible in a trace, even though which
 * query text is sent makes no difference to what comes back — every Entry
 * and every query embeds to the identical `STUB_EMBEDDING` below, so
 * `similar_entries` always returns every non-deleted Entry regardless of
 * wording (the deterministic-retrieval trick this suite already relied on
 * before issue #96, carried over unchanged).
 */
function lastMessageContent(body: { messages?: Array<{ content?: string }> }): string {
  return body.messages?.at(-1)?.content ?? "";
}

/**
 * Tells the Digest worker's call apart from Reflection's own loop calls by
 * content, the same leading-phrase sniff `isToolResultFollowUp` above uses
 * a different marker for. `digest_system_prompt` (server/src/digest.rs)
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

/**
 * The first turn's whole reply: a single `<tool_call>` naming
 * `similar_entries` — `harness::tools::SimilarEntriesTool`'s own
 * `parameters()` requires nothing but `query`, so this is the smallest
 * call that reaches a real tool. `similar_entries`, not `search_entries`
 * or `entries_in_range`, is deliberate: both `reflection.spec.ts`'s specs
 * need retrieval to find an Entry by nothing more specific than "this
 * Device wrote something recently" (a random `reflect-<marker>` phrase
 * that never appears verbatim in the Entry body it's asking about), and
 * `similar_entries` is the one tool whose result is entirely determined by
 * `STUB_EMBEDDING` below rather than by word overlap — every Entry and
 * every query embed identically, so it always returns every non-deleted
 * Entry regardless of what `query` actually says.
 */
function toolCallReply(query: string): string {
  const payload = { name: "similar_entries", arguments: { query } };
  return `<tool_call>${JSON.stringify(payload)}</tool_call>`;
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

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = (await readJsonBody(req)) as { messages?: Array<{ content?: string }> };
      const content = isDigestCall(body)
        ? STUB_DIGEST
        : isToolResultFollowUp(body)
          ? STUB_ANSWER
          : toolCallReply(lastMessageContent(body));
      sendJson(res, { choices: [{ message: { content } }] });
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
