//! `POST /v1/reflect` — issue #93 pass 2: a Question is now answered by
//! `harness::agent_loop`, a tool-calling loop that decides for itself how
//! many times to look before it answers, with one tool so far
//! (`harness::tools::EntriesInRangeTool`). `run_reflect_loop` is what
//! `reflect_handler` actually calls.
//!
//! Tickets 4 through 8 built a different thing: a *fixed* pipeline that got
//! exactly one look — an extraction chat call found a date range and/or a
//! keyword hiding in the Question, three retrievals ran concurrently, the
//! results were merged, deduped, capped and reordered, and a second chat
//! call turned them into an Answer, judging its own Grounding and falling
//! back to a disclosed "here's what you've written lately" when it judged
//! that Grounding didn't answer the Question. `run_reflect` is that
//! pipeline, kept exactly as it was — working, tested, `#[allow(dead_code)]`
//! — because issue #93 pass 2's instructions are explicit that removing it
//! is issue #99's job, not this one's. Nothing below `run_reflect`'s own
//! doc comment describes the *current* behaviour of `/v1/reflect`.
//!
//! The Server holds the Conversation now (`docs/adr/0025`), superseding ADR
//! 0020's "a Conversation ... belongs to the Device it happened on and does
//! not Sync." A request names the Session it belongs to with `session_id`
//! — `None` starts a new one — instead of round-tripping every prior
//! Question and Answer on every call. `run_reflect_loop` loads that
//! Session's Turns (`sessions::load_turns`) before asking, and persists the
//! new one (`sessions::record_turn_from_steps`) only once an Answer has
//! actually succeeded, so a failed ask leaves neither a Session nor a Turn
//! behind — the same guarantee `run_reflect`'s own doc comment describes,
//! carried over unchanged.
//!
//! See CONTEXT.md's Grounding entry for the rule this route exists to
//! honour: an Answer with nothing behind it says so, rather than inventing
//! a past the user didn't live. The loop's own system prompt
//! (`LOOP_SYSTEM_INSTRUCTION`) says this directly; nothing enforces it the
//! way `run_reflect`'s "GROUNDED: yes/no" verdict marker did — that
//! mechanism belongs to the pipeline this ticket stopped calling, and a
//! later ticket decides what, if anything, replaces it for the loop.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Context as _;
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::embedding::vector_literal;
use crate::harness::agent_loop::{self, Step};
use crate::harness::compaction;
use crate::harness::prompted::PromptedToolClient;
use crate::harness::tools::{
    self, AgentTool, EntriesInRangeTool, ReadDigestTool, SearchEntriesTool, SimilarEntriesTool,
};
use crate::harness::types::{AssistantMessage, ContentBlock, Message, StopReason};
use crate::llm::{ChatMessage, LlmClient};
use crate::sessions::{self, EntryType, MessagePayload, NewTurn, SessionTurnRow};
use crate::sync::PROTOCOL_VERSION;

/// How many nearest Entries retrieval pulls before handing them to the chat
/// call, mirroring the shape `docs/adr/0022` already settled for writes:
/// bind the vector as a formatted `::vector` string, no `pgvector` crate.
/// 40 is generous for a personal-scale History — the chat call, not this
/// query, is what should decide whether an Entry was actually relevant.
///
/// This is also the cap applied to the *merged* set after the fan-out below
/// — see `run_reflect` — not just each individual retrieval's own limit.
///
/// It is also, since issue #92, the *only* thing standing between
/// `retrieve_nearest` and the chat call — there is no similarity floor
/// underneath it any more. A floor (`MIN_SIMILARITY`, formerly 0.60) used
/// to be applied first; issue #90's eval harness measured it against the
/// seeded corpus and found the score it thresholds tracks phrasing, not
/// topic — "Did I mention a trip to Japan anywhere?" cleared it five times
/// over for a topic absent from the journal, while "what did I write about
/// Priya's wedding" topped out at 0.363 and returned nothing for one that
/// is present. No constant separates those two cases, so none is applied:
/// `retrieve_nearest` now returns its top-`limit` rows unconditionally, and
/// the answering call's own relevance judgment (`docs/adr/0024`, already
/// this codebase's actual relevance mechanism before this ticket) is what
/// decides whether any of them answer the Question. See `docs/adr/0023`
/// for the full amendment.
pub const RETRIEVAL_LIMIT: i64 = 40;

/// Minutes east of UTC, clamped to the real-world extreme (±14h) before
/// `run_reflect` uses it for anything — see `ReflectRequest::utc_offset_minutes`.
const MIN_UTC_OFFSET_MINUTES: i32 = -840;
const MAX_UTC_OFFSET_MINUTES: i32 = 840;

/// How many days back the disclosed fallback (`run_reflect`) looks when
/// Reflection judges its own Grounding as not answering the Question —
/// `docs/adr/0024`. A rolling `Utc::now() - FALLBACK_WINDOW_DAYS .. Utc::now()`
/// window, deliberately not the local-calendar-day machinery
/// `local_date_range_to_utc` gives the *extracted* range above: this window
/// answers "what have you written lately", not a date the user named, so
/// there is no local day to align to — recency relative to right now is
/// exactly what's wanted, and it is the same for every asking Device
/// regardless of `utc_offset_minutes`.
const FALLBACK_WINDOW_DAYS: i64 = 3;

/// How many of a Session's most recent Turns `run_reflect` replays into
/// each chat call — the extraction call, the answering call, and the
/// disclosed-fallback call alike. `docs/adr/0025`'s Consequences section names exactly the problem
/// this bounds: a Session is durable now and can be returned to over weeks,
/// so replaying *every* prior Turn on every Question grows both latency and
/// context without limit against a chat endpoint that costs roughly seven
/// seconds a call and (`llm.rs`) has no timeout configured. This is the
/// same kind of bound `RETRIEVAL_LIMIT` already puts on the other side of
/// the same call — cap what the model is asked to read, rather than trust
/// an unbounded input to stay small. 10 is generous for what a Conversation
/// actually needs — a follow-up Question rarely reaches back further than
/// its last few exchanges — while keeping the call's latency and context
/// bounded regardless of how old or how long-lived the Session is.
///
/// This windows what's *replayed into the chat call*, not what a Session
/// holds or what `GET /v1/sessions/{id}` returns — `sessions::load_turns`
/// is shared by both, and the read endpoint must keep returning every Turn
/// a Session has. The cap is applied here, in `run_reflect`, to whatever
/// `load_turns` returns, deliberately not pushed into the SQL: it's a
/// property of what the model is asked to read, not of what the Session
/// contains.
const CONVERSATION_WINDOW: usize = 10;

/// The longest a derived Session title can be before `derive_title`
/// truncates it — see that function's doc comment for why 60 and for the
/// word-boundary rule.
const TITLE_MAX_CHARS: usize = 60;

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReflectRequest {
    pub protocol_version: i32,
    pub question: String,
    /// The Session this Question belongs to, or `None` to start a new one
    /// — a null id on an ask *is* the create (`docs/adr/0025`); there is no
    /// separate create endpoint. `run_reflect` loads that Session's prior
    /// Turns (`sessions::load_turns`) to read this Question "in the light
    /// of the Conversation before it" (CONTEXT.md's own phrase for what a
    /// Conversation is) — the server holds that Conversation now, so this
    /// replaces what used to round-trip on every request as `prior_turns`.
    /// A `Some` naming a Session that doesn't exist is a 404, not a
    /// silently-ignored value.
    #[serde(default)]
    pub session_id: Option<Uuid>,
    /// Minutes east of UTC for the asking Device, right now — the same sign
    /// convention `apps/web/src/lib/entry-day.ts::deviceUtcOffsetMinutes`
    /// and ADR 0016's `toLocalParts` already use for Export's day grouping.
    /// The extraction call (`extract_date_range_and_keyword`) uses this to
    /// resolve phrases like "last week" against the user's own local day,
    /// never the server's clock.
    ///
    /// `#[serde(default)]` rather than required: `PROTOCOL_VERSION` stays 1
    /// for this ticket (the sync contract's shape is unchanged, and bumping
    /// it would make every existing Device report the Server unreachable
    /// over an unrelated feature), so a Device that predates this ticket
    /// and posts with no `utc_offset_minutes` field must still get an
    /// Answer — it just gets date phrases resolved against UTC instead of
    /// its own local day, which is a graceful degrade (defaults to `0`),
    /// not a rejected Question.
    #[serde(default)]
    pub utc_offset_minutes: i32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReflectResponse {
    /// The Session this Turn was recorded into — freshly minted when the
    /// request's own `session_id` was `None`, unchanged otherwise. A client
    /// that started a new Session learns its id only from this field.
    pub session_id: Uuid,
    /// The Session's title: the existing title for a Session the request
    /// already named, or the newly-derived one (`derive_title`) for a
    /// freshly minted Session. Always present so a client never has to ask
    /// again just to know what to show for a Session it just started.
    pub title: String,
    pub answer: String,
    /// The Entry ids that appeared in a tool result during this run, in the
    /// order they first appeared — `run_reflect_loop`'s own dedup, over
    /// every `harness::agent_loop::Step::ToolResult` the loop produced, not
    /// retrieval's merge-and-sort (that description, and everything below
    /// through `docs/adr/0023`/`0024`, is what these fields meant under
    /// `run_reflect`, the fixed pipeline `/v1/reflect` no longer calls —
    /// see this module's own doc comment). Empty when the loop never called
    /// a tool at all — a prose-only reply is not unusual, and carries no
    /// Grounding by construction, not by omission.
    pub grounding_entry_ids: Vec<Uuid>,
    /// Whether at least one Entry appeared in a tool result this run —
    /// `!grounding_entry_ids.is_empty()`, nothing more judged about it.
    /// Under the old pipeline this was a real verdict, read off a
    /// "GROUNDED: yes/no" marker the answering chat call was instructed to
    /// produce; the loop has no equivalent judgment yet, so this field
    /// keeps its old *name* on the wire (`PROTOCOL_VERSION` is unchanged)
    /// while meaning something simpler until a later ticket decides whether
    /// it needs to mean more again.
    pub grounded: bool,
    /// Always `false`. The disclosed fallback (`docs/adr/0024`) belongs to
    /// the fixed pipeline this ticket stopped calling; the loop has no
    /// fallback mechanism of its own. Kept on the wire, rather than
    /// dropped, for the same reason `grounded` is — the wire shape itself
    /// is issue #96's to change, not this one's.
    pub fallback_used: bool,
}

/// `pub` (rather than crate-private, its original visibility) so
/// `tests/eval_retrieval.rs` — issue #90's retrieval eval harness — can
/// call `retrieve_nearest`/`retrieve_range` directly and read back what
/// they found, without the eval reimplementing this row shape or the SQL
/// itself. No field changed; only visibility.
#[derive(Debug, Clone, FromRow)]
pub struct GroundingEntry {
    pub id: Uuid,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

/// What the extraction chat call (`extract_date_range_and_keyword`) found in
/// a Question, or nothing at all — the safe default any parsing failure
/// degrades to. Both fields are independent: a Question can supply neither,
/// either, or both, and a malformed date range is dropped on its own
/// without discarding a keyword found alongside it.
#[derive(Debug, Default, PartialEq)]
struct Extraction {
    /// Inclusive local `[from, to]` calendar dates, already validated
    /// (`to >= from`) — see `parse_extraction`. Converted to a half-open
    /// UTC instant range by `local_date_range_to_utc` before it reaches
    /// `retrieve_range`.
    date_range: Option<(NaiveDate, NaiveDate)>,
    /// A short topical phrase to run a second vector search on — e.g.
    /// Question "how did the move go" might extract "moving flat".
    keyword: Option<String>,
}

/// Reflection's server-side dependencies, held in `AppState` only when both
/// are configured (`llm::LlmConfig::reflect_config`) — see `lib.rs` for why
/// that's what decides whether `/v1/reflect` is registered at all.
#[derive(Clone)]
pub struct ReflectState {
    pub chat_client: Arc<dyn LlmClient + Send + Sync>,
    pub embed_client: Arc<dyn LlmClient + Send + Sync>,
    /// Issue #97: how much room the configured chat model has, read once at
    /// startup from its `GET /v1/models/{id}` entry
    /// (`llm::resolve_context_window`) — never `harness::compaction`'s
    /// `DEFAULT_CONTEXT_WINDOW` fallback constant directly, so a test can
    /// see exactly what a Session's `run_reflect_loop` will treat as the
    /// trigger threshold without needing a live wrapper to ask.
    pub context_window: u32,
}

/// The answering call's system prompt (chat call 2). `docs/adr/0024`: this
/// is also where the relevance verdict now comes from — the reply must
/// *begin* with a "GROUNDED: yes"/"GROUNDED: no" marker line
/// (`parse_and_strip_verdict` reads it back out, and strips it before the
/// Answer ever reaches the client) — folded into this existing call rather
/// than spent on a third one, because the endpoint this ticket talks to
/// costs ~7s per call and Reflection is already two calls deep.
const SYSTEM_INSTRUCTION: &str = "You are Reflection, part of meologue, a personal journal. \
A user is asking a Question about their own journal Entries. Below, under \"Grounding\", are the \
journal Entries retrieval found most relevant to the Question, each labelled with the date it was \
written. Your reply must begin with exactly one line, on its own: either \"GROUNDED: yes\" or \
\"GROUNDED: no\". Answer \"GROUNDED: yes\" only if the Grounding actually contains enough to answer \
the Question — an Entry that merely shares a mood or a turn of phrase with the Question is not an \
answer to it. Answer \"GROUNDED: no\" if the Grounding does not answer the Question. After that \
marker line, answer the Question using only what these Entries say. If the Entries don't contain \
enough to answer the Question, say so plainly instead of guessing or inventing anything — a \
Reflection that invents a past the user did not live is worse than one that admits it found \
nothing. Speak directly to the user in the second person, in plain prose.";

/// The disclosed-fallback answering call's system prompt (`docs/adr/0024`)
/// — used only after the *first* answering call's own "GROUNDED: no"
/// verdict, and only when Entries exist in the last `FALLBACK_WINDOW_DAYS`
/// days to show. Unlike `SYSTEM_INSTRUCTION`, this call takes no verdict
/// marker: its verdict is already known (`grounded: false`), so
/// `run_reflect` never runs this response through `parse_and_strip_verdict`
/// at all. "nothing matching the Question was found" is deliberately
/// specific wording, distinct enough from `SYSTEM_INSTRUCTION`'s own prose
/// that a test double can tell the two calls apart by content alone.
///
/// Neither this prompt nor `SYSTEM_INSTRUCTION` names a sentence count or
/// length target (issue #77): an Answer should follow the Grounding it is
/// drawn from, and the two prompts describing the same Answer must not
/// disagree with each other about how long it should be — this one used to
/// say "briefly describe" while `SYSTEM_INSTRUCTION` said "a few sentences,"
/// two different length instructions for the same kind of reply.
const FALLBACK_SYSTEM_INSTRUCTION: &str = "You are Reflection, part of meologue, a personal \
journal. Nothing in the user's journal answered their Question. Below, under \"Grounding\", are \
the Entries the user wrote in the last few days — they were not judged relevant to the Question, \
only recent. Begin your reply by saying plainly that nothing matching the Question was found in \
their journal, then describe what they have been writing about in the last few days, using \
only these Entries. Do not imply these Entries answer the Question. Speak directly to the user \
in the second person, in plain prose.";

/// The two ways `run_reflect` can end other than success. `SessionNotFound`
/// is the one case that must reach the client as a clean 404 rather than
/// the catch-all 500 every other failure gets — see `ReflectRequest::session_id`.
/// `From<anyhow::Error>` is what lets every existing `?` on an
/// `anyhow::Result` inside `run_reflect` keep working unchanged: it's the
/// conversion Rust's `?` reaches for automatically.
enum ReflectError {
    SessionNotFound,
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for ReflectError {
    fn from(err: anyhow::Error) -> Self {
        ReflectError::Internal(err)
    }
}

#[utoipa::path(
    post,
    path = "/v1/reflect",
    request_body = ReflectRequest,
    responses(
        (status = 200, description = "An Answer grounded in the Entries retrieval found", body = ReflectResponse),
        (status = 404, description = "session_id names a Session that does not exist"),
        (status = 426, description = "protocol_version is not one this server understands"),
    )
)]
pub async fn reflect_handler(
    State(pool): State<PgPool>,
    State(reflect): State<Option<ReflectState>>,
    Json(req): Json<ReflectRequest>,
) -> Result<Json<ReflectResponse>, StatusCode> {
    if req.protocol_version != PROTOCOL_VERSION {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }

    // Only reachable if this state's absence somehow slipped past the
    // conditional route registration in `lib.rs` — that registration is the
    // actual gate; this is a defensive fallback, not the mechanism a client
    // is meant to observe as "Reflection isn't configured."
    let Some(reflect) = reflect else {
        tracing::error!(
            "reflect_handler invoked with no ReflectState — route should not be registered"
        );
        return Err(StatusCode::NOT_FOUND);
    };

    match run_reflect_loop(&pool, &reflect, req).await {
        Ok(response) => Ok(Json(response)),
        Err(ReflectError::SessionNotFound) => Err(StatusCode::NOT_FOUND),
        Err(ReflectError::Internal(err)) => {
            tracing::error!(error = ?err, "reflect failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// The loop's own persona instruction (issue #93 pass 2) — `reflect.rs`'s
/// live entry point now, via `run_reflect_loop`.
///
/// `harness::tools::render_tool_guidance` appends every active tool's own
/// `snippet`/`guidelines` after this before it's sent as
/// `harness::types::Context::system_prompt` — see that function's doc
/// comment for why the *tool set*, not this constant, owns describing what
/// each tool does.
///
/// Deliberately carries no "GROUNDED: yes/no" verdict instruction, unlike
/// `SYSTEM_INSTRUCTION` above: that judgment, and the disclosed fallback it
/// drove, belong to the fixed pipeline this ticket stopped calling
/// (`run_reflect`) — a later ticket decides what, if anything, replaces it
/// for the loop.
const LOOP_SYSTEM_INSTRUCTION: &str = "You are Reflection, part of meologue, a personal journal. \
A user is asking a Question about their own journal Entries. You have tools to look things up in \
their journal before you answer. Call a tool whenever you need to see actual Entries to answer \
accurately, and call it again if what came back isn't enough — narrowing, widening, or looking at \
a different stretch of time as needed. When you have enough to answer — or if nothing in the \
journal answers the Question — reply in plain prose with no further tool call: that reply is shown \
to the user exactly as written, so only write it once you are done gathering what you need. If the \
journal doesn't contain enough to answer, say so plainly instead of guessing or inventing anything \
— a Reflection that invents a past the user did not live is worse than one that admits it found \
nothing. Speak directly to the user in the second person, in plain prose.";

/// One extra turn given to the loop when its final reply comes back empty
/// (`is_empty_final_reply`) — issue #102. `agent_loop::run_one_tool_call`'s
/// own doc comment already establishes this codebase's precedent: an
/// unknown tool, an unparseable `<tool_call>` tag, a failing tool
/// execution — every one of those becomes a result the model reads on its
/// next turn and can correct from, never a failed Question outright. An
/// empty final reply is the one exit point that precedent didn't reach,
/// because it isn't a tool-call failure at all; it's the loop's *normal*
/// stopping condition firing on a reply that has nothing in it. This
/// message is what gives it the same second chance, in the same spirit:
/// tell the model plainly what happened and what to do next, then let it
/// try again.
///
/// Bounded to exactly one extra call to `agent_loop::run` —
/// `run_reflect_loop` only ever sends this once. Unlike `agent_loop::run`'s
/// own "no step budget" (deliberate, per that module's doc comment, for a
/// Question that genuinely needs several tool calls), an empty reply isn't
/// evidence the Question needs more looking; it's evidence the model wrote
/// nothing on a turn where it was free to write anything. Telling it so
/// once is a reasonable accommodation for whatever intermittent cause
/// issue #102 observed (never reproduced on demand, and not chased here);
/// telling it forever would turn a single bad turn into an unbounded loop
/// with no evidence a third or fourth attempt would behave any
/// differently, so a second empty reply fails the request instead
/// (`run_reflect_loop`).
const EMPTY_REPLY_CORRECTION: &str = "Your last reply had no text in it — nothing was written, and \
no tool was called either. Look again at the Question above: either call a tool to look something \
up, or write your Answer to the user in plain prose. Do not send an empty reply again.";

/// Every shape of "nothing to say" `is_empty_final_reply` recognises, given
/// what `harness::prompted::PromptedToolClient` can actually hand back as a
/// tool-call-free reply's text (`ToolCallScanner`'s own doc comment covers
/// the wire mechanics each case below reasons about):
///
/// - Genuinely empty, or only whitespace — the shape issue #102 was
///   actually filed against: a live Turn with `length(answer) = 0`.
/// - Only a markdown code fence with nothing inside it (`` ``` `` or
///   `` ```\n``` ``). `strip_code_fences` already exists to strip a *real*
///   fence wrapped around real content (`parse_extraction`,
///   `parse_tool_call_block` reuse it for exactly that); reused here
///   because the same function correctly reduces a fence-only reply to an
///   empty string.
/// - Only a stray `<tool_call>`/`</tool_call>` tag fragment.
///   `ToolCallScanner`'s own doc comment explains how a `</tool_call>` that
///   was never opened — nothing upstream of it ever matched
///   `<tool_call>` — survives into `ContentBlock::Text` as literal
///   characters instead of being consumed as protocol (the scanner only
///   watches for `<` starting a *new* candidate tag; a bare `<` is not one
///   until proven otherwise). If that fragment is *all* the text is, there
///   is nothing under it.
/// - Only the bare `GROUNDED: yes`/`GROUNDED: no` verdict line
///   `SYSTEM_INSTRUCTION` (the fixed pipeline, still reachable through
///   `run_reflect`) asks for, read with `parse_and_strip_verdict`.
///   `LOOP_SYSTEM_INSTRUCTION` never asks the live loop for this marker,
///   but the same configured model answers both prompts, and issue #93's
///   own prototype already noted it stays "on protocol" from whatever it
///   was most recently asked to do — a bare marker with nothing after it is
///   exactly the fixed pipeline's own verdict line with the Answer half
///   missing.
///
/// Deliberately *not* on this list: ordinary prose that happens to be
/// short, or a marker line followed by real content (`GROUNDED: no\nI
/// found nothing about that.` is a real Answer, not an empty one — see
/// `parse_and_strip_verdict`'s own tests). Only the degenerate case where
/// stripping every one of these away leaves nothing counts as empty.
fn is_empty_final_reply(text: &str) -> bool {
    let candidate = strip_code_fences(text)
        .replace("<tool_call>", "")
        .replace("</tool_call>", "");
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return true;
    }
    let (verdict, rest) = parse_and_strip_verdict(candidate);
    verdict.is_some() && rest.trim().is_empty()
}

/// A model's final reply, guaranteed non-empty — `new` is the only way to
/// build one, and it refuses everything `is_empty_final_reply` recognises
/// as nothing to say. This is issue #102's answer to its own acceptance
/// criterion that `grounded: true` be unreachable with an empty Answer
/// "structurally rather than by convention": `docs/adr/0024` made the
/// mirror case (`grounded: true` reachable with empty `grounding_entry_ids`)
/// unrepresentable by deriving `grounded` from the same data at the one
/// place it's computed, rather than trusting a second independent field —
/// there is no equivalent shared derivation available here, since whether
/// the model found any Entries and whether it wrote a non-empty Answer are
/// genuinely independent facts. What *is* available, and is the same idea
/// applied to what's actually true here, is a single gate every route from
/// "a raw model reply" to "the `answer: String` stored in `ReflectResponse`
/// and `NewTurn`" has to pass through: `run_reflect_loop` never reads
/// `outcome.answer` directly into either of those — it only ever reads
/// `NonEmptyAnswer::into_inner()`'s output, and that function does not
/// exist unless `new` already accepted the text. A future caller who
/// forgets to check emptiness has nothing to forget: there is no plain
/// `String` in scope by the time `grounded` and `answer` are packaged
/// together.
///
/// This is a narrower guarantee than a type-level ban on ever constructing
/// `ReflectResponse { answer: String::new(), grounded: true, .. }`
/// anywhere in the crate — both structs keep plain `pub` fields (they
/// always did, and `ReflectResponse` is serialized wire shape besides), so
/// nothing stops a hypothetical future call site from building one by hand
/// with an empty string. Locking that down would mean giving both structs
/// private fields and a smart constructor, which would also have to reach
/// `run_reflect`'s own, already-`#[allow(dead_code)]`, construction of the
/// same two types — exactly the "elaborate machinery around `grounded`"
/// issue #102 says not to build, for a field issue #99 is already removing.
/// What this type actually guarantees is narrower but still load-bearing:
/// the *only* code path that exists today for turning a live model reply
/// into a persisted, client-visible Answer cannot do so with an empty one.
struct NonEmptyAnswer(String);

impl NonEmptyAnswer {
    fn new(raw: &str) -> Option<Self> {
        if is_empty_final_reply(raw) {
            None
        } else {
            Some(Self(raw.trim().to_string()))
        }
    }

    fn into_inner(self) -> String {
        self.0
    }
}

/// `/v1/reflect`'s live implementation (issue #93 pass 2): loads the
/// Session's prior Turns exactly as `run_reflect` always did, builds a
/// `harness::types::Context` from them plus the active tool set, runs
/// `harness::agent_loop::run` against a `PromptedToolClient` wrapping
/// `reflect.chat_client`, and — only once the loop actually produced an
/// Answer — persists every step it took into the Session entry tree
/// (`sessions::record_turn_from_steps`) in one transaction, the same
/// "persist only after success" guarantee `record_turn` always gave.
///
/// `grounded`/`fallback_used` mean something narrower here than they did
/// under the old pipeline (`ReflectResponse`'s own doc comments describe
/// what they used to mean): `grounded` is simply "at least one Entry
/// appeared in a tool result this run", and `fallback_used` is always
/// `false` — the loop has no disclosed-fallback mechanism yet. The wire
/// shape itself is unchanged (`PROTOCOL_VERSION` stays 1) because that
/// wire change is issue #96's, not this one's; these two fields keep their
/// old *names* while this function gives them the simplest honest meaning
/// available today.
async fn run_reflect_loop(
    pool: &PgPool,
    reflect: &ReflectState,
    req: ReflectRequest,
) -> Result<ReflectResponse, ReflectError> {
    let offset_minutes = req
        .utc_offset_minutes
        .clamp(MIN_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES);

    let (prior_turns, title): (Vec<SessionTurnRow>, String) = match req.session_id {
        Some(id) => {
            let session = sessions::find_session(pool, id)
                .await?
                .ok_or(ReflectError::SessionNotFound)?;
            let turns = sessions::load_turns(pool, id).await?;
            (turns, session.title)
        }
        None => (Vec::new(), derive_title(&req.question)),
    };

    // Same windowing `run_reflect` applies — `CONVERSATION_WINDOW`'s own
    // doc comment covers why, and it applies identically here: what's
    // replayed into the loop's own `Context.messages` is bounded the same
    // way what used to be replayed into the two fixed chat calls was.
    let prior_turns = {
        let mut turns = prior_turns;
        let start = turns.len().saturating_sub(CONVERSATION_WINDOW);
        turns.split_off(start)
    };

    // Issue #97's between-Turns compaction — `maybe_compact_prior_turns`'s
    // own doc comment covers why this, not a change inside
    // `agent_loop::run`, is where a Session's cross-Question growth gets
    // trimmed, and why it is safe to write straight to the tree here.
    // `CONVERSATION_WINDOW` above already caps *how many* Turns get this
    // far; this is the token-aware pass underneath it, and can still fire
    // well before ten Turns ever accumulate.
    //
    // `existing_summary` is read unconditionally, on every request with a
    // Session — not only the one that happens to trigger a *new*
    // compaction — because `sessions::latest_compaction_summary`'s own doc
    // comment names exactly the bug that skipping this would reintroduce:
    // a summary that only ever reached the one Question that wrote it.
    let (prior_summary, prior_turns) = match req.session_id {
        Some(session_id) => {
            let existing_summary = sessions::latest_compaction_summary(pool, session_id).await?;
            maybe_compact_prior_turns(
                pool,
                session_id,
                prior_turns,
                existing_summary,
                &reflect.chat_client,
                reflect.context_window,
            )
            .await?
        }
        None => (None, prior_turns),
    };

    // Four tools now: `entries_in_range` (issue #93, by date),
    // `search_entries` (issue #94, by word), `similar_entries` (issue #94,
    // by meaning) and `read_digest` (issue #95, a written summary rather
    // than raw Entries at all) — each independently constructible, so a
    // future caller (issue #100's evaluation) can build its own subset of
    // this same `Vec` to compare arms without touching `run_reflect_loop`
    // itself. `search_entries` and `similar_entries` stay two tools rather
    // than one merged one deliberately — see `harness::tools`'s own doc
    // comment for why.
    let tools: Vec<Arc<dyn AgentTool>> = vec![
        Arc::new(EntriesInRangeTool::new(pool.clone(), offset_minutes)),
        Arc::new(SearchEntriesTool::new(pool.clone(), offset_minutes)),
        Arc::new(SimilarEntriesTool::new(
            pool.clone(),
            reflect.embed_client.clone(),
            offset_minutes,
        )),
        Arc::new(ReadDigestTool::new(pool.clone())),
    ];
    let system_prompt = tools::render_tool_guidance(LOOP_SYSTEM_INSTRUCTION, &tools);

    // `prior_summary` is `Some` only when `maybe_compact_prior_turns` just
    // wrote one — prepended here as the same kind of synthetic
    // `Message::User` `harness::compaction::transform_context` prepends
    // intra-run, so a model reading this Question's `Context` cannot tell
    // which half of compaction produced it.
    let mut messages = Vec::with_capacity(prior_turns.len() * 2 + 2);
    if let Some(summary) = prior_summary {
        messages.push(Message::User(format!(
            "{}{summary}",
            compaction::SUMMARY_MARKER
        )));
    }
    messages.extend(turns_to_messages(&prior_turns));
    messages.push(Message::User(req.question.clone()));

    let chat_client = PromptedToolClient::new(reflect.chat_client.clone());
    // `should_stop_after_turn` is `agent_loop::run`'s own unused hook
    // (`ShouldStopAfterTurn`'s doc comment) — issue #93 pass 2 ships no
    // step budget, deliberately, so `None` every time.
    //
    // `messages`/`system_prompt` are cloned here, rather than moved
    // straight into `run`, so both are still around to build a retry below
    // if this first call's final reply turns out to be empty — the
    // ordinary case never needs them again, so the clone is spent only
    // once, ahead of a chat call that already costs several seconds.
    let mut outcome = agent_loop::run(
        &chat_client,
        system_prompt.clone(),
        &tools,
        messages.clone(),
        None,
        Some(reflect.context_window),
    )
    .await;

    // issue #102: "no tool call left in the reply" is the loop's normal
    // stopping condition (`agent_loop::LoopOutcome::answer`'s own doc
    // comment), and an *empty* reply satisfies that condition exactly as
    // well as a real Answer does — nothing about the stopping rule implies
    // the model actually wrote something. `EMPTY_REPLY_CORRECTION`'s own
    // doc comment covers why this gets exactly one corrective turn, giving
    // the model the same chance to self-correct issue #93 already gives an
    // unknown tool or an unparseable call, bounded so a model that keeps
    // producing nothing can't turn one bad Question into an unbounded loop.
    let mut retried = false;
    if outcome.answer.as_deref().is_some_and(is_empty_final_reply) {
        retried = true;
        tracing::warn!(
            question = %req.question,
            session_id = ?req.session_id,
            "reflect loop's final reply was empty; giving it one corrective turn"
        );
        let mut retry_messages = messages;
        retry_messages.extend(agent_loop::steps_to_messages(&outcome.steps));
        retry_messages.push(Message::User(EMPTY_REPLY_CORRECTION.to_string()));
        let retry_outcome = agent_loop::run(
            &chat_client,
            system_prompt,
            &tools,
            retry_messages,
            None,
            Some(reflect.context_window),
        )
        .await;

        // Every `Step` from *both* attempts is kept, not just the retry's
        // own — the first attempt's tool calls are real Grounding (the bug
        // this issue was filed against found 35 real Entries before the
        // reply that described them came back empty), and dropping them
        // just because the reply that followed them didn't land would
        // silently narrow the Answer's Grounding for no honest reason. The
        // empty reply itself is kept too, as an ordinary, non-final
        // `Step::Assistant` — `build_tree_payloads` already treats every
        // Assistant step but the last as "made a tool call, isn't the
        // Answer", so this reads the same way a malformed tool call
        // already does: a truthful record of what actually happened on
        // the way to the real Answer, not the Answer itself.
        let mut steps = outcome.steps;
        steps.extend(retry_outcome.steps);
        outcome = agent_loop::LoopOutcome {
            steps,
            answer: retry_outcome.answer,
            error: retry_outcome.error,
        };
    }

    // `NonEmptyAnswer::new` is the single gate issue #102 adds — see its own
    // doc comment for why this, rather than a second independent check, is
    // what keeps `grounded: true` from ever reaching the client (or
    // `sessions::record_turn_from_steps`) paired with an empty Answer:
    // nothing below this point ever reads `outcome.answer` directly again.
    let Some(answer) = outcome.answer.as_deref().and_then(NonEmptyAnswer::new) else {
        if retried {
            tracing::warn!(
                question = %req.question,
                session_id = ?req.session_id,
                "reflect loop's final reply was still empty after a corrective turn; \
                 failing the request"
            );
        }
        let reason = outcome.error.unwrap_or_else(|| {
            "the model stopped without ever producing a reply with no tool \
                                 call left in it"
                .to_string()
        });
        return Err(ReflectError::Internal(anyhow::anyhow!(
            "reflect loop did not produce an Answer: {reason}"
        )));
    };
    let answer = answer.into_inner();

    // Every Entry id any tool result surfaced, deduped keeping first
    // occurrence — the loop-based counterpart of `run_reflect`'s own
    // `merged`/`seen` dedup, generic across whatever tool produced it
    // rather than specific to the fixed pipeline's three named sources.
    let mut seen_entry_ids = HashSet::new();
    let mut grounding_entry_ids = Vec::new();
    for step in &outcome.steps {
        if let Step::ToolResult { entry_ids, .. } = step {
            for id in entry_ids {
                if seen_entry_ids.insert(*id) {
                    grounding_entry_ids.push(*id);
                }
            }
        }
    }
    let grounded = !grounding_entry_ids.is_empty();
    let fallback_used = false;

    let payloads = build_tree_payloads(
        &req.question,
        &outcome.steps,
        &grounding_entry_ids,
        grounded,
    );
    let session_id = sessions::record_turn_from_steps(
        pool,
        req.session_id,
        &title,
        NewTurn {
            question: req.question.clone(),
            answer: answer.clone(),
            grounding_entry_ids: grounding_entry_ids.clone(),
            grounded,
            fallback_used,
        },
        payloads,
    )
    .await?;

    Ok(ReflectResponse {
        session_id,
        title,
        answer,
        grounding_entry_ids,
        grounded,
        fallback_used,
    })
}

/// `prior_turns`, as the `[User, Assistant]` message pairs
/// `run_reflect_loop` replays into the loop's own `Context` — factored out
/// of that function so `maybe_compact_prior_turns` can build the same
/// `Vec<Message>` `harness::compaction::should_compact`/`find_cut_point`
/// actually judge, rather than a second, only-approximately-the-same
/// rendering. Each Turn always contributes exactly two messages, in that
/// order, and never a `Message::ToolResult` — `SessionTurnRow` only ever
/// carries a Turn's own Question and (already-collapsed) final Answer, not
/// the tool calls that produced it — which is what makes every even index
/// into the result a safe Turn boundary: nothing here can ever trip the
/// tool-call/tool-result rule `harness::compaction::is_valid_cut_point`
/// enforces, because nothing here is a tool call or a tool result at all.
fn turns_to_messages(turns: &[SessionTurnRow]) -> Vec<Message> {
    let mut messages = Vec::with_capacity(turns.len() * 2);
    for turn in turns {
        messages.push(Message::User(turn.question.clone()));
        messages.push(Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::Text(turn.answer.clone())],
            stop_reason: StopReason::Stop,
            error_message: None,
            usage: None,
        }));
    }
    messages
}

/// Issue #97's *between*-Turns compaction. `harness::compaction`'s own doc
/// comment names this function as the reason a compaction is never written
/// from inside a running `agent_loop::run` call: doing it there would land
/// the `sessions::EntryType::Compaction` entry *inside* the current Turn's
/// own step chain, severing that Turn's leading `user` entry from the tree
/// `sessions::entries_to_turns` walks and silently erasing the very Turn
/// that triggered it from every future read. Called here, before
/// `run_reflect_loop` has appended anything for the *current* Question at
/// all, the entry this writes always lands cleanly on the boundary between
/// the last already-persisted Turn and whatever Turn is about to happen —
/// never inside one.
///
/// **Always summarises every Turn in `prior_turns`, never a suffix of
/// them** — `sessions::append_compaction`'s own doc comment covers why a
/// partial keep is not just undesirable but impossible: `session_entries`
/// is append-only, so a compaction written now can only ever describe
/// "everything up to the current leaf," and the current leaf, at this
/// point in `run_reflect_loop`, is the *last* already-persisted Turn.
/// `harness::compaction::KEEP_RECENT_TOKENS`/`find_cut_point` — the
/// "keep some of the tail verbatim" logic — has no equivalent here for
/// exactly that reason; it belongs to `agent_loop::run`'s ephemeral
/// `messages`, which has no such constraint, not to this persisted
/// checkpoint.
///
/// `existing_summary` is whatever `sessions::latest_compaction_summary`
/// already found for this Session (`run_reflect_loop`'s own call, made
/// unconditionally, every request — see that function's own doc comment
/// for why). When compaction fires here, it is threaded into the new
/// summarisation call (`summarize_prior_turns`) so the new summary still
/// carries whatever the *previous* one held, rather than losing it the
/// moment a fresh Compaction entry becomes the path's new last one
/// (`sessions::project_from_last_compaction` only ever looks at the *last*
/// compaction — this is what keeps that from silently discarding the
/// first). This is a deliberate, narrow exception to "skip iterative
/// summary update" (issue #97's own scope note): a *between*-Turns
/// compaction has no pinned-message trick available to it the way
/// `harness::compaction::transform_context`'s does (there is no persisted
/// wire `Message` for a summary to live in — only Turns), so folding the
/// old summary into the new one exactly once, rather than losing it, is
/// the only option this shape of storage leaves. It differs from pi's own
/// iterative update in the way that matters: this still fires at most once
/// per compaction event, never a background refinement pass.
///
/// Returns `(existing_summary, prior_turns)` unchanged whenever nothing new
/// needs to happen — no prior Turns, comfortably under budget, or a Session
/// with no entry tree yet to safely write onto (`sessions::append_compaction`'s
/// own `Ok(false)`, mirroring the same conservative choice
/// `sessions::load_turns`'s `session_turns` fallback already makes for that
/// case) — so a caller always gets back *some* summary to show the model
/// when one exists, whether or not this particular call is the one that
/// just wrote it.
async fn maybe_compact_prior_turns(
    pool: &PgPool,
    session_id: Uuid,
    prior_turns: Vec<SessionTurnRow>,
    existing_summary: Option<String>,
    chat_client: &Arc<dyn LlmClient + Send + Sync>,
    context_window: u32,
) -> anyhow::Result<(Option<String>, Vec<SessionTurnRow>)> {
    if prior_turns.is_empty() {
        return Ok((existing_summary, prior_turns));
    }

    let as_messages = turns_to_messages(&prior_turns);
    if !compaction::should_compact(&as_messages, context_window) {
        return Ok((existing_summary, prior_turns));
    }

    let summary =
        summarize_prior_turns(chat_client, existing_summary.as_deref(), &prior_turns).await?;
    if !sessions::append_compaction(pool, session_id, &summary).await? {
        return Ok((existing_summary, prior_turns));
    }

    Ok((Some(summary), Vec::new()))
}

/// What `maybe_compact_prior_turns` sends the model to actually produce a
/// summary — a separate, one-off chat call against `llm::LlmClient`
/// directly (not `harness::chat::ChatClient` — this runs before
/// `agent_loop::run` even starts, and has no tool-calling protocol to speak
/// in the first place), the same interface `reflect.rs`'s own extraction
/// call (`try_extract`) already uses this way. `existing_summary`, when
/// given, is rendered first, ahead of every Turn — see
/// `maybe_compact_prior_turns`'s own doc comment for why folding it in here
/// is the one place this ticket doesn't avoid re-reading already-condensed
/// text through the model.
const CONVERSATION_SUMMARY_SYSTEM_PROMPT: &str = "You summarise conversations. Be concise and \
factual. Keep anything a later turn might still need: names, dates, specific facts, and what was \
already found or ruled out. Do not answer any question in the conversation — only describe it.";

async fn summarize_prior_turns(
    chat_client: &Arc<dyn LlmClient + Send + Sync>,
    existing_summary: Option<&str>,
    turns: &[SessionTurnRow],
) -> anyhow::Result<String> {
    let mut transcript = String::new();
    if let Some(existing) = existing_summary {
        transcript.push_str("Summary of the conversation so far:\n");
        transcript.push_str(existing);
        transcript.push_str("\n\n");
    }
    for turn in turns {
        transcript.push_str(&format!("Q: {}\nA: {}\n\n", turn.question, turn.answer));
    }
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: CONVERSATION_SUMMARY_SYSTEM_PROMPT.to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("{transcript}Summarize the conversation above concisely."),
        },
    ];
    Ok(chat_client.chat(&messages).await?.content)
}

/// Turns one loop run's `Question` plus its `Step`s into the ordered
/// `(EntryType, Value)` payload list `sessions::record_turn_from_steps`
/// chains onto the Session's tree — the User entry first (the tree has no
/// separate concept of "the request that started this Turn" the way
/// `Context.messages` does), then one entry per `Step`, in the order they
/// happened.
///
/// Only the *last* `Assistant` step carries `grounding_entry_ids`/
/// `grounded` in its persisted payload — it is the only one
/// `sessions::entries_to_turns` will ever read back as a Turn's answer (its
/// own doc comment covers why: the *last* Assistant entry in a Turn's run
/// is the one that actually answered, not the first). An earlier Assistant
/// step exists only because it made a tool call; giving it the same
/// Grounding as the real answer would be misleading if anything ever read
/// it directly, and `entries_to_turns` never will.
fn build_tree_payloads(
    question: &str,
    steps: &[Step],
    grounding_entry_ids: &[Uuid],
    grounded: bool,
) -> Vec<(EntryType, Value)> {
    let mut payloads = Vec::with_capacity(steps.len() + 1);
    payloads.push((
        EntryType::Message,
        serde_json::to_value(MessagePayload::User {
            text: question.to_string(),
        })
        .expect("serializing a user message payload can't fail"),
    ));

    let last_index = steps.len().saturating_sub(1);
    for (index, step) in steps.iter().enumerate() {
        let payload = match step {
            Step::Assistant(assistant) => {
                let is_final_answer = index == last_index;
                serde_json::to_value(MessagePayload::Assistant {
                    text: agent_loop::render_content_for_display(&assistant.content),
                    grounding_entry_ids: if is_final_answer {
                        grounding_entry_ids.to_vec()
                    } else {
                        Vec::new()
                    },
                    grounded: is_final_answer && grounded,
                    fallback_used: false,
                })
            }
            Step::ToolResult {
                tool_name,
                content,
                is_error,
                details,
                ..
            } => serde_json::to_value(MessagePayload::ToolResult {
                text: content.clone(),
                tool_name: tool_name.clone(),
                is_error: *is_error,
                details: details.clone(),
            }),
        }
        .expect("serializing a message payload can't fail");
        payloads.push((EntryType::Message, payload));
    }

    payloads
}

/// The fixed three-source pipeline tickets 4 through 8 built
/// (`docs/adr/0023`, `docs/adr/0024`) — an extraction chat call, three
/// concurrent retrievals merged and capped, an answering call that judges
/// its own Grounding via a "GROUNDED: yes/no" marker, and a disclosed
/// fallback when it judges "no". Issue #93 pass 2 stopped calling this from
/// `reflect_handler` (see `run_reflect_loop`, the loop-based replacement,
/// above) but was instructed *not* to delete it — issue #99 is the ticket
/// that formally retires this function and everything only it still calls.
/// Kept exactly as it was, working and tested, rather than removed early.
#[allow(dead_code)]
async fn run_reflect(
    pool: &PgPool,
    reflect: &ReflectState,
    req: ReflectRequest,
) -> Result<ReflectResponse, ReflectError> {
    let offset_minutes = req
        .utc_offset_minutes
        .clamp(MIN_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES);

    // Resolved before any retrieval or chat call runs, so a `session_id`
    // naming no Session fails fast — as a clean 404 — instead of spending
    // an extraction call, three retrievals and an answering call on a
    // Question that can never be persisted. `None` starts a new Session:
    // no prior Turns, and a title derived from this Question rather than an
    // existing one's.
    let (prior_turns, title): (Vec<SessionTurnRow>, String) = match req.session_id {
        Some(id) => {
            let session = sessions::find_session(pool, id)
                .await?
                .ok_or(ReflectError::SessionNotFound)?;
            let turns = sessions::load_turns(pool, id).await?;
            (turns, session.title)
        }
        None => (Vec::new(), derive_title(&req.question)),
    };

    // `load_turns` returns every Turn the Session has, oldest first — that
    // full history is exactly right for `GET /v1/sessions/{id}`, which
    // reuses the same function to render a whole Conversation. What's
    // replayed into a chat call is a narrower thing (`CONVERSATION_WINDOW`'s
    // own doc comment): keep only the most recent `CONVERSATION_WINDOW`
    // Turns, dropping older ones, while leaving the survivors in the same
    // oldest-first order `build_messages` expects — `split_off` on a
    // saturating start index does exactly that without reversing anything,
    // and is a no-op slice when there are `CONVERSATION_WINDOW` Turns or
    // fewer.
    let prior_turns = {
        let mut turns = prior_turns;
        let start = turns.len().saturating_sub(CONVERSATION_WINDOW);
        turns.split_off(start)
    };

    // Chat call 1 — never fails this Question. Any failure (a chat call
    // that errors or times out, a response that isn't JSON, a nonsensical
    // range) degrades to `Extraction::default()`, which makes the fan-out
    // below behave exactly like ticket 4: question-only retrieval. Reads
    // the same windowed `prior_turns` the answering call gets, so a
    // follow-up ("and the week before that?") resolves against the
    // Conversation it's actually a follow-up to, rather than being extracted
    // from the bare Question text alone (issue #66).
    let extraction =
        extract_date_range_and_keyword(reflect, &req.question, offset_minutes, &prior_turns).await;

    // Three retrievals, run concurrently — they are independent and each
    // embedding call costs real latency. Source 2 and 3 are no-ops (an
    // immediate empty `Ok`) when extraction found nothing to feed them, so
    // this always resolves to exactly the three futures below regardless of
    // what extraction returned.
    //
    // Question search is the one source with no floor left to fall back to
    // if it fails: ticket 4 (question-only retrieval) *is* the floor
    // everything else here has to preserve, so a failure here propagates —
    // that "at least what ticket 4 already gave" (docs/adr/0023, on
    // extraction failure) is exactly as true of the Question's own
    // embedding call as it is of extraction, since ticket 4 already
    // returned an error in precisely this case.
    let question_search = async {
        // The *query* embedding, not `embed_document` — Harrier's
        // instruction wrapper is what widens the relevant-vs-irrelevant
        // margin for text used to search, per `llm.rs`'s own doc comment on
        // the trait method.
        let query_vector = reflect
            .embed_client
            .embed_query(&req.question)
            .await
            .context("embedding the question failed")?;
        retrieve_nearest(pool, &query_vector, RETRIEVAL_LIMIT).await
    };

    // Keyword and range search exist purely to *widen* recall beyond
    // question-only retrieval (docs/adr/0023's fan-out) — a source whose
    // only job is widening must never be able to narrow the Answer to zero
    // by failing. Each degrades its own `Err` (a transient embedding-call
    // or database failure) to an empty `Vec` plus a `warn` naming which
    // source failed and why — exactly the posture extraction failure
    // already takes — rather than failing a Question that question-only
    // retrieval alone would have answered.
    let keyword_search = async {
        let result: anyhow::Result<Vec<GroundingEntry>> = async {
            match &extraction.keyword {
                Some(keyword) => {
                    let keyword_vector = reflect
                        .embed_client
                        .embed_query(&keyword_query(keyword))
                        .await
                        .context("embedding the extracted keyword failed")?;
                    retrieve_nearest(pool, &keyword_vector, RETRIEVAL_LIMIT).await
                }
                None => Ok(Vec::new()),
            }
        }
        .await;

        result.unwrap_or_else(|err| {
            tracing::warn!(
                error = ?err,
                source = "keyword",
                "widening retrieval failed; degrading to empty rather than narrowing the Answer \
                 below what question-only retrieval already gives"
            );
            Vec::new()
        })
    };

    let range_search = async {
        let result: anyhow::Result<Vec<GroundingEntry>> = async {
            match extraction.date_range {
                Some((from, to)) => {
                    let (from_utc, to_utc) = local_date_range_to_utc(from, to, offset_minutes);
                    retrieve_range(pool, from_utc, to_utc, RETRIEVAL_LIMIT).await
                }
                None => Ok(Vec::new()),
            }
        }
        .await;

        result.unwrap_or_else(|err| {
            tracing::warn!(
                error = ?err,
                source = "range",
                "widening retrieval failed; degrading to empty rather than narrowing the Answer \
                 below what question-only retrieval already gives"
            );
            Vec::new()
        })
    };

    // `join!`, not `try_join!` — the two widening sources above have
    // already turned their own failures into an empty `Vec`, so the only
    // `Result` left to resolve here is the question search's, and it alone
    // can still fail the Question (see its own comment above).
    let (question_result, keyword_entries, range_entries) =
        tokio::join!(question_search, keyword_search, range_search);
    let question_entries = question_result?;

    // Merge rule (docs/adr/0023): concatenate in source *priority* order —
    // question-search (similarity desc, as `retrieve_nearest` already
    // orders it), then keyword-search (similarity desc), then range
    // (recency desc, as `retrieve_range` already orders it) — dedupe by
    // Entry id keeping the first occurrence, then truncate to
    // `RETRIEVAL_LIMIT`. Priority order is load-bearing: the Question's own
    // vector is the most trustworthy signal, and a wide extracted range
    // ("this year") can return `RETRIEVAL_LIMIT` rows on its own — putting
    // range last means it never crowds out the Entries the Question's own
    // search actually asked for.
    let mut seen = HashSet::with_capacity(RETRIEVAL_LIMIT as usize);
    let mut merged: Vec<GroundingEntry> = Vec::with_capacity(RETRIEVAL_LIMIT as usize);
    for entry in question_entries
        .into_iter()
        .chain(keyword_entries)
        .chain(range_entries)
    {
        if seen.insert(entry.id) {
            merged.push(entry);
        }
    }
    merged.truncate(RETRIEVAL_LIMIT as usize);

    // Retrieval order above is by priority/similarity/recency; reading
    // order for the prompt should be by time, so the model sees the user's
    // history unfold the way the user lived it rather than in a
    // relevance-shuffled order. Sorting happens *after* the cap, not
    // before — the priority order is what decides which Entries survive
    // truncation.
    merged.sort_by_key(|entry| entry.created_at);

    let grounding_entry_ids: Vec<Uuid> = merged.iter().map(|entry| entry.id).collect();

    let messages = build_messages(SYSTEM_INSTRUCTION, &merged, &prior_turns, &req.question);
    let raw_answer = reflect
        .chat_client
        .chat(&messages)
        .await
        .context("chat call failed")?
        .content;
    let (verdict, answer) = parse_and_strip_verdict(&raw_answer);
    let grounded = match verdict {
        Some(verdict) => verdict,
        None => {
            // A missing or unrecognised marker must still fail open when
            // there is real Grounding behind it — the opposite default
            // (always ungrounded) would fire the fallback and its extra
            // chat call on every response that merely forgot the marker,
            // even when retrieval genuinely found something. But it must
            // never let `grounded: true` reach the client paired with an
            // empty `grounding_entry_ids`: that combination is exactly what
            // CONTEXT.md's "an Answer with no Grounding behind it says so
            // plainly" forbids, and nothing but the model's own wording
            // would say anything was missing if it were allowed. Defaulting
            // to `!merged.is_empty()` gets both: a forgotten marker over
            // real Grounding still degrades to ticket 5's behaviour
            // (grounded, no fallback, no third call); a forgotten marker
            // over nothing falls into the disclosed fallback below, which
            // is the correct outcome when retrieval genuinely found
            // nothing, not a wasted call.
            tracing::warn!(
                answer = %raw_answer,
                merged_is_empty = merged.is_empty(),
                "no GROUNDED marker found in the answering call's response; defaulting grounded \
                 to whether retrieval found anything"
            );
            !merged.is_empty()
        }
    };

    // The four ways this function can end (this success match, its two
    // nested arms below, plus the `?`-propagated error paths above) all
    // funnel through the single `Ok(ReflectResponse { .. })` construction at
    // the bottom of this function instead of each returning early with their
    // own hand-assembled response — see `docs/adr/0024` and ticket 6.
    let (answer, grounding_entry_ids, grounded, fallback_used) = if grounded {
        (answer, grounding_entry_ids, true, false)
    } else {
        // Reflection judged its own Grounding didn't answer the Question. The
        // disclosed fallback (docs/adr/0024): show what the user actually wrote
        // in the last FALLBACK_WINDOW_DAYS days instead of a wrong-but-confident
        // Answer built on Entries that merely shared a mood or a phrase with the
        // Question. This never merges into Grounding above and only ever runs
        // after a "no" verdict — it is a disclosed fallback, not a fourth
        // retrieval source.
        let now = Utc::now();
        let mut recent = retrieve_range(
            pool,
            now - Duration::days(FALLBACK_WINDOW_DAYS),
            now,
            RETRIEVAL_LIMIT,
        )
        .await
        .context("fallback range retrieval failed")?;
        recent.sort_by_key(|entry| entry.created_at);

        if recent.is_empty() {
            // Nothing to disclose either — keep the model's own "I found
            // nothing" Answer from the first call rather than spending a third
            // chat call on an empty result.
            (answer, Vec::new(), false, false)
        } else {
            let fallback_ids: Vec<Uuid> = recent.iter().map(|entry| entry.id).collect();
            let fallback_messages = build_messages(
                FALLBACK_SYSTEM_INSTRUCTION,
                &recent,
                &prior_turns,
                &req.question,
            );
            let fallback_answer = reflect
                .chat_client
                .chat(&fallback_messages)
                .await
                .context("fallback chat call failed")?
                .content;
            (fallback_answer, fallback_ids, false, true)
        }
    };

    // Persisted only now that a successful Answer exists — the one
    // insertion point every path above funnels through (this is the same
    // single `Ok(ReflectResponse { .. })` construction the comment above
    // describes). `sessions::record_turn` does the Session-creation-plus-
    // Turn-insert as a single transaction, so a failure anywhere above this
    // point (every `?` in this function) never reaches here at all, and a
    // failure inside `record_turn` itself leaves nothing behind either.
    let session_id = sessions::record_turn(
        pool,
        req.session_id,
        &title,
        NewTurn {
            question: req.question.clone(),
            answer: answer.clone(),
            grounding_entry_ids: grounding_entry_ids.clone(),
            grounded,
            fallback_used,
        },
    )
    .await?;

    Ok(ReflectResponse {
        session_id,
        title,
        answer,
        grounding_entry_ids,
        grounded,
        fallback_used,
    })
}

/// Wraps an extracted keyword as a question before it is embedded — e.g.
/// "wedding" becomes "What did I write about wedding?" — rather than
/// embedding the bare word. This does not touch `llm.rs`: `embed_query`
/// still adds Harrier's `Instruct:` wrapper on top of whatever string it is
/// given, and that layering is correct; this function only decides what
/// string reaches it.
///
/// Harrier pools the **last token** (`llm.rs`), so a bare topic word is out
/// of distribution against Entries that are ordinary prose — the model has
/// nothing prose-like to pool from. Measured on the live 572-Entry corpus,
/// top cosine and count of Entries at or above cosine 0.60 (the floor this
/// codebase carried at the time, since removed — issue #92), bare keyword
/// vs. the same keyword wrapped as a question:
///
/// | keyword | bare: top / ≥0.60 | wrapped: top / ≥0.60 |
/// |---|---|---|
/// | wedding | 0.507 / 0 | 0.684 / 5 |
/// | guitar | 0.558 / 0 | 0.645 / 3 |
/// | marathon training | 0.662 / 3 | 0.706 / 7 |
/// | knee | 0.670 / 4 | 0.750 / 6 |
/// | Aurora migration | 0.697 / 5 | 0.752 / 6 |
///
/// Five real wedding Entries exist in the corpus; the bare keyword found
/// none of them. This is the recall gap ticket 5 exists to close.
///
/// The cost is real, not hidden: wrapping raises similarity across the
/// board, not just for topics that are actually present, so it also lifts
/// unrelated Entries toward the top of the ranking — an absent topic, "my
/// cat", goes from 0 Entries over the then-floor to 7. It buys recall at
/// the cost of precision, a trade taken deliberately because the relevance
/// judgment moved off cosine entirely in ticket 6 (`docs/adr/0024`) and the
/// floor itself was later deleted outright, not recalibrated (issue #92,
/// `docs/adr/0023`) — precision is the answering call's job now, not this
/// function's.
fn keyword_query(keyword: &str) -> String {
    format!("What did I write about {keyword}?")
}

/// `pub` for the same reason as `GroundingEntry` above — issue #90's
/// `tests/eval_retrieval.rs` measures this arm directly against the
/// Sandbox corpus.
///
/// Returns its top `limit` rows by cosine distance, unconditionally — no
/// similarity floor is applied (issue #92 deleted `MIN_SIMILARITY`; see
/// `docs/adr/0023`'s amendment for the measurement that killed it). This
/// function no longer has an opinion about what counts as relevant; the
/// answering call does (`docs/adr/0024`), because it is the only place in
/// this request that ever sees the Question and a candidate Entry side by
/// side.
pub async fn retrieve_nearest(
    pool: &PgPool,
    query_vector: &[f32],
    limit: i64,
) -> anyhow::Result<Vec<GroundingEntry>> {
    // `embedding is not null` is the same "skip what the background worker
    // hasn't gotten to yet" guard `embedding.rs`'s scan uses on the write
    // side (ADR 0022) — a row with no vector can't be compared with `<=>`.
    // `deleted_at is null` is a second, independent guard (ticket 2): a
    // tombstone has a blank body and must never surface as Grounding for a
    // Question — and in practice it would never pass the guard above
    // anyway, since `insert_entries` nulls `embedding` on every delete, but
    // this is the guard that's actually load-bearing rather than
    // incidental, and every other reader (`retrieve_range` below,
    // `digest.rs`, `embedding.rs`'s queue) carries the same one.
    let rows = sqlx::query_as::<_, GroundingEntry>(
        "select id, body, created_at from entries
         where embedding is not null
           and deleted_at is null
         order by embedding <=> $1::vector
         limit $2",
    )
    .bind(vector_literal(query_vector))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Retrieves Entries whose `created_at` falls in the half-open UTC range
/// `[from, to)`, most recent first, capped at `limit`.
///
/// Deliberately **no `embedding is not null` guard**, unlike
/// `retrieve_nearest` above. That guard exists there because `<=>` cannot
/// compare against a null vector — it is a mechanical necessity, not a
/// judgment that an unembedded Entry is untrustworthy. A date range is an
/// exact fact about an Entry (`created_at` is set at insert time and never
/// changes), not a similarity guess, so an Entry the background embedding
/// worker hasn't reached yet is still a perfectly good answer to "what did
/// I write yesterday" — excluding it here would silently drop a true
/// answer for a reason that has nothing to do with what was actually asked.
///
/// `deleted_at is null` **is** added here (ticket 2), unlike the
/// `embedding is not null` guard above — a deleted Entry's `created_at`
/// still falls in-range (that column never changes on a delete, see
/// `sync.rs::insert_entries`), but its body is a tombstone's, not content,
/// and must not surface as Grounding just because the date matches.
/// `pub` for the same reason as `retrieve_nearest` above — issue #90's
/// eval harness measures this arm directly. No behaviour changed.
pub async fn retrieve_range(
    pool: &PgPool,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> anyhow::Result<Vec<GroundingEntry>> {
    let rows = sqlx::query_as::<_, GroundingEntry>(
        "select id, body, created_at from entries
         where created_at >= $1 and created_at < $2
           and deleted_at is null
         order by created_at desc
         limit $3",
    )
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// How well a query's trigrams must resemble some substring of an Entry's
/// body before `search_words`'s misspelling-tolerant fallback counts it as
/// a match. Lower than `pg_trgm`'s own `word_similarity_threshold` GUC
/// default (0.6) — that default is tuned for matching a query against a
/// short field of comparable length, but an Entry's body is a whole
/// paragraph of prose: `word_similarity`'s "best-matching substring" still
/// picks up plenty of noise from the surrounding sentence even for a
/// genuine, only-slightly-misspelled match, which pulls the achievable
/// score down relative to the short-field case the default was tuned for.
/// Calibrated empirically against this crate's own tests (see
/// `search_words`'s test module) rather than derived from the GUC's
/// default — the two aren't measuring the same thing.
const TRIGRAM_MATCH_THRESHOLD: f32 = 0.3;

/// The third retrieval primitive issue #94 adds, alongside
/// `retrieve_nearest` and `retrieve_range` above: finds Entries whose body
/// contains `query`'s words, tolerant of a word typed in a different form
/// than it was written in (English stemming) and, failing that, a small
/// misspelling (a `pg_trgm` fallback). See migration
/// `0007_add_entries_word_search.sql`'s own doc comment for why the
/// underlying index is a generated `tsvector` column plus two GIN indexes
/// rather than a hand-maintained one — ADR 0014 had to hand-maintain
/// SQLite's FTS5 index for a reason Postgres's generated columns don't
/// share.
///
/// Three rungs, tried in order, each only when every rung before it matched
/// *zero* rows (not merely scored low):
///
/// **Rung 1, AND**, is unchanged from this function's original shape:
/// `websearch_to_tsquery('english', $1)` (rather than plain `to_tsquery` or
/// `plainto_tsquery`, because it accepts ordinary prose — quotes,
/// `-exclude`, `OR` — without ever raising a syntax error the way
/// `to_tsquery` would on a query containing a bare `&` or `:`; the same
/// "take the query text literally no matter what it contains" requirement
/// ADR 0014 named for FTS5's own quoted-phrase escaping, met here by
/// Postgres's own query parser instead of hand escaping), ranked by
/// `ts_rank_cd` (its "cover density" variant rewards a body where the
/// query's words appear close together, which plain `ts_rank` ignores),
/// most-relevant first, then most-recent first as a stable tiebreak. But
/// `websearch_to_tsquery` **ANDs every term of the query together**, which
/// is exactly right for a tight phrase and useless for an actual question:
/// measured against this crate's own seeded Sandbox corpus (119 Entries,
/// the same one issue #100's eval harness scores against), "How has my knee
/// injury been progressing over time — is it better or worse than when it
/// started?" (95 characters) reduces to `'knee' & 'injuri' & 'progress' &
/// 'time' & 'better' | 'wors' & 'start'` and matches **zero** rows, though
/// the single term `knee` alone matches 16 and the graded expected set for
/// that question is 12 Entries. "What have I been reading lately?" fares
/// the same — zero rows via AND — which directly fails issue #94's own
/// acceptance criterion that this exact question be answerable from word
/// search. Rung 3's trigram fallback does not rescue either case: it
/// compares the *whole* question against each body via `word_similarity`,
/// and a 95-character sentence isn't textually close enough to any single
/// Entry's prose to clear `TRIGRAM_MATCH_THRESHOLD`.
///
/// **Rung 2, OR (added by issue #94), is what actually answers a
/// natural-language question:** every lexeme `query` reduces to, OR-ed
/// together instead of ANDed, tried only when rung 1 matched nothing. It
/// sits strictly *between* AND and trigram rather than replacing either —
/// replacing AND would throw away AND's precision on the tight-phrase case
/// where every term genuinely is expected together (AND already ranks that
/// case correctly and cheaply; OR would just be a noisier way to reach the
/// same top result), and replacing trigram would throw away the one thing
/// OR still cannot do: match a word that was never actually written in any
/// stemmable form at all — a real misspelling, where no stem is shared with
/// the query no matter how the terms are combined. Verified against the
/// same corpus: the OR form of the knee question matches 38 rows, the OR
/// form of the reading question matches 13. `ts_rank_cd` — the same ranker
/// rung 1 already uses — is what makes that breadth safe rather than a bag
/// of loosely related prose: an Entry matching more of the query's terms,
/// and rarer ones, scores higher than an Entry that merely shares one
/// common word, so the top-`limit` rows stay meaningful even though the
/// underlying match set is broad by construction.
///
/// The lexemes OR-ed together in rung 2 come from `to_tsquery('english',
/// array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' |
/// '))` — built *inside* the SQL, not by splitting `query` into words in
/// Rust and joining them with `|` by hand. Two reasons. First, running
/// `query` through `to_tsvector` applies the exact same English stemming
/// and stop-word removal `body_tsv` (the indexed column) was generated
/// with, so the OR'd lexemes are guaranteed to match the vocabulary the
/// index actually contains; a Rust-side tokenizer would have to
/// reimplement Postgres's stemmer to keep that guarantee, and any drift
/// between the two would silently miss matches. Second, `tsvector_to_array`
/// yields lexemes that are already normalised — lowercased, stemmed, free
/// of punctuation and stop words — and therefore safe to fold into a
/// `to_tsquery` string with `|`; building that string from raw,
/// un-tokenized user text in Rust and handing it to `to_tsquery` would be
/// both a syntax-error hazard (arbitrary text can contain `&`, `|`, `:`,
/// unbalanced parens — exactly what `websearch_to_tsquery` exists to avoid
/// in rung 1) and, since it would have to be spliced into the query string
/// instead of passed as an ordinary bound parameter, a query-injection
/// hazard. A query that reduces to zero lexemes (stop words only, or
/// punctuation only — `"the of and"`, `"!!! ???"`) makes this
/// `to_tsquery('english', '')`, which Postgres accepts: it emits a
/// `NOTICE` and evaluates to an empty tsquery that matches nothing via
/// `@@`, not an error, so this rung falls straight through to trigram the
/// same way an ordinary no-match does, with no special-casing needed here.
///
/// **Rung 3, trigram**, is otherwise unchanged from this function's
/// original shape: when rungs 1 and 2 both match nothing, a third query
/// runs, ranked by `word_similarity` against `body` (the "does the query
/// resemble *some substring* of this body" trigram operator, not
/// `similarity`'s "resemble the whole body," which would penalize a short
/// misspelled query against a long paragraph for no useful reason) and
/// filtered at `TRIGRAM_MATCH_THRESHOLD`. It stays a last resort, not a
/// blend with the earlier rungs: trigram similarity is a much noisier
/// signal than a stemmed match; running it unconditionally would let a
/// loosely-related paragraph that merely shares a lot of 3-character
/// substrings with the query outrank a real stemmed hit, or clutter every
/// already-answered search with lower-quality matches it didn't need.
///
/// It gained one guard, also from issue #94: rung 3's query additionally
/// requires `to_tsvector('english', $1) != ''::tsvector` — `query` must
/// reduce to at least one lexeme — before `word_similarity` runs at all.
/// Trigram similarity is meant to rescue a word that was *written down but
/// mistyped* ("phyiso" for "physio" still stems to a lexeme, `phyiso`,
/// even though it isn't a real word, so that case is untouched by this
/// guard and still reaches rung 3). A query that reduces to zero lexemes —
/// stop words only, or punctuation only, the same shapes rung 2 already
/// tolerates cleanly by matching nothing — contains no word to have
/// mistyped in the first place, so there is nothing for trigram similarity
/// to be tolerant *of*: without this guard, `word_similarity('the of and',
/// body)` clears `TRIGRAM_MATCH_THRESHOLD` (0.3) at up to 0.727 against
/// this crate's own seeded Sandbox corpus, on Entries that share nothing
/// with the query except those three common words, and a query with no
/// searchable words at all would come back reporting a page of unrelated
/// Entries as matches.
///
/// This function makes no network call and has no failure mode
/// `harness::tools::SearchEntriesTool` needs to translate specially — any
/// `Err` here is an ordinary database error, handled the same way
/// `EntriesInRangeTool` already handles one from `retrieve_range`.
///
/// `pub` for the same reason `retrieve_nearest`/`retrieve_range` are:
/// `server/tests/eval_retrieval.rs`'s three-arm comparison (issue #100)
/// calls this directly, exactly the way it already calls the other two.
pub async fn search_words(
    pool: &PgPool,
    query: &str,
    limit: i64,
) -> anyhow::Result<Vec<GroundingEntry>> {
    let rows = sqlx::query_as::<_, GroundingEntry>(
        "select id, body, created_at from entries
         where deleted_at is null
           and body_tsv @@ websearch_to_tsquery('english', $1)
         order by ts_rank_cd(body_tsv, websearch_to_tsquery('english', $1)) desc, created_at desc
         limit $2",
    )
    .bind(query)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    if !rows.is_empty() {
        return Ok(rows);
    }

    // Rung 2 (issue #94): every lexeme of `query`, OR-ed together instead
    // of ANDed, ranked the same way rung 1 is. See this function's own doc
    // comment for the measured AND-only failure this exists to fix, why it
    // sits between AND and trigram rather than replacing either, and why
    // the lexemes are derived from `to_tsvector` in SQL rather than by
    // splitting `query` in Rust.
    let rows = sqlx::query_as::<_, GroundingEntry>(
        "select id, body, created_at from entries
         where deleted_at is null
           and body_tsv @@ to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' | '))
         order by ts_rank_cd(body_tsv, to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' | '))) desc, created_at desc
         limit $2",
    )
    .bind(query)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    if !rows.is_empty() {
        return Ok(rows);
    }

    // Rung 3 (issue #94): gated on `query` having at least one lexeme,
    // alongside its existing threshold — `word_similarity` operates on raw
    // trigrams, not `body_tsv`, so nothing about its own predicate would
    // otherwise exclude a zero-lexeme query the way rung 2's `@@` does. See
    // this function's own doc comment for why trigram similarity on a
    // stop-words/punctuation-only query is not misspelling tolerance, and
    // the measured false-positive rate that motivated this guard.
    let rows = sqlx::query_as::<_, GroundingEntry>(
        "select id, body, created_at from entries
         where deleted_at is null
           and to_tsvector('english', $1) != ''::tsvector
           and word_similarity($1, body) >= $2
         order by word_similarity($1, body) desc, created_at desc
         limit $3",
    )
    .bind(query)
    .bind(TRIGRAM_MATCH_THRESHOLD)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Converts an inclusive local `[from, to]` calendar-date range into the
/// half-open UTC instant range `retrieve_range` needs: `from` local
/// midnight becomes `from_utc` by subtracting the offset, and `to`'s local
/// *next* day midnight becomes `to_utc` the same way — so `[from_utc,
/// to_utc)` covers every instant of every local day from `from` through
/// `to` inclusive, and a single-day range (`from == to`) covers exactly
/// that one whole local day.
///
/// `pub(crate)` (rather than the private visibility every other date helper
/// here keeps) so `harness::tools::entries_in_range` can resolve its own
/// `from`/`to` arguments the same way the old extraction pipeline resolved
/// its extracted range — a tool call's dates are local calendar dates from
/// the same asking Device, and there is exactly one correct way to turn
/// those into a UTC instant range, already written here.
pub(crate) fn local_date_range_to_utc(
    from: NaiveDate,
    to: NaiveDate,
    offset_minutes: i32,
) -> (DateTime<Utc>, DateTime<Utc>) {
    let from_utc = local_midnight_to_utc(from, offset_minutes);
    let to_utc = local_midnight_to_utc(to + Duration::days(1), offset_minutes);
    (from_utc, to_utc)
}

/// Local midnight of `date`, converted to the UTC instant it corresponds
/// to. Local time is UTC plus the offset (the same sign convention
/// `deviceUtcOffsetMinutes`/`toLocalParts` use — positive is east of UTC),
/// so recovering the UTC instant from a local wall-clock time means
/// subtracting the offset.
fn local_midnight_to_utc(date: NaiveDate, offset_minutes: i32) -> DateTime<Utc> {
    let local_midnight = date
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 is always a valid time");
    let utc_naive = local_midnight - Duration::minutes(i64::from(offset_minutes));
    DateTime::<Utc>::from_naive_utc_and_offset(utc_naive, Utc)
}

/// Today's date in the asking Device's local day, derived from
/// `offset_minutes` — never the server's own clock, which may be in a
/// different timezone than the Device asking. Mirrors the sign convention
/// `local_midnight_to_utc` uses in reverse: local time is UTC plus offset.
fn local_today(offset_minutes: i32) -> NaiveDate {
    (Utc::now() + Duration::minutes(i64::from(offset_minutes))).date_naive()
}

/// Builds the extraction call's system prompt — always starting with
/// "Today's date" (`is_extraction_call` in `tests/reflect.rs` depends on
/// that exact phrase appearing in this call's first message, so it must
/// stay the leading sentence), and, when `prior_turns` is non-empty, folding
/// in a compact rendering of the windowed recent Conversation
/// (`render_conversation_for_extraction`) so a follow-up Question like "and
/// the week before that?" can be resolved against what it actually follows
/// (issue #66).
///
/// The Conversation is folded into *this* system message's content as
/// plain `Q:`/`A:` prose, not appended to `try_extract`'s `messages` as real
/// `user`/`assistant` turns. That choice is deliberate: this call's entire
/// contract is a small JSON object (`parse_extraction`), and a real
/// `assistant`-role Answer in the message list risks the model continuing
/// in prose the way a genuine conversation would, rather than replying with
/// bare JSON. A rendered block inside one system message carries the same
/// information without ever looking, to the model, like a turn it should
/// continue. The JSON-only instruction is repeated at the very end, after
/// the Conversation block, so it is the last thing the model reads
/// regardless of how much Conversation precedes it.
fn extraction_system_prompt(today_local: NaiveDate, prior_turns: &[SessionTurnRow]) -> String {
    let mut prompt = format!(
        "Today's date, in the user's own local timezone, is {today}. The user is about to ask a \
         Question about their own personal journal.",
        today = today_local.format("%Y-%m-%d")
    );

    if !prior_turns.is_empty() {
        prompt.push_str(
            "\n\nFor context only, here is the recent Conversation leading up to this new \
             Question, oldest first. Use it only to work out what the new Question refers to \
             (e.g. \"that\", \"the week before\", \"him\") — none of it is itself the Question \
             to extract from, and nothing in it changes the JSON-only instruction below.\n\n",
        );
        prompt.push_str(&render_conversation_for_extraction(prior_turns));
        prompt.push_str("\n\nEnd of recent Conversation.");
    }

    prompt.push_str(
        "\n\nRead the new Question below — in light of the recent Conversation above, if any \
         was given — and extract two things from it, if present:\n\
         1. A date range the Question refers to (e.g. \"last week\", \"yesterday\", \"this \
         summer\"), resolved against today's local date above — as local calendar dates, \
         inclusive of both ends. Null if the Question does not refer to any particular time.\n\
         2. A short topical keyword phrase suitable for a second, independent search of the \
         journal — e.g. Question \"how did the move go\" might extract \"moving flat\". Null if \
         the Question has no separable topic.\n\n\
         Respond with a single JSON object and nothing else — no prose, no markdown code fence, \
         no matter what the Conversation above discussed — in exactly this shape:\n\
         {\"date_range\": {\"from\": \"YYYY-MM-DD\", \"to\": \"YYYY-MM-DD\"} or null, \
         \"keyword\": \"...\" or null}",
    );

    prompt
}

/// Renders the windowed recent Conversation (`CONVERSATION_WINDOW`, already
/// applied by `run_reflect` before it reaches here) as plain `Q:`/`A:`
/// prose, oldest first, separated by a blank line between pairs — the
/// compact, non-role-bearing rendering `extraction_system_prompt` folds
/// into its own system-message content. See that function's doc comment for
/// why this is prose inside one message rather than real `user`/`assistant`
/// `ChatMessage` turns.
fn render_conversation_for_extraction(prior_turns: &[SessionTurnRow]) -> String {
    prior_turns
        .iter()
        .map(|turn| format!("Q: {}\nA: {}", turn.question, turn.answer))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Chat call 1 — asks the chat client to pull a date range and/or a
/// keyword out of the Question, for the fan-out in `run_reflect` to widen
/// retrieval with. `prior_turns` is the same `CONVERSATION_WINDOW`-capped
/// slice the answering call gets (`run_reflect` applies the cap once,
/// before either call), so a follow-up Question is extracted in the light
/// of what it follows rather than in isolation (issue #66) — see
/// `extraction_system_prompt` for how it's folded in. Never propagates an
/// error: any failure at all (the chat call itself erroring or timing out,
/// an unparseable or absent response) degrades to `Extraction::default()`,
/// logged at `warn`, so the Question still gets an Answer from
/// question-only retrieval — exactly ticket 4's behaviour, and `docs/adr/
/// 0023`'s floor: a step that exists to widen recall must never be able to
/// narrow it to zero.
///
/// The endpoint `ChatMessage`s are sent to accepts only `model`,
/// `messages`, `stream` (see `llm.rs`) — no `response_format`, no tools —
/// so this is prompt-and-parse, never structured-output mode.
async fn extract_date_range_and_keyword(
    reflect: &ReflectState,
    question: &str,
    offset_minutes: i32,
    prior_turns: &[SessionTurnRow],
) -> Extraction {
    match try_extract(reflect, question, offset_minutes, prior_turns).await {
        Ok(extraction) => extraction,
        Err(err) => {
            tracing::warn!(
                error = ?err,
                "extraction discarded; falling back to question-only retrieval"
            );
            Extraction::default()
        }
    }
}

async fn try_extract(
    reflect: &ReflectState,
    question: &str,
    offset_minutes: i32,
    prior_turns: &[SessionTurnRow],
) -> anyhow::Result<Extraction> {
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: extraction_system_prompt(local_today(offset_minutes), prior_turns),
        },
        ChatMessage {
            role: "user".to_string(),
            content: question.to_string(),
        },
    ];

    let raw = reflect
        .chat_client
        .chat(&messages)
        .await
        .context("extraction chat call failed")?
        .content;
    parse_extraction(&raw)
}

/// Parses the extraction chat call's raw response into an `Extraction`,
/// defensively: strips markdown code fences, takes the substring from the
/// first `{` to the last `}`, and parses that as JSON. `date_range` and
/// `keyword` are then read out of a loosely-typed `serde_json::Value`
/// rather than a strict struct, specifically so that a missing field, a
/// `null`, or a field of the wrong type degrades that one field to `None`
/// instead of failing the whole response — only "no JSON object could be
/// found at all" or "what was found doesn't parse as JSON" fail this
/// function, and even those are caught by `extract_date_range_and_keyword`
/// above rather than failing the Question.
fn parse_extraction(raw: &str) -> anyhow::Result<Extraction> {
    let candidate = strip_code_fences(raw);
    let json_str =
        extract_json_object(candidate).context("no JSON object found in extraction response")?;
    let value: Value =
        serde_json::from_str(json_str).context("extraction response was not valid JSON")?;

    let keyword = value
        .get("keyword")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let date_range = value.get("date_range").and_then(parse_date_range);

    Ok(Extraction {
        date_range,
        keyword,
    })
}

/// Parses `{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}` (or `null`) into a
/// validated `(from, to)` pair, or `None` on any defect: a `null` value, a
/// missing or non-string `from`/`to`, an unparseable date, or a
/// nonsensical range where `to < from`. A model that got the date order
/// wrong probably got the dates themselves wrong too, so the range is
/// dropped rather than swapped.
fn parse_date_range(value: &Value) -> Option<(NaiveDate, NaiveDate)> {
    if value.is_null() {
        return None;
    }
    let from = value.get("from")?.as_str()?;
    let to = value.get("to")?.as_str()?;
    let from = NaiveDate::parse_from_str(from, "%Y-%m-%d").ok()?;
    let to = NaiveDate::parse_from_str(to, "%Y-%m-%d").ok()?;
    if to < from {
        tracing::warn!(%from, %to, "extracted date range dropped: to is before from");
        return None;
    }
    Some((from, to))
}

/// Strips a leading/trailing ``` fence, with an optional language tag on
/// the opening line (e.g. "```json"). A no-op when there is no fence — most
/// defensive parsing here actually happens in `extract_json_object`, which
/// finds the outermost `{...}` regardless of what surrounds it, but a
/// fenced response is common enough from chat models that stripping it
/// explicitly first is worth the few lines.
///
/// `pub(crate)`, not private: `harness::prompted` reuses this verbatim for
/// a `<tool_call>` tag's interior, which the same configured model wraps
/// in exactly the same markdown noise. Reusing it (rather than a second
/// copy) is what keeps the two defensive-parsing behaviours from drifting
/// apart.
pub(crate) fn strip_code_fences(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let after_open = match after_open.find('\n') {
        Some(newline) => &after_open[newline + 1..],
        None => after_open,
    };
    after_open.strip_suffix("```").unwrap_or(after_open).trim()
}

/// The substring from the first `{` to the last `}`, or `None` if either is
/// missing or they're out of order. This is what makes parsing tolerant of
/// a model that wraps its JSON in a sentence ("Sure, here's the JSON:
/// {...}") even without a code fence around it.
///
/// `pub(crate)` for the same reason as `strip_code_fences` above:
/// `harness::prompted` reuses it for a `<tool_call>` tag's interior.
pub(crate) fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end < start {
        return None;
    }
    Some(&text[start..=end])
}

/// The characters treated as markdown noise around the verdict marker line
/// — asterisks/underscores for bold or italic, backticks for inline code,
/// `#` for a heading. A model that wraps "GROUNDED: no" in any of these
/// must still be recognised — see `parse_and_strip_verdict`.
const MARKER_NOISE_CHARS: [char; 4] = ['*', '_', '`', '#'];

/// Reads the "GROUNDED: yes"/"GROUNDED: no" verdict marker
/// (`SYSTEM_INSTRUCTION`) off the front of the answering chat call's raw
/// response, and returns the Answer with that marker line removed — the
/// marker must never reach the client: the Answer is persisted verbatim
/// (`sessions::record_turn`) and replayed into a follow-up Question's
/// prompt (`build_messages`'s `prior_turns`), so a leaked marker would
/// poison every later Turn in the Session.
///
/// Matches the *first non-empty* line, case-insensitively, after stripping
/// `MARKER_NOISE_CHARS` and surrounding whitespace — tolerant of a model
/// that wraps the marker in markdown (`**GROUNDED: no**`,
/// `` `GROUNDED: NO` ``, `# Grounded: Yes`) rather than sending the bare
/// line the prompt asked for.
///
/// Returns `(None, raw unchanged)` when that first non-empty line isn't a
/// recognised marker at all (missing entirely, or something else). This is
/// the *only* failure mode — unlike `parse_extraction`, there is no
/// "mostly parses, one field is bad" case here, since a verdict is a single
/// yes/no rather than a structured JSON object. `run_reflect` is what
/// decides what a `None` degrades to (grounded, by default) and why.
fn parse_and_strip_verdict(raw: &str) -> (Option<bool>, String) {
    let mut lines_consumed = 0usize;
    let mut marker_line: Option<&str> = None;
    for line in raw.lines() {
        lines_consumed += 1;
        if !line.trim().is_empty() {
            marker_line = Some(line);
            break;
        }
    }

    let Some(line) = marker_line else {
        return (None, raw.to_string());
    };

    let normalized: String = line
        .chars()
        .filter(|c| !MARKER_NOISE_CHARS.contains(c))
        .collect::<String>()
        .trim()
        .to_lowercase();

    let verdict = match normalized.as_str() {
        "grounded: yes" => Some(true),
        "grounded: no" => Some(false),
        _ => None,
    };

    let Some(verdict) = verdict else {
        return (None, raw.to_string());
    };

    let rest: String = raw
        .lines()
        .skip(lines_consumed)
        .collect::<Vec<_>>()
        .join("\n");
    (Some(verdict), rest.trim_start().to_string())
}

fn build_messages(
    system_instruction: &str,
    entries: &[GroundingEntry],
    prior_turns: &[SessionTurnRow],
    question: &str,
) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_instruction.to_string(),
    }];

    let grounding_block = if entries.is_empty() {
        "(No Entries were found.)".to_string()
    } else {
        entries
            .iter()
            .map(|entry| format!("[{}] {}", entry.created_at.format("%Y-%m-%d"), entry.body))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    messages.push(ChatMessage {
        role: "system".to_string(),
        content: format!("Grounding:\n{grounding_block}"),
    });

    for turn in prior_turns {
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: turn.question.clone(),
        });
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: turn.answer.clone(),
        });
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: question.to_string(),
    });

    messages
}

/// Derives a new Session's title from its first Question (CONTEXT.md: "a
/// title taken from its first Question"): the trimmed Question verbatim
/// when it's short enough, otherwise the longest word-boundary-respecting
/// prefix of at most `TITLE_MAX_CHARS` characters with a trailing "…" —
/// never a title that ends mid-word, and never one silently longer than the
/// limit without saying it was cut.
///
/// A Question with no word boundary at all inside the first
/// `TITLE_MAX_CHARS` characters (a single very long "word") falls back to a
/// hard cut at the limit — there is no boundary left to honour, and a title
/// that never truncates in that case would defeat the point of having a
/// limit. An empty or all-whitespace Question — not a real Question, but
/// not this function's job to reject — degrades to a fixed placeholder
/// rather than an empty title, since CONTEXT.md's Session entry has no
/// concept of a title-less Session to list.
fn derive_title(question: &str) -> String {
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return "Untitled Session".to_string();
    }
    if trimmed.chars().count() <= TITLE_MAX_CHARS {
        return trimmed.to_string();
    }

    let prefix: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();
    let cut = match prefix.rfind(' ') {
        Some(space_index) => prefix[..space_index].trim_end(),
        None => prefix.as_str(),
    };
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, NaiveDate, Utc};
    use sqlx::PgPool;
    use uuid::Uuid;

    use super::{
        NonEmptyAnswer, TITLE_MAX_CHARS, derive_title, extract_json_object, is_empty_final_reply,
        keyword_query, local_date_range_to_utc, local_today, parse_and_strip_verdict,
        parse_extraction, search_words, strip_code_fences,
    };

    #[test]
    fn a_date_range_and_keyword_are_parsed_from_clean_json() {
        let raw = r#"{"date_range": {"from": "2026-08-01", "to": "2026-08-07"}, "keyword": "moving flat"}"#;
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(
            extraction.date_range,
            Some((
                NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
            ))
        );
        assert_eq!(extraction.keyword.as_deref(), Some("moving flat"));
    }

    #[test]
    fn both_fields_null_parses_to_no_extraction() {
        let raw = r#"{"date_range": null, "keyword": null}"#;
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.date_range, None);
        assert_eq!(extraction.keyword, None);
    }

    #[test]
    fn a_markdown_code_fence_is_stripped() {
        let raw = "```json\n{\"date_range\": null, \"keyword\": \"wedding\"}\n```";
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.keyword.as_deref(), Some("wedding"));
    }

    #[test]
    fn surrounding_prose_around_the_json_object_is_ignored() {
        let raw =
            "Sure, here you go: {\"date_range\": null, \"keyword\": \"knee\"} — hope that helps!";
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.keyword.as_deref(), Some("knee"));
    }

    #[test]
    fn not_json_at_all_fails_to_parse() {
        assert!(parse_extraction("I'm not sure what you mean.").is_err());
    }

    #[test]
    fn a_reversed_range_is_dropped_but_the_keyword_survives() {
        let raw =
            r#"{"date_range": {"from": "2026-08-07", "to": "2026-08-01"}, "keyword": "wedding"}"#;
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.date_range, None);
        assert_eq!(extraction.keyword.as_deref(), Some("wedding"));
    }

    #[test]
    fn an_unparseable_date_drops_only_the_range() {
        let raw =
            r#"{"date_range": {"from": "not-a-date", "to": "2026-08-07"}, "keyword": "wedding"}"#;
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.date_range, None);
        assert_eq!(extraction.keyword.as_deref(), Some("wedding"));
    }

    #[test]
    fn wrong_field_types_degrade_to_none_instead_of_failing() {
        let raw = r#"{"date_range": "not an object", "keyword": 42}"#;
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.date_range, None);
        assert_eq!(extraction.keyword, None);
    }

    #[test]
    fn missing_fields_entirely_degrade_to_none() {
        let extraction = parse_extraction("{}").unwrap();
        assert_eq!(extraction.date_range, None);
        assert_eq!(extraction.keyword, None);
    }

    #[test]
    fn an_empty_keyword_string_is_treated_as_absent() {
        let raw = r#"{"date_range": null, "keyword": "   "}"#;
        let extraction = parse_extraction(raw).unwrap();
        assert_eq!(extraction.keyword, None);
    }

    #[test]
    fn extract_json_object_finds_the_outermost_braces() {
        assert_eq!(
            extract_json_object("prefix {\"a\": 1} suffix"),
            Some("{\"a\": 1}")
        );
        assert_eq!(extract_json_object("no braces here"), None);
        assert_eq!(extract_json_object("} { backwards"), None);
    }

    #[test]
    fn strip_code_fences_removes_a_language_tagged_fence() {
        assert_eq!(strip_code_fences("```json\n{\"a\": 1}\n```"), "{\"a\": 1}");
        assert_eq!(strip_code_fences("{\"a\": 1}"), "{\"a\": 1}");
    }

    /// The keyword search must embed the keyword wrapped as a question, not
    /// the bare word — see `keyword_query`'s doc comment for the measured
    /// recall gap this closes.
    #[test]
    fn keyword_query_wraps_the_keyword_as_a_question() {
        assert_eq!(keyword_query("wedding"), "What did I write about wedding?");
        assert_eq!(
            keyword_query("marathon training"),
            "What did I write about marathon training?"
        );
    }

    /// The boundary this ADR/ticket cares most about getting right: a
    /// single-day range (`from == to`) must cover the *whole* local day as
    /// a half-open UTC range, not just its first instant.
    #[test]
    fn a_single_day_local_range_becomes_a_full_day_half_open_utc_range() {
        let day = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();

        // At offset 0, local midnight is UTC midnight.
        let (from_utc, to_utc) = local_date_range_to_utc(day, day, 0);
        assert_eq!(from_utc.to_rfc3339(), "2026-08-15T00:00:00+00:00");
        assert_eq!(to_utc.to_rfc3339(), "2026-08-16T00:00:00+00:00");

        // At IST (+330 minutes), local midnight on the 15th is 18:30 UTC on
        // the 14th, and the range still covers exactly 24 local hours.
        let (from_utc_ist, to_utc_ist) = local_date_range_to_utc(day, day, 330);
        assert_eq!(from_utc_ist.to_rfc3339(), "2026-08-14T18:30:00+00:00");
        assert_eq!(to_utc_ist.to_rfc3339(), "2026-08-15T18:30:00+00:00");
    }

    #[test]
    fn a_multi_day_range_spans_from_the_first_days_start_to_the_last_days_end() {
        let from = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let (from_utc, to_utc) = local_date_range_to_utc(from, to, 0);
        assert_eq!(from_utc.to_rfc3339(), "2026-08-01T00:00:00+00:00");
        // Half-open: the instant just after the 7th's last local moment,
        // i.e. local midnight starting the 8th.
        assert_eq!(to_utc.to_rfc3339(), "2026-08-08T00:00:00+00:00");
    }

    #[test]
    fn local_today_shifts_with_the_offset_rather_than_using_the_servers_clock() {
        // Not asserting an exact date (that would make this test flaky
        // around a real clock's day boundary) — asserting the *relationship*
        // between two offsets is what actually exercises "the server never
        // guesses the timezone from its own clock."
        let utc_today = local_today(0);
        let far_east = local_today(MAX_OFFSET_MINUTES_FOR_TEST);
        // A 14-hour-east offset's local date is never earlier than UTC's.
        assert!(far_east >= utc_today);
    }

    const MAX_OFFSET_MINUTES_FOR_TEST: i32 = 840;

    // -------------------------------------------------------------------
    // Ticket 6 — parse_and_strip_verdict (docs/adr/0024)
    // -------------------------------------------------------------------

    #[test]
    fn a_clean_grounded_yes_marker_is_parsed_and_stripped() {
        let (verdict, answer) = parse_and_strip_verdict("GROUNDED: yes\nYour knee has improved.");
        assert_eq!(verdict, Some(true));
        assert_eq!(answer, "Your knee has improved.");
    }

    #[test]
    fn a_clean_grounded_no_marker_is_parsed_and_stripped() {
        let (verdict, answer) =
            parse_and_strip_verdict("GROUNDED: no\nI found nothing about that.");
        assert_eq!(verdict, Some(false));
        assert_eq!(answer, "I found nothing about that.");
    }

    #[test]
    fn markdown_bold_and_case_noise_around_the_marker_is_tolerated() {
        let (verdict, answer) = parse_and_strip_verdict("  **grounded: NO**  \n\nNothing found.");
        assert_eq!(verdict, Some(false));
        assert_eq!(answer, "Nothing found.");
    }

    #[test]
    fn a_backtick_and_heading_wrapped_marker_is_tolerated() {
        let (verdict, answer) = parse_and_strip_verdict("# `GROUNDED: YES`\nHere you go.");
        assert_eq!(verdict, Some(true));
        assert_eq!(answer, "Here you go.");
    }

    #[test]
    fn no_marker_at_all_leaves_the_answer_unchanged() {
        let raw = "Your knee has improved since February.";
        let (verdict, answer) = parse_and_strip_verdict(raw);
        assert_eq!(verdict, None);
        assert_eq!(answer, raw);
    }

    #[test]
    fn an_unrecognised_first_line_is_not_treated_as_a_marker() {
        let raw = "Sure, here's your answer:\nIt went well.";
        let (verdict, answer) = parse_and_strip_verdict(raw);
        assert_eq!(verdict, None);
        assert_eq!(answer, raw);
    }

    #[test]
    fn the_stripped_answer_never_contains_the_marker_string() {
        let (_, yes_answer) = parse_and_strip_verdict("GROUNDED: yes\nAll good here.");
        assert!(!yes_answer.contains("GROUNDED:"));
        let (_, no_answer) = parse_and_strip_verdict("**grounded: no**\nNothing found.");
        assert!(!no_answer.contains("GROUNDED:"));
    }

    // -------------------------------------------------------------------
    // Issue #102 — is_empty_final_reply / NonEmptyAnswer
    // -------------------------------------------------------------------

    #[test]
    fn a_genuinely_empty_reply_is_empty() {
        assert!(is_empty_final_reply(""));
    }

    #[test]
    fn a_whitespace_only_reply_is_empty() {
        assert!(is_empty_final_reply("   \n\t  \n"));
    }

    #[test]
    fn a_bare_code_fence_with_nothing_inside_it_is_empty() {
        assert!(is_empty_final_reply("```\n```"));
        assert!(is_empty_final_reply("```"));
        assert!(is_empty_final_reply("```json\n```"));
    }

    #[test]
    fn a_stray_closing_tool_call_tag_with_nothing_else_is_empty() {
        assert!(is_empty_final_reply("</tool_call>"));
    }

    #[test]
    fn a_bare_grounded_marker_with_nothing_after_it_is_empty() {
        assert!(is_empty_final_reply("GROUNDED: yes"));
        assert!(is_empty_final_reply("**grounded: no**"));
    }

    #[test]
    fn a_marker_followed_by_a_real_answer_is_not_empty() {
        // The fixed pipeline's own case (docs/adr/0024): a marker line is
        // scaffolding, but real prose after it is a real Answer, not
        // nothing to say.
        assert!(!is_empty_final_reply(
            "GROUNDED: no\nI found nothing about that."
        ));
    }

    #[test]
    fn ordinary_prose_is_not_empty() {
        assert!(!is_empty_final_reply("Nothing to report."));
        assert!(!is_empty_final_reply(
            "Your knee has improved since February."
        ));
    }

    /// The structural half of issue #102's acceptance criteria: the single
    /// constructor `run_reflect_loop` routes every model reply through
    /// before it can become `ReflectResponse::answer`/`NewTurn::answer`
    /// rejects every shape `is_empty_final_reply` recognises as nothing to
    /// say, and accepts everything else. There is no second path to a
    /// `NonEmptyAnswer` that skips this check.
    #[test]
    fn non_empty_answer_rejects_every_shape_of_nothing_to_say_and_accepts_real_text() {
        for empty in [
            "",
            "   \n  ",
            "```\n```",
            "</tool_call>",
            "GROUNDED: yes",
            "**grounded: no**",
        ] {
            assert!(
                NonEmptyAnswer::new(empty).is_none(),
                "expected {empty:?} to be rejected"
            );
        }

        let answer =
            NonEmptyAnswer::new("Your knee has improved.").expect("real prose must be accepted");
        assert_eq!(answer.into_inner(), "Your knee has improved.");
    }

    // -------------------------------------------------------------------
    // Ticket 8 — derive_title (docs/adr/0025)
    // -------------------------------------------------------------------

    #[test]
    fn a_short_question_is_used_as_the_title_unchanged() {
        assert_eq!(
            derive_title("How has my knee been?"),
            "How has my knee been?"
        );
    }

    #[test]
    fn a_long_question_is_truncated_on_a_word_boundary_with_an_ellipsis() {
        let question = "The quick brown fox jumps over the lazy dog while thinking about many other \
              things today";
        assert_eq!(
            derive_title(question),
            "The quick brown fox jumps over the lazy dog while thinking…"
        );
    }

    #[test]
    fn a_single_word_longer_than_the_limit_is_hard_cut() {
        let question = "a".repeat(100);
        let expected = format!("{}…", "a".repeat(TITLE_MAX_CHARS));
        assert_eq!(derive_title(&question), expected);
    }

    #[test]
    fn empty_or_whitespace_input_degrades_to_a_placeholder_title() {
        assert_eq!(derive_title(""), "Untitled Session");
        assert_eq!(derive_title("   \n\t  "), "Untitled Session");
    }

    // -------------------------------------------------------------------
    // Issue #94 (pass 2) — search_words's new OR rung, between the
    // existing AND (websearch_to_tsquery) and trigram (word_similarity)
    // rungs. See search_words's own doc comment for the measured numbers
    // motivating this rung; these tests exercise the same three-rung
    // ladder against a real Postgres connection.
    // -------------------------------------------------------------------

    async fn insert_entry(pool: &PgPool, body: &str, created_at: DateTime<Utc>) {
        sqlx::query(
            "insert into entries (id, device_id, body, created_at) values ($1, $2, $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(body)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
    }

    fn day(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
    }

    /// The AND→OR fall-through this rung exists for: no single Entry's body
    /// contains every one of the query's stems (`websearch_to_tsquery`
    /// therefore matches nothing, exactly the failure mode measured in
    /// `search_words`'s doc comment), but each Entry shares a distinct term
    /// with the query, and the OR rung finds both.
    #[sqlx::test]
    async fn an_and_only_query_that_matches_no_single_entry_still_matches_via_or(pool: PgPool) {
        insert_entry(&pool, "Knee physio was tough today.", day(2026, 3, 10)).await;
        insert_entry(
            &pool,
            "Finished reading a great novel last night.",
            day(2026, 3, 11),
        )
        .await;

        // "knee" and "reading" (stem "read") never co-occur in either
        // Entry, so rung 1's AND matches zero rows.
        let rows = search_words(&pool, "knee reading", 10).await.unwrap();

        assert_eq!(
            rows.len(),
            2,
            "the OR rung should have found both Entries via their distinct shared terms: {rows:?}"
        );
    }

    /// A query whose terms *do* all appear in one Entry must still be
    /// answered by rung 1 alone — the OR rung must not run at all, let
    /// alone displace AND. Proven here by a decoy Entry that would only
    /// match through OR (it shares just one of the two terms): if OR ran
    /// unconditionally, the decoy would leak into the result too.
    #[sqlx::test]
    async fn a_query_whose_terms_all_appear_in_one_entry_still_matches_via_and(pool: PgPool) {
        insert_entry(
            &pool,
            "My knee pain flared up again while I was reading in bed.",
            day(2026, 3, 10),
        )
        .await;
        insert_entry(
            &pool,
            "Reflecting quietly on my knee brace fitting today.",
            day(2026, 3, 11),
        )
        .await;

        let rows = search_words(&pool, "knee reading", 10).await.unwrap();

        assert_eq!(
            rows.len(),
            1,
            "only the Entry matching both terms conjunctively should come back — the OR-only \
             decoy leaking in would mean OR ran even though AND already matched: {rows:?}"
        );
        assert!(rows[0].body.contains("flared up"));
    }

    /// Within the OR rung itself: an Entry matching more of the query's
    /// terms must outrank an Entry matching only one, because `ts_rank_cd`
    /// (not mere presence in the OR'd set) is what orders the rows.
    #[sqlx::test]
    async fn within_the_or_rung_more_matching_terms_ranks_higher(pool: PgPool) {
        insert_entry(
            &pool,
            "Just a quiet day, nothing much to report about the knee.",
            day(2026, 3, 10),
        )
        .await;
        insert_entry(
            &pool,
            "The knee doctor mentioned running gently is fine for recovery.",
            day(2026, 3, 11),
        )
        .await;

        // No Entry contains all three stems ("knee", "run", "read"), so
        // this falls through AND into the OR rung; the second Entry shares
        // two of the three query terms ("knee" and "running"), the first
        // only one ("knee").
        let rows = search_words(&pool, "knee running reading", 10)
            .await
            .unwrap();

        assert_eq!(
            rows.len(),
            2,
            "both Entries share at least one term: {rows:?}"
        );
        assert!(
            rows[0].body.contains("running gently"),
            "the two-term match should rank above the one-term match: {rows:?}"
        );
    }

    /// A query that reduces to zero lexemes — punctuation only — must not
    /// raise a SQL error from `to_tsquery('english', '')` in the OR rung;
    /// it should simply match no rows and fall through to rung 3, which a
    /// zero-lexeme query cannot reach either (see the stop-words test
    /// below for why rung 3 needs its own guard, not just an empty
    /// tsquery, to stay out of this case).
    #[sqlx::test]
    async fn a_punctuation_only_query_returns_no_rows_without_erroring(pool: PgPool) {
        insert_entry(
            &pool,
            "Uneventful evening, tea and a book.",
            day(2026, 3, 10),
        )
        .await;

        let rows = search_words(&pool, "!!! ??? ...", 10).await.unwrap();

        assert!(
            rows.is_empty(),
            "a punctuation-only query should match nothing, not error: {rows:?}"
        );
    }

    /// The regression this ticket's second pass exists to close: a
    /// stop-words-only query reduces to zero lexemes just like the
    /// punctuation case above, but `to_tsvector`/`to_tsquery` emptiness
    /// doesn't save rung 3 the way it saves rungs 1 and 2 — rung 3's
    /// `word_similarity` predicate has nothing to do with `body_tsv` or
    /// lexemes at all, it compares raw trigrams. Before rung 3 gained its
    /// own `to_tsvector('english', $1) != ''::tsvector` guard, this exact
    /// query matched ordinary prose Entries at up to 0.727 similarity —
    /// comfortably over `TRIGRAM_MATCH_THRESHOLD` (0.3) — purely because
    /// "the", "of" and "and" are common substrings of common English
    /// sentences, not because the Entry had anything to do with the query.
    /// The Entry body here is deliberately unremarkable prose containing
    /// "and" (one of the query's own words) as a check that the guard, not
    /// some coincidental low similarity score, is what keeps this empty.
    #[sqlx::test]
    async fn a_stop_word_only_query_returns_no_rows_without_erroring(pool: PgPool) {
        insert_entry(
            &pool,
            "Uneventful evening, tea and a book.",
            day(2026, 3, 10),
        )
        .await;

        let rows = search_words(&pool, "the of and", 10).await.unwrap();

        assert!(
            rows.is_empty(),
            "a stop-words-only query has no word to have mistyped, so trigram similarity to              ordinary prose must not count as a match: {rows:?}"
        );
    }

    /// A genuine misspelling — no stem shared with the body in any
    /// combination — must still reach rung 3 and match via trigram
    /// similarity, exactly as it did before this rung was added.
    #[sqlx::test]
    async fn a_misspelling_with_no_shared_stem_still_reaches_the_trigram_rung(pool: PgPool) {
        insert_entry(
            &pool,
            "First physio appointment today, went well.",
            day(2026, 3, 10),
        )
        .await;

        let rows = search_words(&pool, "phyiso", 10).await.unwrap();

        assert_eq!(
            rows.len(),
            1,
            "the trigram fallback should have matched \"phyiso\" against \"physio\": {rows:?}"
        );
        assert!(rows[0].body.contains("physio appointment"));
    }
}
