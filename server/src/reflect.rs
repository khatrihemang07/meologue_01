//! `POST /v1/reflect` — ticket 4 made a Question become an Answer with a
//! single vector search; ticket 5 widened retrieval into the fixed
//! three-source fan-out `docs/adr/0023` settles: an extraction chat call
//! finds a date range and/or a keyword hiding in the Question, three
//! retrievals run concurrently, and the results are merged, deduped, capped
//! and reordered before the second chat call turns them into an Answer.
//! Ticket 6 (`docs/adr/0024`) made that second chat call *judge* whether
//! the Grounding it was given actually answers the Question, and added the
//! disclosed fallback (the last few days of Entries, shown but not claimed
//! as an Answer) for when it doesn't.
//!
//! The Server holds the Conversation now (`docs/adr/0025`), superseding ADR
//! 0020's "a Conversation ... belongs to the Device it happened on and does
//! not Sync." A request names the Session it belongs to with `session_id`
//! — `None` starts a new one — instead of round-tripping every prior
//! Question and Answer on every call. `run_reflect` loads that Session's
//! Turns (`sessions::load_turns`) before asking, and persists the new one
//! (`sessions::record_turn`) only once an Answer has actually succeeded, so
//! a failed ask leaves neither a Session nor a Turn behind.
//!
//! Issue #66: the extraction chat call now reads that same windowed
//! Conversation too, not just the bare new Question — a follow-up like
//! "and the week before that?" has no antecedent for "that" without it. See
//! `extraction_system_prompt` for how the Conversation is folded in without
//! risking the JSON-only contract that call depends on.
//!
//! See CONTEXT.md's Grounding entry for the rule this route exists to
//! honour: an Answer with nothing behind it says so, rather than inventing
//! a past the user didn't live.

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
use crate::llm::{ChatMessage, LlmClient};
use crate::sessions::{self, NewTurn, SessionTurnRow};
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
    /// The ids of the Entries the Answer was actually built from, in the
    /// order they were shown to the chat call (chronological — see
    /// `run_reflect`'s `merged.sort_by_key`).
    ///
    /// In the normal case these are Grounding: the merged three-source
    /// fan-out (`docs/adr/0023`), judged (`grounded`, below) to actually
    /// answer the Question. In the disclosed-fallback case
    /// (`fallback_used: true`) these are instead the last few days of
    /// Entries (`docs/adr/0024`) — shown despite *not* answering the
    /// Question, because CONTEXT.md's Grounding entry holds that admitting
    /// nothing was found beats inventing an Answer from somewhere else.
    /// `grounded: false` is what tells a reader — ticket 7's disclosure UI
    /// included — that these ids are not relevant matches; this field alone
    /// (non-empty or not) cannot tell the two cases apart.
    pub grounding_entry_ids: Vec<Uuid>,
    /// Whether Reflection judged that the Grounding it found actually
    /// answers the Question — read off the "GROUNDED: yes"/"GROUNDED: no"
    /// marker the answering chat call is now instructed to begin its reply
    /// with (`SYSTEM_INSTRUCTION`, `parse_and_strip_verdict`), not from
    /// retrieval.
    ///
    /// Through ticket 5 this meant something else entirely: "the merged
    /// fan-out retrieval set (see `run_reflect`) is non-empty." `docs/adr/
    /// 0023` measured why that stopped being a meaningful signal on a
    /// realistic History — on the live 572-Entry corpus, an absent topic
    /// ("my cat", cosine 0.691) can outscore a present one ("the wedding",
    /// 0.638), so the merged set is non-empty for essentially every
    /// Question and the old `grounded` was true almost unconditionally.
    /// `docs/adr/0024` is what moved the judgment onto the chat call
    /// itself, which actually reads what it was given, instead of a cosine
    /// floor that can't tell "relevant" from "large corpus."
    pub grounded: bool,
    /// Whether the disclosed fallback (`docs/adr/0024`) ran: Reflection
    /// judged its Grounding didn't answer the Question (`grounded: false`)
    /// *and* Entries existed in the last few days to show instead. `false`
    /// covers both "the Grounding answered the Question" (`grounded: true`)
    /// and "it didn't, and there was nothing recent to show either" —
    /// `grounded` is what tells those two `false` cases apart.
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

    match run_reflect(&pool, &reflect, req).await {
        Ok(response) => Ok(Json(response)),
        Err(ReflectError::SessionNotFound) => Err(StatusCode::NOT_FOUND),
        Err(ReflectError::Internal(err)) => {
            tracing::error!(error = ?err, "reflect failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

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
        .context("chat call failed")?;
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
                .context("fallback chat call failed")?;
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

/// Converts an inclusive local `[from, to]` calendar-date range into the
/// half-open UTC instant range `retrieve_range` needs: `from` local
/// midnight becomes `from_utc` by subtracting the offset, and `to`'s local
/// *next* day midnight becomes `to_utc` the same way — so `[from_utc,
/// to_utc)` covers every instant of every local day from `from` through
/// `to` inclusive, and a single-day range (`from == to`) covers exactly
/// that one whole local day.
fn local_date_range_to_utc(
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
        .context("extraction chat call failed")?;
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
    use chrono::NaiveDate;

    use super::{
        TITLE_MAX_CHARS, derive_title, extract_json_object, keyword_query, local_date_range_to_utc,
        local_today, parse_and_strip_verdict, parse_extraction, strip_code_fences,
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
}
