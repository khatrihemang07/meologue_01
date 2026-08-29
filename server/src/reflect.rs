//! `POST /v1/reflect` — a Question is answered by `harness::agent_loop`, a
//! tool-calling loop that decides for itself how many times to look before
//! it answers, and how, from four tools (`harness::tools`:
//! `EntriesInRangeTool`, `SearchEntriesTool`, `SimilarEntriesTool`,
//! `ReadDigestTool`). `reflect_handler` resolves the Session synchronously
//! (`resolve_session`) and then spawns `run_reflect_stream`, which runs
//! `run_reflect_stream_inner` — the loop itself — reporting every step onto
//! a `text/event-stream` as it happens, live, rather than only once the
//! whole Question is answered (issue #96).
//!
//! This replaced a different thing: a *fixed* pipeline (tickets 4 through 8,
//! issue #93 pass 1 and earlier) that got exactly one look — an extraction
//! chat call found a date range and/or a keyword hiding in the Question,
//! three retrievals ran concurrently, the results were merged, deduped,
//! capped and reordered, and a second chat call turned them into an Answer,
//! judging its own Grounding via a "GROUNDED: yes/no" marker it was
//! instructed to prefix its reply with, and falling back to a disclosed
//! "here's what you've written lately" when it judged that Grounding didn't
//! answer the Question. That pipeline (`run_reflect`, and everything only it
//! called — the extraction call, the marker parser, the disclosed fallback)
//! is gone: issue #93 pass 2 stopped calling it, kept it working and tested
//! behind `#[allow(dead_code)]` because removing it was explicitly this
//! ticket's job, and issue #99 is that ticket. Each piece existed to
//! compensate for a shape that could only look once; a loop that keeps
//! looking until it's satisfied has no job left for any of them.
//!
//! The Server holds the Conversation now (`docs/adr/0025`), superseding ADR
//! 0020's "a Conversation ... belongs to the Device it happened on and does
//! not Sync." A request names the Session it belongs to with `session_id`
//! — `None` starts a new one — instead of round-tripping every prior
//! Question and Answer on every call. `resolve_session` loads that
//! Session's Turns (`sessions::load_turns`, which reads a Session's entry
//! tree — the only representation a Session has, since issue #99 removed
//! the older `session_turns` table `sessions.rs`'s own doc comment
//! describes) before asking, and `run_reflect_stream_inner` persists the
//! new Turn (`sessions::record_turn_from_steps`) only once an Answer has
//! actually succeeded, so a failed ask never leaves an orphaned Turn
//! behind. Issue #108 narrows what was once a stronger claim here — "leaves
//! neither a Session nor a Turn behind" — because `resolve_session` now
//! mints a Session's own row up front, before the run it belongs to even
//! starts (`resolve_session`'s own doc comment covers why: the operation
//! log needs a real `session_id` to key its first record against). A
//! failed first Question can now leave a real, entry-less Session row
//! behind; `docs/adr/0025`'s actual guarantee — no client ever sees a
//! Session holding an empty Conversation — is kept by `sessions::list_sessions`
//! instead of by never creating the row.
//!
//! See CONTEXT.md's Grounding entry for the rule this route exists to
//! honour: an Answer with nothing behind it says so, rather than inventing
//! a past the user didn't live. The loop's own system prompt
//! (`LOOP_SYSTEM_INSTRUCTION`) says this directly. There is no verdict
//! marker enforcing it any more, and no `grounded`/`fallback_used` on the
//! wire either (issue #99) — whether an Answer was "grounded" was a verdict
//! the Server extracted from the model's own words for a pipeline that only
//! ever got one look; the loop stops when it is satisfied rather than being
//! handed a fixed pile of Entries and asked to grade it, which makes that
//! verdict meaningless rather than merely obsolete. `grounding_entry_ids` is
//! what survives: not a merged, ranked list computed in advance, simply the
//! Entry ids whichever tools this run called happened to return.

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::embedding::vector_literal;
use crate::harness::agent_loop::{self, LoopEvent, Step};
use crate::harness::compaction;
use crate::harness::prompted::PromptedToolClient;
use crate::harness::run_log::RunLog;
use crate::harness::tools::{
    self, AgentTool, EntriesInRangeTool, ReadDigestTool, SearchEntriesTool, SimilarEntriesTool,
};
use crate::harness::types::{AssistantMessage, ContentBlock, Message, StopReason};
use crate::llm::{ChatMessage, LlmClient};
use crate::sessions::{
    self, EntryType, MessagePayload, ModelChangePayload, RecordKind, SessionTurnRow,
};
use crate::sync::PROTOCOL_VERSION;

/// One SSE frame, already built and ready to send — what every branch of
/// `reflect_handler`'s streamed half funnels through. `Infallible`, not a
/// real error type: `chat::ChatClient`'s own never-`Err` contract means
/// nothing downstream of a chat call ever needs to fail *the stream itself*
/// (a failed Question still ends the stream cleanly, via an `agent_end`
/// event carrying `"status": "error"` — see `run_reflect_stream`), so
/// there is no second variant this channel's `Result` ever needs to carry.
/// `axum::response::sse::Sse` requires exactly this shape
/// (`TryStream<Ok = Event>`) of whatever `Stream` it wraps.
type SseSender = mpsc::UnboundedSender<Result<Event, Infallible>>;

/// How many nearest Entries retrieval pulls before handing them to whatever
/// asked for them, mirroring the shape `docs/adr/0022` already settled for
/// writes: bind the vector as a formatted `::vector` string, no `pgvector`
/// crate. 40 is generous for a personal-scale History — the chat call, not
/// this query, is what should decide whether an Entry was actually
/// relevant. Shared by `SimilarEntriesTool`, `SearchEntriesTool` and
/// `EntriesInRangeTool` (`harness::tools`) as their own tool-call default,
/// and by `retrieve_nearest`/`retrieve_range`/`search_words` below.
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
/// the model's own judgment of what it's given — via whichever tool call
/// surfaced it — is what decides whether any of them answer the Question.
/// See `docs/adr/0023` for the full amendment.
pub const RETRIEVAL_LIMIT: i64 = 40;

/// Minutes east of UTC, clamped to the real-world extreme (±14h) before
/// `run_reflect_stream_inner` and its tools use it for anything — see
/// `ReflectRequest::utc_offset_minutes`.
const MIN_UTC_OFFSET_MINUTES: i32 = -840;
const MAX_UTC_OFFSET_MINUTES: i32 = 840;

/// How many of a Session's most recent Turns `run_reflect_stream_inner`
/// replays into the loop's own `Context` on every Question.
/// `docs/adr/0025`'s Consequences section names exactly the problem this
/// bounds: a Session is durable now and can be returned to over weeks, so
/// replaying *every* prior Turn on every Question grows both latency and
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
/// a Session has. The cap is applied here to whatever `load_turns` returns,
/// deliberately not pushed into the SQL: it's a property of what the model
/// is asked to read, not of what the Session contains. Issue #97's
/// token-aware compaction (`maybe_compact_prior_turns`) sits underneath
/// this same cap and can trim a Session's replayed history well before ten
/// Turns ever accumulate.
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
    /// separate create endpoint. `resolve_session` loads that Session's
    /// prior Turns (`sessions::load_turns`) to read this Question "in the
    /// light of the Conversation before it" (CONTEXT.md's own phrase for
    /// what a Conversation is) — the server holds that Conversation now, so
    /// this replaces what used to round-trip on every request as
    /// `prior_turns`. A `Some` naming a Session that doesn't exist is a 404,
    /// not a silently-ignored value.
    #[serde(default)]
    pub session_id: Option<Uuid>,
    /// Minutes east of UTC for the asking Device, right now — the same sign
    /// convention `apps/web/src/lib/entry-day.ts::deviceUtcOffsetMinutes`
    /// and ADR 0016's `toLocalParts` already use for Export's day grouping.
    /// `EntriesInRangeTool` and `SearchEntriesTool` (`harness::tools`) both
    /// take this to resolve a date phrase the model names in a tool call
    /// — "last week," "in March" — against the user's own local day, never
    /// the server's clock.
    ///
    /// `#[serde(default)]` rather than required, independent of whatever
    /// `PROTOCOL_VERSION` happens to be: a mismatched `protocol_version`
    /// already rejects a stale Device outright (`reflect_handler`, 426), so
    /// this field's own default exists to keep a *current* Device's request
    /// well-formed even if some future caller ever omits it, not to soften
    /// a version bump. Falling back to `0` (UTC) rather than rejecting the
    /// request is a graceful degrade either way: date phrases resolve
    /// against UTC instead of the asking Device's own local day, not a
    /// rejected Question.
    #[serde(default)]
    pub utc_offset_minutes: i32,
    /// Issue #98: the model this Question should run on, or `None` to mean
    /// "whatever this Conversation is already on" — the Server's own
    /// configured default (`ReflectState::chat_model`) for a brand-new
    /// Session, or the model its own last Turn already recorded otherwise.
    /// **Choosing nothing is not the same as choosing the default on every
    /// request** — a Conversation that moved onto `claude-sonnet` keeps
    /// asking on `claude-sonnet` until a client names a different model
    /// again, it does not silently fall back the moment a request omits
    /// this field. `run_reflect_stream_inner`'s own call to `resolve_model`
    /// is where that resolution actually happens; a `Some` naming a model
    /// this Server can no longer reach is not rejected here — see this
    /// module's own doc comment on what happens instead.
    #[serde(default)]
    pub model: Option<String>,
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
    /// order they first appeared — `run_reflect_stream_inner`'s own dedup,
    /// over every `harness::agent_loop::Step::ToolResult` the loop
    /// produced. Never a merged, ranked list computed in advance (issue
    /// #99 removed the pipeline that used to build one) — simply the Entry
    /// ids the tools this run called happened to return. Empty when the
    /// loop never called a tool at all — a prose-only reply is not unusual,
    /// and carries no Grounding by construction, not by omission.
    pub grounding_entry_ids: Vec<Uuid>,
    /// Whether this run called a tool at all — `true` the moment any
    /// `harness::agent_loop::Step::ToolResult` appears in `outcome.steps`,
    /// regardless of whether that call (or any other) found anything.
    /// Issue #103's own acceptance criterion: an empty `grounding_entry_ids`
    /// alone cannot tell a client, or a person reading a log, which of two
    /// very different runs actually happened — one that called
    /// `search_entries` and it came back empty, or one that never called
    /// anything and wrote a reply anyway (the bug this issue was filed
    /// against: the model answered "I can't access any journal entries from
    /// here" having tried nothing). Both reach this struct with an
    /// identical `grounding_entry_ids: []`, and both used to render
    /// identically to the user ("Nothing in your History matched this
    /// Question") for exactly that reason. This field is what lets that
    /// distinction survive past `run_reflect_stream_inner` — both server-
    /// side (the `tracing::warn!` below) and on the wire, where the client
    /// renders it as a distinct "never looked" outcome
    /// (`apps/web/src/lib/conversation.ts`'s `groundingOutcome`).
    pub tool_called: bool,
    /// Issue #98: the model this Turn actually ran on — `resolve_model`'s
    /// own `resolved_model_id`, echoed back so a client can attribute the
    /// Answer it just watched arrive without a second round trip to
    /// `GET /v1/sessions/{id}` (which would carry the same value, via
    /// `SessionTurnRow::model`, but only after the tree write this
    /// response is itself the result of has already committed).
    pub model: String,
    /// Issue #105: the same field as `sessions::SessionTurnRow::digest_source`,
    /// computed the same way — `sessions::DigestSourceTracker` folded over
    /// this run's own `grounded_steps` (the `..=answer_step_index` bound
    /// issue #106 already scopes Grounding to) — and put directly on this
    /// struct rather than left for the client to derive on its own from
    /// `tool_execution_end` events. Flattened onto `agent_end` the same way
    /// every other field here already is (`run_reflect_stream`'s own doc
    /// comment), which is what makes this reach the client with no new
    /// plumbing: the live path and a page reload's `GET /v1/sessions/{id}`
    /// now read from the identical computation, just at different times.
    pub digest_source: Option<sessions::DigestSourcePayload>,
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

/// Reflection's server-side dependencies, held in `AppState` only when chat
/// is configured (`llm::LlmConfig::reflect_config`) — see `lib.rs` for why
/// that's what decides whether `/v1/reflect` is registered at all.
#[derive(Clone)]
pub struct ReflectState {
    pub chat_client: Arc<dyn LlmClient + Send + Sync>,
    /// Issue #130: `None` when `MEOLOGUE_EMBED_MODEL` is unset —
    /// `reflect_config`'s own doc comment covers why that no longer means
    /// Reflection itself is off. When this is `None`, the tool-set
    /// construction below simply leaves `SimilarEntriesTool` out of the
    /// `Vec` offered to the model for the request; the other three tools
    /// need no embedding client at all.
    pub embed_client: Option<Arc<dyn LlmClient + Send + Sync>>,
    /// Issue #97: how much room the configured chat model has, read once at
    /// startup from its `GET /v1/models/{id}` entry
    /// (`llm::resolve_context_window`) — never `harness::compaction`'s
    /// `DEFAULT_CONTEXT_WINDOW` fallback constant directly, so a test can
    /// see exactly what a Session's `run_reflect_stream_inner` will treat as the
    /// trigger threshold without needing a live wrapper to ask.
    pub context_window: u32,
    /// Issue #96: the configured wrapper's own base URL and API key, kept
    /// alongside `chat_client`/`embed_client` rather than folded into
    /// either. `GET /v1/models` (`models::models_handler`) needs the raw
    /// HTTP endpoint itself (`llm::list_models`) — `llm::LlmClient` has no
    /// "list what's available" method, and shouldn't grow one just for
    /// this: that trait exists to abstract chatting and embedding, the two
    /// things every implementation (including every test double in this
    /// crate) already has to support, and a fifth method only one caller
    /// needs would widen that contract for no benefit to the other four.
    pub chat_base_url: String,
    pub chat_api_key: Option<String>,
    /// Issue #98: the model id `chat_client`/`context_window` above are
    /// already bound to — `LlmConfig::chat_model`, unwrapped once at
    /// startup the same way `chat_base_url` already is (`main.rs`). This is
    /// "choosing nothing" — the default this ticket's own acceptance
    /// criterion says must not change. `resolve_model` (this module)
    /// compares a request's own `ReflectRequest::model` against this field
    /// to decide whether a Turn can reuse `chat_client`/`context_window`/
    /// `chat_streaming` as-is or has to resolve a different model instead.
    pub chat_model: String,
    /// Issue #98: whether `chat_model` itself streams — read once at
    /// startup from the same `GET /v1/models` list `chat_base_url` proxies
    /// (`main.rs`), exactly like `context_window` is resolved once from
    /// the single-model form of that same call. Any *other* model's
    /// streaming support is looked up live, per Turn, through
    /// `chat_client.list_models()` (`resolve_model`) — only the default
    /// gets this startup-time shortcut, which is what keeps a Question
    /// asked with no `model` making zero extra network calls, exactly as
    /// it did before this ticket.
    pub chat_streaming: bool,
}

/// The two ways `resolve_session` (issue #96's own synchronous preflight,
/// run before `reflect_handler` ever commits to a 200 and starts streaming)
/// can end other than success. `SessionNotFound` is the one case that must
/// reach the client as a clean 404 rather than the catch-all 500 every
/// other failure gets — see `ReflectRequest::session_id`. `From<anyhow::Error>`
/// is what lets every existing `?` on an `anyhow::Result` inside it keep
/// working unchanged: it's the conversion Rust's `?` reaches for
/// automatically. `run_reflect_stream_inner`, by contrast, returns a plain
/// `anyhow::Result` — once session resolution has already happened, nothing
/// left inside the streamed run can turn into a distinct HTTP status (the
/// headers already went out as 200), so there is no reason for it to carry
/// this extra variant.
enum ReflectError {
    SessionNotFound,
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for ReflectError {
    fn from(err: anyhow::Error) -> Self {
        ReflectError::Internal(err)
    }
}

/// Issue #96: `/v1/reflect` answers over `text/event-stream` now, not a
/// single JSON body — pi's own event vocabulary (`step_start`,
/// `tool_execution_start`, `tool_execution_end`, `message_start`,
/// `message_update`, `message_end`, `agent_end`), emitted as
/// `harness::agent_loop::run_with_events` actually makes progress, so the
/// client can render "searching ... -> N Entries" while it happens instead
/// of a single "searching" spinner for however long the whole Question
/// takes. `utoipa` has no first-class way to describe a stream of
/// differently-shaped named SSE frames as one response `body`, so this is
/// documented as `text/event-stream` with no schema — `openapi.rs` still
/// registers every event payload's own Rust type (`MessageEndEventData`,
/// `ToolExecutionStartEventData`, `ToolExecutionEndEventData`,
/// `ReflectAgentEndEventData`) under `components.schemas` so a client
/// generating types from `packages/core/src/generated/wire.ts` still gets
/// them, even though nothing here can point utoipa at "frame N of this
/// stream has this shape."
///
/// The three status codes that predate this ticket keep meaning exactly
/// what they did — 404 (Reflection unconfigured, or a `session_id` naming
/// no Session) and 426 (a stale `protocol_version`) are still real HTTP
/// statuses, not folded into the event stream, because both are decided
/// *before* this handler commits to a 200 and starts streaming (see
/// `resolve_session`, called synchronously below): once the stream opens,
/// the status line has already gone out, so nothing after that point can
/// change it. A failure *inside* the streamed run — the chat endpoint
/// erroring, the loop never producing an Answer — cannot become a 500 for
/// the same reason; it ends the stream instead, via an `agent_end` event
/// carrying `"status": "error"` (`run_reflect_stream`) rather than hanging
/// or dropping the connection silently.
#[utoipa::path(
    post,
    path = "/v1/reflect",
    request_body = ReflectRequest,
    responses(
        (status = 200, description = "A stream of pi-vocabulary SSE events, ending in \
            agent_end — see this handler's own doc comment", content_type = "text/event-stream", body = String),
        (status = 404, description = "Reflection is unconfigured, or session_id names a Session \
            that does not exist"),
        (status = 426, description = "protocol_version is not one this server understands"),
    )
)]
pub async fn reflect_handler(
    State(pool): State<PgPool>,
    State(reflect): State<Option<ReflectState>>,
    Json(req): Json<ReflectRequest>,
) -> Response {
    if req.protocol_version != PROTOCOL_VERSION {
        return StatusCode::UPGRADE_REQUIRED.into_response();
    }

    // Only reachable if this state's absence somehow slipped past the
    // conditional route registration in `lib.rs` — that registration is the
    // actual gate; this is a defensive fallback, not the mechanism a client
    // is meant to observe as "Reflection isn't configured."
    let Some(reflect) = reflect else {
        tracing::error!(
            "reflect_handler invoked with no ReflectState — route should not be registered"
        );
        return StatusCode::NOT_FOUND.into_response();
    };

    // Resolved synchronously, before any SSE frame is ever sent — this is
    // what keeps `session_id` naming no Session a genuine 404 rather than a
    // stream that opens and then has to explain the same failure through an
    // event instead (this function's own doc comment covers why that
    // distinction matters: once headers go out, the status can't change).
    //
    // Issue #108: `resolve_session` now always returns a real `session_id`
    // — minted up front (`sessions::create_session`) for a request naming
    // no existing Session, rather than left for `record_turn_from_steps` to
    // mint only once a Turn succeeds. This is what gives the operation log
    // something to key its very first record against before the run it
    // describes even starts — see `resolve_session`'s own doc comment.
    let (session_id, prior_turns, title) =
        match resolve_session(&pool, req.session_id, &req.question, &reflect.chat_model).await {
            Ok(resolved) => resolved,
            Err(ReflectError::SessionNotFound) => return StatusCode::NOT_FOUND.into_response(),
            Err(ReflectError::Internal(err)) => {
                tracing::error!(error = ?err, "reflect failed while resolving the Session");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };

    // Unbounded: every sender here (`run_reflect_stream`'s own event sink,
    // plus its final `agent_end`) is synchronous and never awaits back-
    // pressure from this channel — the same reasoning `chat::StreamEvent`'s
    // own `mpsc::unbounded_channel` already relies on. A Question generates
    // at most a few dozen frames even for a many-tool-call run, so nothing
    // about "unbounded" risks unbounded memory in practice.
    let (tx, rx) = mpsc::unbounded_channel::<Result<Event, Infallible>>();
    tokio::spawn(run_reflect_stream(
        pool,
        reflect,
        req,
        session_id,
        prior_turns,
        title,
        tx,
    ));

    Sse::new(UnboundedReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// The one thing `reflect_handler` must decide *before* it can commit to a
/// 200 and start streaming: which Session this Question belongs to (or that
/// it names one that doesn't exist, `ReflectError::SessionNotFound`), what
/// title to answer under, and — issue #108 — a real `session_id` the whole
/// run can carry from its very first moment. Split out of what used to be
/// `run_reflect_loop`'s own opening lines for exactly that reason — this
/// runs synchronously in the handler; everything after it runs inside the
/// spawned, streaming `run_reflect_stream`.
///
/// **Issue #108: this is where a Session's `sessions` row is now created**
/// for a request naming no existing Session (`session_id: None`) —
/// `sessions::create_session`, called here rather than left for
/// `sessions::record_turn_from_steps` to mint only once a Turn has actually
/// succeeded, the way it worked before this ticket. The reason is the
/// operation log: `harness::run_log::RunLog`'s very first record for this
/// run (`operation_started`, written by `run_reflect_stream` just below)
/// needs a real `session_id` to key against — `session_records.session_id
/// references sessions(id)` — and that has to exist before the run starts,
/// not only once it succeeds. This runs synchronously in the handler and
/// can fail as a clean 500 like everything else here, so a database error
/// minting the row is no different from any other failure this function
/// already surfaces.
async fn resolve_session(
    pool: &PgPool,
    session_id: Option<Uuid>,
    question: &str,
    default_model: &str,
) -> Result<(Uuid, Vec<SessionTurnRow>, String), ReflectError> {
    match session_id {
        Some(id) => {
            let session = sessions::find_session(pool, id)
                .await?
                .ok_or(ReflectError::SessionNotFound)?;
            let turns = sessions::load_turns(pool, id, default_model).await?;
            Ok((id, turns, session.title))
        }
        None => {
            let title = derive_title(question);
            let id = sessions::create_session(pool, &title).await?;
            Ok((id, Vec::new(), title))
        }
    }
}

/// The loop's own persona instruction (issue #93 pass 2) — `reflect.rs`'s
/// live entry point now, via `run_reflect_stream_inner`.
///
/// `harness::tools::render_tool_guidance` appends every active tool's own
/// `snippet`/`guidelines` after this before it's sent as
/// `harness::types::Context::system_prompt` — see that function's doc
/// comment for why the *tool set*, not this constant, owns describing what
/// each tool does.
///
/// Deliberately carries no "GROUNDED: yes/no" verdict instruction — that
/// judgment, and the disclosed fallback it drove, belonged to the fixed
/// pipeline issue #99 removed (this module's own doc comment), which had no
/// equivalent for the loop to inherit.
///
/// **Issue #103: says outright that the tools are the *only* way to see the
/// journal, and forbids claiming otherwise.** The version before this ticket
/// only ever said "you have tools to look things up... before you answer" —
/// true, but never ruling out the reading a general-purpose chat model
/// already carries into every conversation, that it has no real access to
/// anything outside the message it's replying to. Observed live: asked "how
/// is my knee doing" against a Sandbox corpus where `search_entries(query:
/// "knee")` returns 16 real Entries, the model answered "I can't access any
/// journal entries from here" — a confident, well-formed sentence, and
/// wrong, having called no tool at all. That is CONTEXT.md's don't-invent
/// rule failing in the direction this prompt never addressed: the old text
/// warned against inventing a past ("a Reflection that invents a past the
/// user did not live"), which stops the model from making up Entries, but
/// said nothing that would stop it from making up the *absence* of a
/// connection to any Entries at all. Two clauses close that gap: the tools
/// are named as the only access this model has (not "a way to help
/// answer" but the literal only way it can see anything), and the "if
/// nothing in the journal answers" exit is now conditioned on having
/// actually looked — a Question can be declared unanswerable only after a
/// tool was tried, never as a first move.
///
/// **Not fixed by reordering.** ADR 0026 established that a trailing
/// instruction can be pushed out of a growing prompt and stop being read;
/// `harness::prompted::PROTOCOL_INSTRUCTION` already applies that ordering
/// to this same system message (it is appended last, after the `<tools>`
/// block — see `harness::prompted::render_system_prompt`'s own doc
/// comment). This constant's own position was checked too: it is folded
/// into `harness::types::Context::system_prompt`, which
/// `harness::prompted::PromptedToolClient::stream` always sends as message
/// index 0, *before* every replayed prior Turn and the live Question — the
/// opposite end from where ADR 0026's risk lives, so a long Conversation
/// (or issue #97's compaction summary, itself just another message in that
/// same replayed sequence) cannot push this text away from the point of
/// generation the way a trailing instruction could. And the live failure
/// this issue was filed against cannot be an ordering problem regardless:
/// it was reported as the first Question of its Conversation, where the
/// wire array the model actually saw was exactly two messages long
/// (`[system, user]`) — there is no growth for anything to be pushed away
/// from. The gap was in what the instruction said, not where it sat.
const LOOP_SYSTEM_INSTRUCTION: &str = "You are Reflection, part of meologue, a personal journal. \
A user is asking a Question about their own journal Entries. The tools described below are the \
only way you can see any of it — you carry no memory of this user's journal and have no access to \
it except by calling one, so never tell the user you can't access, see, or search their journal: \
that claim is never true on this Server, and until you have actually called a tool you do not yet \
know whether it holds an answer. Call a tool whenever you need to see actual Entries to answer \
accurately, and call it again if what came back isn't enough — narrowing, widening, or looking at \
a different stretch of time as needed. When you have enough to answer — or once you have looked \
and the journal genuinely has nothing that answers the Question — reply in plain prose with no \
further tool call: that reply is shown to the user exactly as written, so only write it once you \
are done gathering what you need. If the journal doesn't contain enough to answer, say so plainly \
instead of guessing or inventing anything — a Reflection that invents a past the user did not live \
is worse than one that admits it found nothing, but admitting nothing was found is only honest \
after you have actually looked. Speak directly to the user in the second person, in plain prose.";

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
/// `run_reflect_stream_inner` only ever sends this once. Unlike `agent_loop::run`'s
/// own "no step budget" (deliberate, per that module's doc comment, for a
/// Question that genuinely needs several tool calls), an empty reply isn't
/// evidence the Question needs more looking; it's evidence the model wrote
/// nothing on a turn where it was free to write anything. Telling it so
/// once is a reasonable accommodation for whatever intermittent cause
/// issue #102 observed (never reproduced on demand, and not chased here);
/// telling it forever would turn a single bad turn into an unbounded loop
/// with no evidence a third or fourth attempt would behave any
/// differently, so a second empty reply fails the request instead
/// (`run_reflect_stream_inner`).
const EMPTY_REPLY_CORRECTION: &str = "Your last reply had no text in it — nothing was written, and \
no tool was called either. Look again at the Question above: either call a tool to look something \
up, or write your Answer to the user in plain prose. Do not send an empty reply again.";

/// Issue #103's own corrective turn — round 2. The first version of this
/// gated on `claims_no_journal_access`, a keyword match over the reply's
/// wording; live verification kept finding new phrasings the list hadn't
/// seen yet ("I'm unable to tell from the information available here" was
/// the one that survived a widened list entirely untouched), which is
/// exactly the failure mode a phrase list always has against open-ended
/// prose. This version drops wording from the trigger and fires on the
/// structural fact `tool_called` already exists to name: the run produced
/// an Answer and never called a tool. That's phrase-independent — no
/// wording can dodge it — and it's exactly the condition the acceptance
/// criterion cares about (a run that never looked), not a proxy for it.
///
/// Because the trigger no longer knows *why* the model didn't call a tool,
/// this message can't assert it denied access — sometimes it will be a
/// perfectly good prose-only reply (a follow-up answerable from the
/// Conversation already in context, "no tools needed for that"), and
/// accusing the model of something it didn't do is its own failure mode.
/// So it states the fact, names what the tools are for, and gives a
/// legitimate way to stand by an answer that never needed one.
const NO_TOOL_CALL_CORRECTION: &str = "Your last reply answered without calling any tool. If this \
Question is about the user's journal, the tools described in your instructions are the only way \
you can see it — call one now before answering again. If your last answer genuinely didn't need \
the journal, you may give the same answer again.";

/// No longer the corrective-turn trigger (see `NO_TOOL_CALL_CORRECTION`'s
/// own doc comment for why a keyword match over free-form prose stopped
/// being load-bearing for behaviour) — kept as **observability only**: it
/// still tags `tracing::warn!` output near the end of
/// `run_reflect_stream_inner` so the specific "denied access" shape stays
/// greppable in logs and distinguishable from an ordinary no-tool-call
/// reply the corrective turn didn't change. Nothing downstream of that log
/// line reads its result; a caller who starts relying on this for
/// correctness has misread what it's for.
///
/// `pub` (rather than crate-private, its original visibility) for the same
/// reason `retrieve_nearest`/`retrieve_range`/`search_words`/`RETRIEVAL_LIMIT`
/// elsewhere in this module are: `server/tests/reflect.rs`, an integration
/// test compiled outside this crate, needs to assert a phrasing does *not*
/// match this function's own list, as the negative control that proves the
/// corrective turn no longer depends on matching it.
pub fn claims_no_journal_access(text: &str) -> bool {
    // Live-verified against the real Sandbox while building this ticket's
    // fix (`docs/adr` doesn't cover this — it's recorded here instead,
    // where the bug it fixes actually lives): the configured model writes
    // typographic curly apostrophes (U+2019 `'`) in its own prose, not the
    // ASCII `'` every phrase below is written with. "I can't access..."
    // (curly) silently failed to match a phrase list written as "can't
    // access" (straight) — a real run, `tool_called: false`, was missed
    // entirely by an earlier version of this function for exactly that
    // reason, on the Server this ticket is fixing, using the very phrase
    // issue #103's own report quotes. Normalizing both curly-quote
    // characters to straight ones before matching is what closes that gap,
    // rather than doubling every apostrophe-bearing phrase below.
    let lower = text.to_lowercase().replace(['\u{2018}', '\u{2019}'], "'");
    // The first sixteen were written from issue #103's own report and the
    // first live-verification round; the last five were added after a
    // second round turned up three further phrasings ("I don't have any
    // journal entries available in this chat...", "...I couldn't retrieve
    // any journal entries...") the first list missed outright — the same
    // model, the same underlying failure, different words. This function's
    // own doc comment already names that as expected, not a defect to
    // eliminate: the list widens as real phrasings turn up, it does not
    // chase every one in advance.
    const DENIAL_PHRASES: &[&str] = &[
        "can't access",
        "cannot access",
        "can't retrieve",
        "cannot retrieve",
        "couldn't retrieve",
        "could not retrieve",
        "can't see your journal",
        "cannot see your journal",
        "don't have access",
        "do not have access",
        "unable to access",
        "unable to retrieve",
        "no access to your journal",
        "no way to access",
        "no way to see your journal",
        "not connected to your journal",
        "don't have enough journal context",
        "do not have enough journal context",
        "don't have any journal",
        "do not have any journal",
        "no journal entries available",
    ];
    DENIAL_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

/// Every shape of "nothing to say" `is_empty_final_reply` recognises, given
/// what `harness::prompted::PromptedToolClient` can actually hand back as a
/// tool-call-free reply's text (`ToolCallScanner`'s own doc comment covers
/// the wire mechanics each case below reasons about):
///
/// - Genuinely empty, or only whitespace — the shape issue #102 was
///   actually filed against: a live Turn with `length(answer) = 0`.
/// - Only a markdown code fence with nothing inside it (`` ``` `` or
///   `` ```\n``` ``). `strip_code_fences` already exists to strip a *real*
///   fence wrapped around real content (`parse_tool_call_block` reuses it
///   for exactly that); reused here because the same function correctly
///   reduces a fence-only reply to an empty string.
/// - Only a stray `<tool_call>`/`</tool_call>` tag fragment.
///   `ToolCallScanner`'s own doc comment explains how a `</tool_call>` that
///   was never opened — nothing upstream of it ever matched
///   `<tool_call>` — survives into `ContentBlock::Text` as literal
///   characters instead of being consumed as protocol (the scanner only
///   watches for `<` starting a *new* candidate tag; a bare `<` is not one
///   until proven otherwise). If that fragment is *all* the text is, there
///   is nothing under it.
///
/// Before issue #99 removed it, this list also recognised a bare
/// `GROUNDED: yes`/`GROUNDED: no` verdict line with nothing after it — the
/// fixed pipeline's own answering call could produce exactly that shape,
/// and the same configured model answers `LOOP_SYSTEM_INSTRUCTION` too, so
/// a stray marker from old habit was worth catching. That pipeline, and the
/// marker itself, are gone (this module's own doc comment), and nothing the
/// live loop is ever instructed to write looks like it, so there is no
/// longer a marker-shaped case to strip before checking for emptiness.
///
/// Deliberately *not* on this list: ordinary prose that happens to be
/// short. Only the degenerate case where stripping every one of these away
/// leaves nothing counts as empty.
fn is_empty_final_reply(text: &str) -> bool {
    let candidate = strip_code_fences(text)
        .replace("<tool_call>", "")
        .replace("</tool_call>", "");
    candidate.trim().is_empty()
}

/// A model's final reply, guaranteed non-empty — `new` is the only way to
/// build one, and it refuses everything `is_empty_final_reply` recognises
/// as nothing to say. This is issue #102's answer to its own acceptance
/// criterion that a client-visible Answer be unreachable while empty
/// "structurally rather than by convention": a single gate every route from
/// "a raw model reply" to the `answer: String` stored in `ReflectResponse`
/// and persisted to the tree has to pass through. `run_reflect_stream_inner`
/// never reads `outcome.answer` directly into either of those — it only
/// ever reads `NonEmptyAnswer::into_inner()`'s output, and that function
/// does not exist unless `new` already accepted the text. A future caller
/// who forgets to check emptiness has nothing to forget: there is no plain
/// `String` in scope by the time the Answer is packaged for either
/// destination.
///
/// This is a narrower guarantee than a type-level ban on ever constructing
/// `ReflectResponse { answer: String::new(), .. }` anywhere in the crate —
/// the struct keeps plain `pub` fields (it always did, and it's serialized
/// wire shape besides), so nothing stops a hypothetical future call site
/// from building one by hand with an empty string. Locking that down would
/// mean giving it private fields and a smart constructor instead. What this
/// type actually guarantees is narrower but still load-bearing: the *only*
/// code path that exists today for turning a live model reply into a
/// persisted, client-visible Answer cannot do so with an empty one.
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

/// Builds one SSE frame — `event: name`, `data: <json>` — from a plain
/// `serde_json::Value`. Every payload this module ever hands `json_data`
/// is built the same way `build_tree_payloads` already builds a message
/// payload a few functions below (`json!`/`serde_json::to_value` over
/// plain, always-serializable data), so the same `.expect(...)` posture
/// applies: nothing here can actually fail to serialize, and treating that
/// as reachable would only hide a real bug behind a swallowed `Result`.
fn sse_event(name: &'static str, data: Value) -> Event {
    Event::default().event(name).json_data(data).expect(
        "an SSE event's data here is always a plain serde_json::Value built from this \
         module's own types, which cannot fail to serialize",
    )
}

/// The wire spelling for one `harness::types::StopReason` — deliberately
/// not a `Serialize` impl on `StopReason` itself: every doc comment in
/// `harness` insists that module stay ignorant of any wire format
/// (`agent_loop::render_content_for_display`'s own comment draws exactly
/// this line), and `reflect.rs` is where that translation is already
/// supposed to happen. `snake_case`, matching every other field name this
/// module puts on the wire.
fn stop_reason_str(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Stop => "stop",
        StopReason::Length => "length",
        StopReason::ToolUse => "tool_use",
        StopReason::Error => "error",
        StopReason::Aborted => "aborted",
    }
}

/// "How many Entries came back" for a `tool_execution_end` event — the
/// acceptance criterion issue #96 names directly, alongside which tool ran
/// and what it ran with. `entry_ids.len()` already answers this for three
/// of the loop's four tools (`entries_in_range`, `search_entries` and
/// `similar_entries` all populate `ToolOutcome::entry_ids` —
/// `harness::tools`'s own doc comment). `read_digest` is the one exception:
/// its own doc comment explains why a Digest's Grounding travels in
/// `details.grounding_entry_ids` instead — a Digest's Grounding belongs to
/// the *Digest*, not to this one tool call, the same distinction
/// `run_reflect_stream_inner`'s own `grounding_entry_ids` dedup already
/// respects (`read_digest.rs`'s deliberate "no `.with_entry_ids(...)`").
/// Falling back to counting that array when `entry_ids` itself is empty is
/// what keeps a Digest lookup that actually found something from reporting
/// 0 here regardless.
fn tool_entry_count(entry_ids: &[Uuid], details: &Value) -> usize {
    if !entry_ids.is_empty() {
        return entry_ids.len();
    }
    details
        .get("grounding_entry_ids")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

/// Translates one `harness::agent_loop::LoopEvent` into the SSE frame
/// `reflect_handler`'s stream actually sends — the one place this module
/// decides what each of pi's event names carries on the wire. Every
/// `LoopEvent` variant becomes exactly one `Event`; there is no case that
/// fans out into several or is dropped, so ordering on the wire is
/// identical to the order `agent_loop::run_with_events` reported them in.
fn loop_event_to_sse(event: LoopEvent) -> Event {
    match event {
        LoopEvent::StepStart => sse_event("step_start", json!({})),
        LoopEvent::MessageStart => sse_event("message_start", json!({})),
        LoopEvent::MessageUpdate { delta } => {
            sse_event("message_update", json!({ "delta": delta }))
        }
        LoopEvent::MessageEnd { assistant } => sse_event(
            "message_end",
            json!({
                // Only the prose half — `agent_loop::render_text`, the same
                // reading `run`'s own stopping rule uses for the Answer
                // itself — never the literal `<tool_call>` tag
                // `prompted::PromptedToolClient` puts on the wire to the
                // model: that syntax means nothing to a person, and a
                // `tool_execution_start` event already carries the same
                // tool name/arguments in a shape meant to be rendered.
                "text": agent_loop::render_text(&assistant.content),
                "stop_reason": stop_reason_str(assistant.stop_reason),
            }),
        ),
        LoopEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            arguments,
        } => sse_event(
            "tool_execution_start",
            json!({
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "arguments": arguments,
            }),
        ),
        LoopEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            is_error,
            details,
            entry_ids,
        } => {
            let entry_count = tool_entry_count(&entry_ids, &details);
            sse_event(
                "tool_execution_end",
                json!({
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "is_error": is_error,
                    "details": details,
                    "entry_ids": entry_ids,
                    "entry_count": entry_count,
                }),
            )
        }
    }
}

/// Opens, uses, and commits its own short transaction around exactly one
/// `sessions::append_record` call — the shape every `session_records` write
/// this ticket makes takes, on purpose: see `sessions::append_record`'s own
/// doc comment for why a record has to commit on its own rather than inside
/// whatever longer-lived transaction the Turn it describes eventually
/// commits through. Errors are logged and swallowed, never propagated —
/// this table is an audit trail, not something a Question's own success
/// depends on (`harness::run_log`'s own doc comment makes the same choice
/// for the loop's own writes).
async fn write_record(pool: &PgPool, session_id: Uuid, id: Uuid, kind: RecordKind, payload: Value) {
    let result: anyhow::Result<()> = async {
        let mut tx = pool.begin().await?;
        sessions::append_record(&mut tx, session_id, id, kind, payload).await?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(err) = result {
        tracing::error!(error = ?err, session_id = %session_id, kind = kind.as_str(), "failed to write an operation-log record");
    }
}

/// The `harness::run_log::RunLog` `reflect.rs` actually gives the loop —
/// every method is exactly `write_record` (or, for `tool_started`, a
/// reserved id plus `write_record`) under a fixed `session_id`. This is the
/// one place in the crate that turns the loop's wire-agnostic, Postgres-
/// agnostic port into real writes against `session_records` — see
/// `run_log`'s own module doc comment for why the trait itself can't do
/// this.
struct SessionRunLog<'a> {
    pool: &'a PgPool,
    session_id: Uuid,
}

#[async_trait::async_trait]
impl RunLog for SessionRunLog<'_> {
    async fn step_attempt(&self, turn: u32) {
        write_record(
            self.pool,
            self.session_id,
            Uuid::new_v4(),
            RecordKind::StepAttempt,
            json!({ "turn": turn }),
        )
        .await;
    }

    async fn tool_started(&self, tool_call_id: &str, tool_name: &str, arguments: &Value) -> Uuid {
        // Issue #108's own criterion: this id is minted *before* the tool
        // it names ever runs, and is the record's own `id` — not a field
        // inside its payload — so "did this tool's result land?" is later
        // answered by checking whether a `session_entries` row with this
        // same id exists (migration `0006`'s own comment on
        // `session_records`; `sessions::record_turn_from_steps` is what
        // reuses it for that row, via `build_tree_payloads` below).
        let id = Uuid::new_v4();
        write_record(
            self.pool,
            self.session_id,
            id,
            RecordKind::ToolStarted,
            json!({
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "arguments": arguments,
            }),
        )
        .await;
        id
    }

    async fn usage(&self, input_tokens: u32, output_tokens: u32) {
        write_record(
            self.pool,
            self.session_id,
            Uuid::new_v4(),
            RecordKind::Usage,
            json!({ "input_tokens": input_tokens, "output_tokens": output_tokens }),
        )
        .await;
    }

    async fn abort_requested(&self) {
        write_record(
            self.pool,
            self.session_id,
            Uuid::new_v4(),
            RecordKind::AbortRequested,
            json!({}),
        )
        .await;
    }
}

/// The spawned task `reflect_handler` hands its SSE sender to — runs the
/// loop, translating every `LoopEvent` it reports into a frame on `tx` as
/// it happens, and always ends the stream with exactly one `agent_end`
/// frame: `{"status": "ok", ...ReflectResponse}` on success, or
/// `{"status": "error", "error": "..."}` on any failure
/// `run_reflect_stream_inner` returns. This is issue #96's answer to "a Server
/// interrupted mid-Answer leaves the interface recoverable": the stream
/// always ends with a frame a client can recognise as failure, rather than
/// the connection just closing (which a client cannot tell apart from a
/// dropped network) or hanging forever waiting for an `agent_end` that
/// never comes. Every `tx.send` here is `let _ = ...` for the same reason
/// `chat::PromptedToolClient::stream`'s is: a client that has already
/// disconnected has simply dropped its receiver, which is not a failure
/// this task needs to report anywhere — there is no one left to tell.
///
/// Issue #108: this function is also the operation log's bracket —
/// `operation_started` before `run_reflect_stream_inner` runs,
/// `operation_finished` once it's done, regardless of outcome. Placed here
/// rather than inside `run_reflect_stream_inner` deliberately: that
/// function's own loop calls (the initial run, plus up to two corrective
/// retries — issue #102, #103) are all *one* operation from the operation
/// log's point of view, not one apiece, and this is the one place called
/// exactly once per `/v1/reflect` request regardless of how many of those
/// `run_inner` invocations it takes.
async fn run_reflect_stream(
    pool: PgPool,
    reflect: ReflectState,
    req: ReflectRequest,
    session_id: Uuid,
    prior_turns: Vec<SessionTurnRow>,
    title: String,
    tx: SseSender,
) {
    write_record(
        &pool,
        session_id,
        Uuid::new_v4(),
        RecordKind::OperationStarted,
        json!({ "question": req.question }),
    )
    .await;

    let result =
        run_reflect_stream_inner(&pool, &reflect, &req, session_id, prior_turns, &title, &tx).await;

    write_record(
        &pool,
        session_id,
        Uuid::new_v4(),
        RecordKind::OperationFinished,
        json!({ "status": if result.is_ok() { "ok" } else { "error" } }),
    )
    .await;

    let final_event = match result {
        Ok(response) => {
            // `ReflectResponse` still carries exactly the shape a pre-#96
            // client's whole response body used to be — flattened onto
            // `agent_end` rather than replaced, so everything that shape
            // already meant (session_id/title/answer/grounding_entry_ids/
            // tool_called/model) survives the move from "the response
            // body" to "the terminal event's data" unchanged.
            let mut payload =
                serde_json::to_value(&response).expect("serializing a ReflectResponse can't fail");
            payload["status"] = json!("ok");
            sse_event("agent_end", payload)
        }
        Err(err) => sse_event(
            "agent_end",
            json!({ "status": "error", "error": err.to_string() }),
        ),
    };
    let _ = tx.send(Ok(final_event));
}

/// `/v1/reflect`'s live implementation (issue #93 pass 2; issue #96 turned
/// it into the body of a spawned, streaming task rather than a request/
/// response function): builds a `harness::types::Context` from
/// `prior_turns` plus the active tool set, runs
/// `harness::agent_loop::run_with_events` against a `PromptedToolClient`
/// wrapping `reflect.chat_client` — reporting every `LoopEvent` it produces
/// onto `tx` as an SSE frame, live, via `loop_event_to_sse` — and, only once
/// the loop actually produced an Answer, persists every step it took into
/// the Session entry tree (`sessions::record_turn_from_steps`) in one
/// transaction: a failed run never reaches that call at all, so a Session
/// never ends up holding a Question with no Answer behind it. Session
/// resolution itself (`resolve_session`) already happened in
/// `reflect_handler`, synchronously, before this function's caller
/// (`run_reflect_stream`) was ever spawned — see that handler's own doc
/// comment for why.
///
/// What one Turn actually runs on: which `LlmClient` to call, whether it
/// streams, and how much context it holds — everything `run_reflect_stream_inner`
/// needs to build a `PromptedToolClient` and a compaction budget for
/// whichever model this Turn resolved to.
struct ResolvedModel {
    client: Arc<dyn LlmClient + Send + Sync>,
    streaming: bool,
    context_window: u32,
}

/// Issue #98: resolves `model` — either a Question's own explicit choice,
/// or whatever model a Conversation was already on (`run_reflect_stream_inner`'s
/// own call site works out which) — into what actually running a Turn on
/// it needs.
///
/// The Server's own configured default needs nothing looked up: `reflect`
/// already carries `chat_client`/`chat_streaming`/`context_window`,
/// resolved once at startup for exactly this model (`main.rs`,
/// `LlmConfig::resolve_context_window`'s own doc comment on why a live
/// call belongs there and not per Question) — reusing them here is what
/// keeps a Question that never names a model, on a Conversation that never
/// changed one, making zero extra network calls, exactly as it did before
/// this ticket existed.
///
/// Any other model is looked up live, through `reflect.chat_client.list_models()`
/// — the same list `GET /v1/models` reports, reached through the
/// `LlmClient` trait rather than `llm::list_models` directly so a test can
/// script it via `FakeChatClient::list_models` instead of needing a live
/// (or mocked) wrapper to ask (see `LlmClient::list_models`'s own doc
/// comment). A model absent from that list — never existed, or existed
/// once and has since disappeared from the wrapper's own reach (issue
/// #98's own "a model that disappears" acceptance criterion) — is **not**
/// rejected here, and does **not** fall back to the default: `reflect.chat_client.for_model(model)`
/// is called regardless (the same trait method that produces the client
/// for a model this list *did* find), with the same conservative "unknown"
/// defaults `resolve_context_window` already uses (`streaming: false`,
/// `harness::compaction::DEFAULT_CONTEXT_WINDOW`), and left to fail at the
/// one place that actually knows whether it's reachable — the chat call
/// itself. Its `chat`/`chat_stream` turns that failure into an `Err`,
/// `chat::ChatClient`'s never-`Err` contract turns *that*
/// into a terminal `StopReason::Error`, and `run_reflect_stream_inner`
/// only ever persists a Turn once `outcome.answer` exists — so a
/// disappeared model produces a clean `agent_end` error event and writes
/// nothing at all, leaving the Conversation exactly as it was before the
/// attempt. This is a deliberate choice over silently falling back to the
/// default: issue #98 is explicit that a limit hit under one model must
/// not be mistaken for a limit under whatever replaced it, and a silent
/// substitution would produce exactly that confusion — the model that
/// actually answered would no longer be the one the Conversation (and any
/// `model_change` entry already in it) says it's running on. A clear
/// failure the user can retry, or explicitly change model past, is the
/// honest alternative.
async fn resolve_model(reflect: &ReflectState, model: &str) -> ResolvedModel {
    if model == reflect.chat_model {
        return ResolvedModel {
            client: reflect.chat_client.clone(),
            streaming: reflect.chat_streaming,
            context_window: reflect.context_window,
        };
    }

    let info = reflect
        .chat_client
        .list_models()
        .await
        .into_iter()
        .find(|listed| listed.id == model);
    let streaming = info.as_ref().is_some_and(|listed| listed.streaming);
    let context_window = info
        .and_then(|listed| listed.context_window)
        .unwrap_or(compaction::DEFAULT_CONTEXT_WINDOW);
    let client = reflect.chat_client.for_model(model);
    ResolvedModel {
        client,
        streaming,
        context_window,
    }
}

async fn run_reflect_stream_inner(
    pool: &PgPool,
    reflect: &ReflectState,
    req: &ReflectRequest,
    session_id: Uuid,
    prior_turns: Vec<SessionTurnRow>,
    title: &str,
    tx: &SseSender,
) -> anyhow::Result<ReflectResponse> {
    let offset_minutes = req
        .utc_offset_minutes
        .clamp(MIN_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES);

    // Issue #98: which model this Turn actually runs on. `prior_turns` here
    // is still the *whole*, un-windowed Conversation `resolve_session`
    // loaded — its own `SessionTurnRow::model` (via `load_turns`'s
    // tree-walk) already tells us exactly what the Conversation's last
    // Turn ran on, so reading `.last()` off it is cheaper and more direct
    // than re-walking the tree a second time here just to answer the same
    // question. A brand-new Session (`prior_turns` empty) has nothing to
    // read, and is on the Server's own default by construction. `req.model`
    // overrides either: `None` means "stay on whatever this Conversation is
    // already on" (`ReflectRequest::model`'s own doc comment is explicit
    // this is *not* the same as "use the default" for an ongoing
    // Conversation), `Some` names the model to move to, whether or not that
    // differs from where the Conversation already was.
    let current_model = prior_turns
        .last()
        .map(|turn| turn.model.clone())
        .unwrap_or_else(|| reflect.chat_model.clone());
    let resolved_model_id = req.model.clone().unwrap_or_else(|| current_model.clone());
    // `None` when this Turn doesn't change anything — the ordinary case,
    // and the reason an unbroken run on one model appends no `model_change`
    // entries at all (`ModelChangePayload`'s own doc comment).
    let model_change = (resolved_model_id != current_model).then(|| resolved_model_id.clone());
    let resolved = resolve_model(reflect, &resolved_model_id).await;

    // `CONVERSATION_WINDOW`'s own doc comment covers why this is bounded —
    // what's replayed into the loop's own `Context.messages` here.
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
    // `existing_summary` is read unconditionally, on every request — not
    // only the one that happens to trigger a *new* compaction — because
    // `sessions::latest_compaction_summary`'s own doc comment names exactly
    // the bug that skipping this would reintroduce: a summary that only
    // ever reached the one Question that wrote it. Issue #108: this used to
    // be conditioned on `req.session_id.is_some()`, back when a brand-new
    // Session had no `session_id` at all until `record_turn_from_steps`
    // minted one at the very end — `session_id` above is always real now
    // (`resolve_session` mints one up front), so this runs unconditionally.
    // For a genuinely new Session (`prior_turns` empty) both calls below are
    // a cheap no-op: `latest_compaction_summary` reads `None` off a Session
    // with no entries yet, and `maybe_compact_prior_turns` returns
    // `(existing_summary, prior_turns)` unchanged the moment it sees an
    // empty `prior_turns` — one extra, inexpensive query on a brand-new
    // Session's first Question, not a behaviour change.
    let existing_summary = sessions::latest_compaction_summary(pool, session_id).await?;
    let (prior_summary, prior_turns) = maybe_compact_prior_turns(
        pool,
        session_id,
        prior_turns,
        existing_summary,
        &resolved.client,
        resolved.context_window,
    )
    .await?;

    // Up to four tools: `entries_in_range` (issue #93, by date),
    // `search_entries` (issue #94, by word), `similar_entries` (issue #94,
    // by meaning) and `read_digest` (issue #95, a written summary rather
    // than raw Entries at all) — each independently constructible, so a
    // future caller (issue #100's evaluation) can build its own subset of
    // this same `Vec` to compare arms without touching `run_reflect_stream_inner`
    // itself. `search_entries` and `similar_entries` stay two tools rather
    // than one merged one deliberately — see `harness::tools`'s own doc
    // comment for why.
    //
    // Issue #130: `similar_entries` is the one tool of the four backed by
    // embeddings (`SimilarEntriesTool::execute` calls `embed_client.
    // embed_query`), so it's the one tool left out entirely — not merely
    // disabled — when `reflect.embed_client` is `None`. Leaving it out of
    // the `Vec` rather than offering it and letting every call fail is what
    // keeps `render_tool_guidance` honest: a chat-only Server's system
    // prompt never advertises a capability that would only turn out, turn
    // by turn, not to work.
    //
    // Built as an initial three-tool `Vec` with `similar_entries` inserted
    // at index 2 (rather than appended) so that when it *is* present, this
    // stays the exact `entries_in_range, search_entries, similar_entries,
    // read_digest` order the system prompt has always rendered in —
    // `render_tool_guidance` walks the `Vec` in order, so appending instead
    // would silently reorder the prompt for every already-configured Server
    // this ticket has no reason to touch.
    let mut tools: Vec<Arc<dyn AgentTool>> = vec![
        Arc::new(EntriesInRangeTool::new(pool.clone(), offset_minutes)),
        Arc::new(SearchEntriesTool::new(pool.clone(), offset_minutes)),
        Arc::new(ReadDigestTool::new(pool.clone())),
    ];
    if let Some(embed_client) = reflect.embed_client.clone() {
        tools.insert(
            2,
            Arc::new(SimilarEntriesTool::new(pool.clone(), embed_client, offset_minutes)),
        );
    }
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

    let chat_client = PromptedToolClient::new(resolved.client.clone(), resolved.streaming);
    // The one place `agent_loop::LoopEvent`s become SSE frames as the loop
    // actually produces them, rather than after the fact — `tx.send` is
    // synchronous and non-blocking (`SseSender`'s own doc comment), which is
    // exactly what `agent_loop::EventSink`'s contract requires of whatever
    // it's handed (see that type's own doc comment). Reused for both the
    // initial call and the empty-reply retry below, so a client watching
    // the stream sees one continuous sequence of turns rather than two
    // runs it has to stitch together itself.
    let sink = |event: LoopEvent| {
        let _ = tx.send(Ok(loop_event_to_sse(event)));
    };
    // Issue #108: the operation log's own port into the loop — shared
    // across the initial call and both corrective retries below, all under
    // the same `session_id`, the same as `sink` just above.
    let run_log = SessionRunLog { pool, session_id };

    // `should_stop_after_turn` is `agent_loop::run`'s own unused hook
    // (`ShouldStopAfterTurn`'s doc comment) — issue #93 pass 2 ships no
    // step budget, deliberately, so `None` every time.
    //
    // `messages`/`system_prompt` are cloned here, rather than moved
    // straight into `run_with_events`, so both are still around to build a
    // retry below if this first call's final reply turns out to be empty —
    // the ordinary case never needs them again, so the clone is spent only
    // once, ahead of a chat call that already costs several seconds.
    let mut outcome = agent_loop::run_with_events(
        &chat_client,
        system_prompt.clone(),
        &tools,
        messages.clone(),
        None,
        Some(resolved.context_window),
        &sink,
        Some(&run_log),
    )
    .await;

    // Issue #106: the index, into whatever `outcome.steps` ends up being by
    // the time `build_tree_payloads` runs below, of the `Step::Assistant`
    // that is the *accepted* Answer — not necessarily the last step once
    // either corrective turn below has run. Starts out as the initial run's
    // own last step, which is correct whenever neither corrective block
    // fires: `outcome.answer`, when `Some`, is always that call's own last
    // pushed step (`agent_loop::run`'s own doc comment on exit point 2).
    // Each block below that keeps its retry's reply updates this the same
    // way; the no-tool-call block, which can instead keep the *original*
    // reply, is the one place this stops tracking "last" (see its own
    // comment).
    let mut answer_step_index = outcome.steps.len().saturating_sub(1);

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
            session_id = %session_id,
            "reflect loop's final reply was empty; giving it one corrective turn"
        );
        // Cloned, not moved: issue #103's own corrective turn below needs
        // `messages` too, for the same reason (the original Conversation
        // prefix `agent_loop::steps_to_messages` doesn't itself carry), and
        // may still be needed even when this branch already ran.
        let mut retry_messages = messages.clone();
        retry_messages.extend(agent_loop::steps_to_messages(&outcome.steps));
        retry_messages.push(Message::User(EMPTY_REPLY_CORRECTION.to_string()));
        let retry_outcome = agent_loop::run_with_events(
            &chat_client,
            system_prompt.clone(),
            &tools,
            retry_messages,
            None,
            Some(resolved.context_window),
            &sink,
            Some(&run_log),
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
        // This retry's answer, whenever it ends up non-empty, is always
        // this block's own last pushed step — there is no "keep the
        // original" fallback here (a still-empty reply falls straight
        // through to the `NonEmptyAnswer` gate below and fails the
        // request), so "last" stays correct.
        answer_step_index = steps.len().saturating_sub(1);
        outcome = agent_loop::LoopOutcome {
            steps,
            answer: retry_outcome.answer,
            error: retry_outcome.error,
        };
    }

    // Issue #103, round 2: live verification against the Sandbox kept
    // finding phrasings a keyword-matched trigger hadn't seen yet — see
    // `NO_TOOL_CALL_CORRECTION`'s own doc comment for the wording that
    // finally defeated the old gate. This version fires on the structural
    // fact alone, the same one `tool_called` below already names: a run
    // produced an Answer and called no tool at all. No wording can dodge
    // that. `claims_no_journal_access` is still computed, but only to tag
    // the log line below — it plays no part in whether this block runs.
    //
    // `!retried` is the mutual-exclusivity guard with the empty-reply block
    // above, and it has to be an explicit flag, not just "does the current
    // outcome still look bad" — a structural trigger made that the hard way
    // to learn: the empty-reply retry's own reply can itself be a real,
    // non-empty, zero-tool-call answer (`an_empty_final_reply_gets_one_corrective_turn_and_then_answers`
    // in `tests/reflect.rs` is exactly this shape), which satisfies this
    // block's condition just as well as a first-attempt denial does. Without
    // `!retried` that would spend a *second* corrective turn on a Question
    // that already used its one, which is exactly the compounding this
    // comment block warned about under the old, heuristic-gated version —
    // the heuristic rarely matched an ordinary retried answer, which is
    // what hid the gap; the structural condition matches it every time, so
    // the guard has to be explicit instead of incidental.
    if !retried
        && outcome
            .answer
            .as_deref()
            .and_then(NonEmptyAnswer::new)
            .is_some()
        && !outcome
            .steps
            .iter()
            .any(|step| matches!(step, Step::ToolResult { .. }))
    {
        // Re-reads `outcome.answer`, already proven `Some` and non-empty by
        // the `is_some()` check above — this is purely to classify it for
        // the log line below, not to decide whether to retry.
        let looked_like_denial = outcome
            .answer
            .as_deref()
            .is_some_and(claims_no_journal_access);
        tracing::warn!(
            question = %req.question,
            session_id = %session_id,
            looked_like_denial,
            "reflect loop answered with no tool call at all; giving it one corrective turn"
        );
        let mut retry_messages = messages;
        retry_messages.extend(agent_loop::steps_to_messages(&outcome.steps));
        retry_messages.push(Message::User(NO_TOOL_CALL_CORRECTION.to_string()));
        let retry_outcome = agent_loop::run_with_events(
            &chat_client,
            system_prompt,
            &tools,
            retry_messages,
            None,
            Some(resolved.context_window),
            &sink,
            Some(&run_log),
        )
        .await;

        let mut steps = outcome.steps;
        let original_answer = outcome.answer;
        // Issue #106: captured *before* the retry's own steps are appended
        // below — the accepted Answer, if the retry ends up rejected, is
        // the last `Step::Assistant` `outcome.steps` already held going
        // into this block, not whatever ends up last in the combined list
        // once the retry's (possibly empty) reply is appended after it.
        let original_answer_index = steps.len().saturating_sub(1);
        steps.extend(retry_outcome.steps);
        // Unlike the empty-reply block above, a corrective turn that itself
        // comes back empty (or errors) must not turn an already-valid,
        // if wrong, Answer into a failed Question — the user is owed
        // *something* for this Question either way, and the pre-correction
        // denial, while wrong, is still real text that was already safe to
        // show (CONTEXT.md's don't-invent rule is about fabricating journal
        // content, not about this). Only a genuinely non-empty retry reply
        // replaces it; anything else falls back to the original.
        let retry_accepted = retry_outcome
            .answer
            .as_deref()
            .is_some_and(|text| !is_empty_final_reply(text));
        let answer = if retry_accepted {
            retry_outcome.answer
        } else {
            original_answer
        };
        // Mirrors `answer` above exactly: the retry's own last step when
        // its reply was accepted (`steps.len() - 1`, since its steps were
        // just appended), otherwise the original answer's own index,
        // captured above before the append — this is the one place in this
        // function where the accepted Answer is not simply "the last step,"
        // which is why #106's fix marks it explicitly rather than inferring
        // it positionally in `build_tree_payloads`.
        answer_step_index = if retry_accepted {
            steps.len().saturating_sub(1)
        } else {
            original_answer_index
        };
        outcome = agent_loop::LoopOutcome {
            steps,
            answer,
            error: None,
        };
    }

    // `NonEmptyAnswer::new` is the single gate issue #102 adds — see its own
    // doc comment for why this, rather than a second independent check, is
    // what keeps an empty Answer from ever reaching the client or
    // `sessions::record_turn_from_steps`: nothing below this point ever
    // reads `outcome.answer` directly again.
    let Some(answer) = outcome.answer.as_deref().and_then(NonEmptyAnswer::new) else {
        if retried {
            tracing::warn!(
                question = %req.question,
                session_id = %session_id,
                "reflect loop's final reply was still empty after a corrective turn; \
                 failing the request"
            );
        }
        let reason = outcome.error.unwrap_or_else(|| {
            "the model stopped without ever producing a reply with no tool \
                                 call left in it"
                .to_string()
        });
        return Err(anyhow::anyhow!(
            "reflect loop did not produce an Answer: {reason}"
        ));
    };
    let answer = answer.into_inner();

    // Every Entry id any tool result surfaced, deduped keeping first
    // occurrence — generic across whatever tool produced it, not a merged,
    // ranked list computed in advance (issue #99 removed the pipeline that
    // used to build one): simply the Entry ids the tools returned.
    //
    // Issue #106 follow-up: scoped to `..=answer_step_index`, not all of
    // `outcome.steps` — Grounding is what the tools returned *before* the
    // accepted Answer, not anything any tool call anywhere in this request
    // ever surfaced. The no-tool-call fallback branch above is exactly why
    // this distinction is live: its rejected retry runs a full loop of its
    // own, which can call a real tool and see a real Entry before its own
    // final reply comes back empty and gets rejected — those steps land in
    // `outcome.steps` *after* `answer_step_index` for an honest record (see
    // that branch's own comment), but the kept Answer they're appended
    // after was produced before any of them happened. Crediting it with
    // that Grounding, or reporting `tool_called: true` for it, would be the
    // same class of bug as #99's carry-over and #105's misattribution: the
    // record disagreeing with what actually produced the Answer. Using the
    // same bound `build_tree_payloads` already keys the marked entry's own
    // payload on keeps the live response and the persisted, reloaded Turn
    // in agreement — both read from this one computation.
    let grounded_steps = &outcome.steps[..=answer_step_index];
    let mut seen_entry_ids = HashSet::new();
    let mut grounding_entry_ids = Vec::new();
    for step in grounded_steps {
        if let Step::ToolResult { entry_ids, .. } = step {
            for id in entry_ids {
                if seen_entry_ids.insert(*id) {
                    grounding_entry_ids.push(*id);
                }
            }
        }
    }
    // Issue #103: `tool_called` asks whether the model ever tried, kept
    // apart from `grounding_entry_ids` on purpose — an empty
    // `grounding_entry_ids` alone conflates "tried and found nothing" with
    // "never tried at all"; this is the flag that keeps them apart in the
    // record (`ReflectResponse::tool_called`'s own doc comment covers why
    // that distinction matters). Scoped to the same `grounded_steps` bound
    // as `grounding_entry_ids` above, for the same #106 follow-up reason.
    let tool_called = grounded_steps
        .iter()
        .any(|step| matches!(step, Step::ToolResult { .. }));

    // Issue #105: whether this Answer is attributable to a Digest — the
    // same `sessions::DigestSourceTracker` rule `entries_to_turns` applies
    // while re-walking the persisted tree, folded here over the identical
    // `grounded_steps` bound `grounding_entry_ids`/`tool_called` above
    // already use. Computed once, here, rather than left for the client to
    // infer from `tool_execution_end` events as it used to — see
    // `ReflectResponse::digest_source`'s own doc comment.
    let mut digest_source_tracker = sessions::DigestSourceTracker::default();
    for step in grounded_steps {
        if let Step::ToolResult {
            details, entry_ids, ..
        } = step
        {
            digest_source_tracker.observe(details, entry_ids);
        }
    }
    let digest_source = digest_source_tracker.resolve();

    // The exact shape issue #103 was filed against: a non-empty, confident
    // Answer with no Grounding *and* no tool ever attempted — as opposed to
    // the ordinary and unremarkable case of a tool genuinely finding
    // nothing (`tool_called: true`, `grounding_entry_ids: []`), which needs
    // no warning at all. `is_empty_final_reply`'s own retry path already
    // logs the empty-reply shape (issue #102); this is the other way a
    // Question can end with no real Grounding and nothing seen. By the
    // time this line can fire, the structural corrective turn above has
    // already had its one chance to fix it (`NO_TOOL_CALL_CORRECTION`'s own
    // doc comment) — reaching here means either the retry legitimately
    // confirmed no tool was needed, or the model still didn't call one.
    // `claims_no_journal_access` no longer decides anything by this point
    // (see its own doc comment on being observability-only); it's read here
    // purely to keep the specific "this reads like a denial" shape
    // greppable in the log, distinguishable from an ordinary — and
    // legitimate — no-tool-call reply that also has no Grounding.
    if grounding_entry_ids.is_empty() && !tool_called {
        tracing::warn!(
            question = %req.question,
            session_id = %session_id,
            answer_preview = %answer.chars().take(120).collect::<String>(),
            looked_like_denial = claims_no_journal_access(&answer),
            "reflect loop's final answer had no tool call and no Grounding at all"
        );
    }

    let payloads = build_tree_payloads(
        &req.question,
        &outcome.steps,
        answer_step_index,
        &grounding_entry_ids,
        model_change.as_deref(),
    );
    sessions::record_turn_from_steps(pool, session_id, payloads).await?;

    Ok(ReflectResponse {
        session_id,
        title: title.to_string(),
        answer,
        grounding_entry_ids,
        tool_called,
        model: resolved_model_id,
        digest_source,
    })
}

/// `prior_turns`, as the `[User, Assistant]` message pairs
/// `run_reflect_stream_inner` replays into the loop's own `Context` — factored out
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
/// `run_reflect_stream_inner` has appended anything for the *current* Question at
/// all, the entry this writes always lands cleanly on the boundary between
/// the last already-persisted Turn and whatever Turn is about to happen —
/// never inside one.
///
/// **Always summarises every Turn in `prior_turns`, never a suffix of
/// them** — `sessions::append_compaction`'s own doc comment covers why a
/// partial keep is not just undesirable but impossible: `session_entries`
/// is append-only, so a compaction written now can only ever describe
/// "everything up to the current leaf," and the current leaf, at this
/// point in `run_reflect_stream_inner`, is the *last* already-persisted Turn.
/// `harness::compaction::KEEP_RECENT_TOKENS`/`find_cut_point` — the
/// "keep some of the tail verbatim" logic — has no equivalent here for
/// exactly that reason; it belongs to `agent_loop::run`'s ephemeral
/// `messages`, which has no such constraint, not to this persisted
/// checkpoint.
///
/// `existing_summary` is whatever `sessions::latest_compaction_summary`
/// already found for this Session (`run_reflect_stream_inner`'s own call, made
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
/// own `Ok(false)` — see that function's own doc comment for why this state
/// is defended against even though a real, committed Session can't actually
/// be in it) — so a caller always gets back *some* summary to show the
/// model when one exists, whether or not this particular call is the one
/// that just wrote it.
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
/// in the first place). `existing_summary`, when given, is rendered first,
/// ahead of every Turn — see
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
/// `(EntryType, Value, Option<Uuid>)` payload list `sessions::record_turn_from_steps`
/// chains onto the Session's tree — the User entry first (the tree has no
/// separate concept of "the request that started this Turn" the way
/// `Context.messages` does), then one entry per `Step`, in the order they
/// happened. The third field is an id already reserved before the work it
/// describes started, when there is one (issue #108) — only ever `Some` for
/// a `Step::ToolResult`, whose `entry_id` was minted by
/// `harness::run_log::RunLog::tool_started` before that tool call ran;
/// every other payload leaves it `None` and lets `record_turn_from_steps`
/// mint a fresh id, exactly as every entry did before this ticket.
///
/// Only the `Assistant` step at `answer_step_index` — the accepted
/// Answer, computed by `run_reflect_stream_inner` above — carries
/// `grounding_entry_ids` in its persisted payload, and is the one
/// `MessagePayload::Assistant` entry marked `is_answer: true`.
/// `sessions::entries_to_turns` prefers whichever entry in a Turn's run
/// carries that flag (its own doc comment covers why: issue #106 found that
/// "the last Assistant entry" stops being the accepted Answer once a
/// corrective turn's own reply can be rejected and fallen back from). Every
/// other Assistant step — including one *after* `answer_step_index`, e.g. a
/// rejected corrective retry's own reply, kept as an honest record of what
/// actually happened — is written with `is_answer: false` and no Grounding;
/// giving either to a step that isn't the accepted Answer would be
/// misleading if anything ever read it directly.
///
/// `model_change` (issue #98) is `Some(model)` exactly when this Turn's own
/// `resolve_model` call found the Conversation moving onto a different
/// model than it was already on — `run_reflect_stream_inner`'s own
/// `model_change` local, computed once before any chat call runs. When
/// present, its `model_change` entry is chained on *first*, immediately
/// before the Question it precedes and inside the same `payloads` list —
/// same transaction, same `record_turn_from_steps` call — which is what
/// "recorded in the Conversation itself, in order, alongside everything
/// else" actually means: not a second write, not a separate endpoint, just
/// one more entry in the same append.
fn build_tree_payloads(
    question: &str,
    steps: &[Step],
    answer_step_index: usize,
    grounding_entry_ids: &[Uuid],
    model_change: Option<&str>,
) -> Vec<(EntryType, Value, Option<Uuid>)> {
    let mut payloads = Vec::with_capacity(steps.len() + 2);
    if let Some(model) = model_change {
        payloads.push((
            EntryType::ModelChange,
            serde_json::to_value(ModelChangePayload {
                model: model.to_string(),
            })
            .expect("serializing a model_change payload can't fail"),
            None,
        ));
    }
    payloads.push((
        EntryType::Message,
        serde_json::to_value(MessagePayload::User {
            text: question.to_string(),
        })
        .expect("serializing a user message payload can't fail"),
        None,
    ));

    for (index, step) in steps.iter().enumerate() {
        let (payload, reserved_id) = match step {
            Step::Assistant(assistant) => {
                let is_final_answer = index == answer_step_index;
                let payload = serde_json::to_value(MessagePayload::Assistant {
                    text: agent_loop::render_content_for_display(&assistant.content),
                    grounding_entry_ids: if is_final_answer {
                        grounding_entry_ids.to_vec()
                    } else {
                        Vec::new()
                    },
                    is_answer: is_final_answer,
                })
                .expect("serializing a message payload can't fail");
                (payload, None)
            }
            Step::ToolResult {
                tool_name,
                content,
                is_error,
                details,
                entry_ids,
                entry_id,
                ..
            } => {
                let payload = serde_json::to_value(MessagePayload::ToolResult {
                    text: content.clone(),
                    tool_name: tool_name.clone(),
                    is_error: *is_error,
                    details: details.clone(),
                    // Issue #105: persisted so a reload can re-derive
                    // `digest_source` with `sessions::DigestSourceTracker`
                    // exactly as this run computed it live — see that
                    // type's own doc comment.
                    entry_ids: entry_ids.clone(),
                })
                .expect("serializing a message payload can't fail");
                // Issue #108: reuse the id `harness::run_log::RunLog::tool_started`
                // already reserved and committed to `session_records`
                // *before* this tool ever ran — never a fresh
                // `Uuid::new_v4()` — so `sessions::append_entry` writes this
                // `tool_result` entry under the exact id its own
                // `tool_started` record already named. See that trait's own
                // doc comment for why this is the whole point.
                (payload, Some(*entry_id))
            }
        };
        payloads.push((EntryType::Message, payload, reserved_id));
    }

    payloads
}

/// `pub` for the same reason as `GroundingEntry` above — issue #90's
/// `tests/eval_retrieval.rs` measures this arm directly against the
/// Sandbox corpus.
///
/// Returns its top `limit` rows by cosine distance, unconditionally — no
/// similarity floor is applied (issue #92 deleted `MIN_SIMILARITY`; see
/// `docs/adr/0023`'s amendment for the measurement that killed it). This
/// function no longer has an opinion about what counts as relevant; the
/// model does, once it actually sees the Question and a candidate Entry
/// side by side in whichever tool result surfaced it.
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
        NonEmptyAnswer, TITLE_MAX_CHARS, claims_no_journal_access, derive_title,
        extract_json_object, is_empty_final_reply, local_date_range_to_utc, search_words,
        strip_code_fences,
    };

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
    fn ordinary_prose_is_not_empty() {
        assert!(!is_empty_final_reply("Nothing to report."));
        assert!(!is_empty_final_reply(
            "Your knee has improved since February."
        ));
    }

    /// Every wording issue #103 actually observed live is caught: the
    /// exact sentence from the issue report itself, plus the two further
    /// phrasings the same live model produced across the extra
    /// live-verification attempts this ticket ran against the real
    /// Sandbox.
    #[test]
    fn claims_no_journal_access_catches_every_wording_observed_live() {
        assert!(claims_no_journal_access(
            "I can't access any journal entries from here, so I can't tell how your knee has \
             been doing without guessing."
        ));
        assert!(claims_no_journal_access(
            "I'm unable to retrieve your journal entries in this chat, so I can't tell how your \
             knee is doing."
        ));
        assert!(claims_no_journal_access(
            "I'm sorry, but I don't have enough journal context here to tell how your knee is \
             doing."
        ));
        // Turned up by a second live-verification round, after the first
        // three phrasings above were already covered — the same failure,
        // worded two more ways the first pass of this list didn't catch.
        assert!(claims_no_journal_access(
            "I don't have any journal entries available in this chat to assess how your knee \
             has been doing."
        ));
        assert!(claims_no_journal_access(
            "I'm sorry, but I couldn't retrieve any journal entries about your knee to assess \
             how it's doing."
        ));
    }

    /// The exact bug a live-verification run against the real Sandbox
    /// found while building this fix: the configured model's own prose
    /// uses typographic curly apostrophes, and an earlier version of
    /// `claims_no_journal_access` — written and tested with the ASCII
    /// apostrophe every ticket-authored phrase in this file happens to
    /// use — silently failed to recognise "I can\u{2019}t access your \
    /// journal entries in this chat" for exactly that reason, on a live
    /// run whose `tool_called` was already `false`. This pins the fix
    /// (normalizing both curly-quote characters before matching) against
    /// the literal text that live run returned.
    #[test]
    fn claims_no_journal_access_normalizes_the_curly_apostrophes_the_live_model_actually_writes() {
        assert!(claims_no_journal_access(
            "I can\u{2019}t access your journal entries in this chat, so I can\u{2019}t tell \
             how your knee has been doing."
        ));
        assert!(claims_no_journal_access(
            "I\u{2019}m unable to retrieve your journal entries in this chat."
        ));
    }

    /// The other side of the same heuristic: an ordinary Answer, grounded or
    /// not, and a reply that correctly decided no tool was needed at all,
    /// must never be mistaken for the denial above — `run_reflect_stream_inner`'s
    /// own corrective-turn gate would otherwise pay an extra chat call for a
    /// reply that was never wrong (see that gate's own doc comment on why
    /// this distinction has to hold, and `a_prose_only_reply_is_the_answer_with_no_grounding`
    /// in `tests/reflect.rs` for the end-to-end version of this same
    /// property).
    #[test]
    fn claims_no_journal_access_leaves_ordinary_replies_alone() {
        assert!(!claims_no_journal_access(
            "Your knee has improved since February."
        ));
        assert!(!claims_no_journal_access(
            "You haven't written about that yet."
        ));
        assert!(!claims_no_journal_access("No tools needed for that."));
    }

    /// The structural half of issue #102's acceptance criteria: the single
    /// constructor `run_reflect_stream_inner` routes every model reply
    /// through before it can become `ReflectResponse::answer` rejects every
    /// shape `is_empty_final_reply` recognises as nothing to say, and
    /// accepts everything else. There is no second path to a
    /// `NonEmptyAnswer` that skips this check.
    #[test]
    fn non_empty_answer_rejects_every_shape_of_nothing_to_say_and_accepts_real_text() {
        for empty in ["", "   \n  ", "```\n```", "</tool_call>"] {
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
