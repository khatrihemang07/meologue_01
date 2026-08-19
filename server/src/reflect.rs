//! `POST /v1/reflect` — ticket 4, the first place a Question becomes an
//! Answer. Stateless on the server: the whole Conversation the client knows
//! about round-trips as `prior_turns` on every request, matching ADR 0020's
//! "a Conversation ... belongs to the Device it happened on and does not
//! Sync" — there is nothing here to persist between calls.
//!
//! Retrieval in this ticket is vector search on the Question alone (ticket
//! 5 adds a date-range retriever and an LLM extraction call on top of this;
//! ticket 6 adds a disclosed fallback when nothing is found). See
//! CONTEXT.md's Grounding entry for the rule this route exists to honour: an
//! Answer with nothing behind it says so, rather than inventing a past the
//! user didn't live.

use std::sync::Arc;

use anyhow::Context as _;
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::embedding::vector_literal;
use crate::llm::{ChatMessage, LlmClient};
use crate::sync::PROTOCOL_VERSION;

/// How many nearest Entries retrieval pulls before handing them to the chat
/// call, mirroring the shape `docs/adr/0022` already settled for writes:
/// bind the vector as a formatted `::vector` string, no `pgvector` crate.
/// 40 is generous for a personal-scale History — the chat call, not this
/// query, is what should decide whether an Entry was actually relevant.
pub const RETRIEVAL_LIMIT: i64 = 40;

/// Cosine similarity an Entry must reach to count as Grounding.
///
/// Without a floor, a nearest-neighbour search always returns
/// `RETRIEVAL_LIMIT` rows no matter how unrelated they are — so `grounded`
/// would be true for every Question a non-empty History ever receives, and
/// CONTEXT.md's rule that "an Answer with no Grounding behind it says so
/// plainly" would be unenforceable: there would be no such thing as no
/// Grounding.
///
/// 0.60 is measured against this corpus, not guessed. Questions with a real
/// thread behind them ("how has my knee been", "what happened with the
/// Aurora migration") clear it with 5-7 Entries each; a question about
/// something never written down ("scuba diving in Portugal") clears it with
/// none, while a 0.55 floor still admitted four unrelated Entries. Harrier's
/// vectors are L2-normalised (ADR 0022), so `1 - (a <=> b)` is exactly
/// cosine similarity and this number is directly comparable.
pub const MIN_SIMILARITY: f64 = 0.60;

/// One already-answered Question in the Conversation, as the client sends
/// it back on every follow-up — see `ReflectRequest::prior_turns`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PriorTurn {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReflectRequest {
    pub protocol_version: i32,
    pub question: String,
    /// Every prior Question and Answer in this Conversation, oldest first.
    /// Empty on the first Question. The server holds no Conversation state
    /// of its own (see module docs), so this is the only way a follow-up
    /// Question is read "in the light of the Conversation before it"
    /// (CONTEXT.md's own phrase for what a Conversation is).
    pub prior_turns: Vec<PriorTurn>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReflectResponse {
    pub answer: String,
    /// The ids of the Entries retrieval found and handed to the chat call,
    /// in the order they were shown to it (chronological — see
    /// `chronological_order` below). Ticket 7 is what builds an expandable
    /// disclosure UI on top of these ids; this ticket only returns them.
    pub grounding_entry_ids: Vec<Uuid>,
    /// Whether any Grounding was found at all. In this ticket that's
    /// exactly "retrieval returned at least one Entry" — with 85 embedded
    /// Entries in the seeded journal this is `true` in ordinary operation,
    /// and only `false` on a History with literally zero embedded Entries.
    /// This is a coarser signal than "the model believes it answered the
    /// Question" on purpose: ticket 6 is what adds a real relevance
    /// judgment (the disclosed fallback), and inventing that distinction
    /// early would be building ahead of the ticket that actually needs it.
    pub grounded: bool,
}

#[derive(Debug, FromRow)]
struct GroundingEntry {
    id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
}

/// Reflection's server-side dependencies, held in `AppState` only when both
/// are configured (`llm::LlmConfig::reflect_config`) — see `lib.rs` for why
/// that's what decides whether `/v1/reflect` is registered at all.
#[derive(Clone)]
pub struct ReflectState {
    pub chat_client: Arc<dyn LlmClient + Send + Sync>,
    pub embed_client: Arc<dyn LlmClient + Send + Sync>,
}

const SYSTEM_INSTRUCTION: &str = "You are Reflection, part of meologue, a personal journal. \
A user is asking a Question about their own journal Entries. Below, under \"Grounding\", are the \
journal Entries retrieval found most relevant to the Question, each labelled with the date it was \
written. Answer the Question using only what these Entries say. If the Entries don't contain \
enough to answer the Question, say so plainly instead of guessing or inventing anything — a \
Reflection that invents a past the user did not live is worse than one that admits it found \
nothing. Speak directly to the user in the second person, in a few sentences of plain prose.";

#[utoipa::path(
    post,
    path = "/v1/reflect",
    request_body = ReflectRequest,
    responses(
        (status = 200, description = "An Answer grounded in the Entries nearest the Question", body = ReflectResponse),
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
        tracing::error!("reflect_handler invoked with no ReflectState — route should not be registered");
        return Err(StatusCode::NOT_FOUND);
    };

    run_reflect(&pool, &reflect, req).await.map(Json).map_err(|err| {
        tracing::error!(error = ?err, "reflect failed");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

async fn run_reflect(pool: &PgPool, reflect: &ReflectState, req: ReflectRequest) -> anyhow::Result<ReflectResponse> {
    // The *query* embedding, not `embed_document` — Harrier's instruction
    // wrapper is what widens the relevant-vs-irrelevant margin for text used
    // to search, per `llm.rs`'s own doc comment on the trait method.
    let query_vector = reflect
        .embed_client
        .embed_query(&req.question)
        .await
        .context("embedding the question failed")?;

    let mut entries = retrieve_nearest(pool, &query_vector, RETRIEVAL_LIMIT).await?;
    // Retrieval order is by similarity; reading order for the prompt should
    // be by time, so the model sees the user's history unfold the way the
    // user lived it rather than in a relevance-shuffled order.
    entries.sort_by_key(|entry| entry.created_at);

    let grounding_entry_ids: Vec<Uuid> = entries.iter().map(|entry| entry.id).collect();
    let grounded = !entries.is_empty();

    let messages = build_messages(&entries, &req.prior_turns, &req.question);
    let answer = reflect.chat_client.chat(&messages).await.context("chat call failed")?;

    Ok(ReflectResponse { answer, grounding_entry_ids, grounded })
}

async fn retrieve_nearest(pool: &PgPool, query_vector: &[f32], limit: i64) -> anyhow::Result<Vec<GroundingEntry>> {
    // `embedding is not null` is the same "skip what the background worker
    // hasn't gotten to yet" guard `embedding.rs`'s scan uses on the write
    // side (ADR 0022) — a row with no vector can't be compared with `<=>`.
    let rows = sqlx::query_as::<_, GroundingEntry>(
        "select id, body, created_at from entries
         where embedding is not null
           and 1 - (embedding <=> $1::vector) >= $3
         order by embedding <=> $1::vector
         limit $2",
    )
    .bind(vector_literal(query_vector))
    .bind(limit)
    .bind(MIN_SIMILARITY)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

fn build_messages(entries: &[GroundingEntry], prior_turns: &[PriorTurn], question: &str) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: SYSTEM_INSTRUCTION.to_string(),
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
