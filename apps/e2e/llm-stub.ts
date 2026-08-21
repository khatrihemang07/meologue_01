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

// The fixed Answer reflection.spec.ts asserts against. "GROUNDED: yes" is
// the marker `parse_and_strip_verdict` (server/src/reflect.rs) reads off
// the front of the answering call's reply and strips before the Answer
// reaches the client — a plain "yes" verdict keeps the spec off the
// disclosed-fallback path entirely, so exactly one deterministic Answer is
// ever in play.
const STUB_ANSWER = "GROUNDED: yes\nYour journal has an Entry from testing meologue.";

// The extraction call (`extract_date_range_and_keyword`) wants bare JSON
// back, not prose — `null`/`null` degrades retrieval to question-only
// search (ticket 4's original behaviour), which is all this suite needs:
// the constant embedding above already makes that one search deterministic.
const STUB_EXTRACTION = '{"date_range": null, "keyword": null}';

// The fixed reply for the Digest worker's one chat call
// (`server/src/digest.rs::write_digest_for`), keyed on the same
// leading-phrase trick as `isExtractionCall` below. digest.spec.ts
// (issue #73) doesn't actually assert on this text — that spec seeds its
// own `digests` rows with SQL rather than waiting on the worker, since a
// cold e2e database never has a completed Period with Entries in it for
// the worker to find (see that spec's own header comment). This constant
// exists so a call the worker *does* happen to make during a run — its
// `SCAN_INTERVAL` ticks every 5 minutes, so a long-running suite could see
// one — gets recognised for what it is rather than silently falling
// through to `STUB_ANSWER` and writing Reflection's "GROUNDED: yes..."
// text into the `digests` table as if it were Digest prose.
const STUB_DIGEST = "This is the Digest writer's fixed reply for meologue's e2e suite.";

/**
 * Tells the extraction call apart from the answering call by content,
 * exactly as `is_extraction_call` does in server/tests/reflect.rs: the
 * extraction system prompt (`extraction_system_prompt`, server/src/reflect.rs)
 * always opens with "Today's date", which nothing else sent to `chat`
 * ever does.
 */
function isExtractionCall(body: { messages?: Array<{ content?: string }> }): boolean {
  const first = body.messages?.[0]?.content ?? "";
  return first.includes("Today's date");
}

/**
 * Tells the Digest worker's call apart from Reflection's two calls by
 * content, the same way `isExtractionCall` does. `digest_system_prompt`
 * (server/src/digest.rs) already documents this exact leading phrase —
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
      const content = isExtractionCall(body)
        ? STUB_EXTRACTION
        : isDigestCall(body)
          ? STUB_DIGEST
          : STUB_ANSWER;
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
