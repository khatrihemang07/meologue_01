//! `similar_entries` — issue #94's semantic-search tool. Wraps
//! `reflect::retrieve_nearest`, which since issue #92 carries no
//! similarity floor at all: it returns its top-`limit` rows by cosine
//! distance unconditionally, and the relevance judgment moved to the
//! answering call (`docs/adr/0024`). This tool inherits that shape
//! directly — "returning its best results with no threshold" (the ticket's
//! own words) means there is nothing here for `similar_entries` to filter
//! on either; every candidate `retrieve_nearest` finds is handed back,
//! ranked, for the model itself to judge.
//!
//! Unlike `search_entries` and `entries_in_range`, this tool makes a real
//! network call before it can query anything at all: `retrieve_nearest`
//! needs a query *vector*, not query text, so `execute` embeds `query`
//! through `embed_client.embed_query` first. That call can fail — Ollama
//! down, a timeout, a malformed response — and issue #94 is explicit that
//! such a failure "must become an `is_error` tool result the model can
//! recover from, never a failed Question." `AgentTool::execute`'s own
//! contract already gives this for free: returning `Err(String)` here (see
//! `AgentTool`'s doc comment) is exactly what `agent_loop` turns into an
//! ordinary `is_error: true` tool result, so no special-casing is needed
//! beyond mapping the embedding failure to a `String` the model can read
//! and try something else (`search_entries`, most likely) after.
//!
//! Pagination follows `entries_in_range.rs`/`search_entries.rs`'s own
//! pattern: `retrieve_nearest` is called once with `i64::MAX`, giving the
//! full cosine-ranked candidate set, then sliced in memory the same way —
//! see those modules' doc comments for why that's the right trade at this
//! dataset's scale, and for the continuation-notice contract this tool's
//! tests re-verify independently.

use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::llm::LlmClient;
use crate::reflect::{GroundingEntry, retrieve_nearest};
use sqlx::PgPool;

use super::{AgentTool, ToolOutcome};

/// See `entries_in_range.rs::DEFAULT_PAGE_SIZE` — same value, same
/// reasoning, kept as this tool's own constant for the same reason
/// `search_entries.rs` keeps its own copy rather than sharing one.
pub const DEFAULT_PAGE_SIZE: i64 = 20;

/// See `entries_in_range.rs::MAX_PAGE_SIZE`.
pub const MAX_PAGE_SIZE: i64 = 100;

/// See `entries_in_range.rs::CONTENT_CHAR_BUDGET`.
pub const CONTENT_CHAR_BUDGET: usize = 8_000;

/// `similar_entries(query, limit?, offset?)` — the tool itself. Holds a
/// `PgPool` and the embedding client `ReflectState.embed_client` already
/// carries, both fixed for the lifetime of one `/v1/reflect` request, the
/// same shape `EntriesInRangeTool` holds its own fixed dependencies in.
pub struct SimilarEntriesTool {
    pool: PgPool,
    embed_client: Arc<dyn LlmClient + Send + Sync>,
}

impl SimilarEntriesTool {
    pub fn new(pool: PgPool, embed_client: Arc<dyn LlmClient + Send + Sync>) -> Self {
        Self { pool, embed_client }
    }
}

#[async_trait]
impl AgentTool for SimilarEntriesTool {
    fn name(&self) -> &str {
        "similar_entries"
    }

    fn description(&self) -> &str {
        "Finds journal Entries whose meaning is closest to the query, ranked most-similar first \
         — useful when the Question is about a topic or feeling rather than specific words. \
         Returns its best matches with no relevance cutoff, so a low-similarity result can still \
         appear; judge for yourself whether it actually answers the Question. Results are \
         paginated — pass the offset a truncated page names to keep reading."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for, in plain language — a topic, question or description of what you're looking for.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max Entries to return in this page (default 20, capped at 100).",
                },
                "offset": {
                    "type": "integer",
                    "description": "How many matching Entries, most-similar first, to skip before this page starts (default 0).",
                },
            },
            "required": ["query"],
        })
    }

    fn snippet(&self) -> &str {
        "similar_entries(query, limit?, offset?) — finds journal Entries closest in meaning to \
         the query, most-similar first. Use this for a Question about a topic or feeling, \
         distinct from search_entries above, which searches by specific words instead."
    }

    fn guidelines(&self) -> Option<&str> {
        Some(
            "A page ends with a bracketed note naming the exact offset to call next when there's \
             more to see; no such note means every candidate has already been shown. There is no \
             relevance cutoff, so judge each result on its own merits rather than assuming every \
             one actually answers the Question. If this comes back with nothing useful, try \
             search_entries instead — the two fail on different kinds of Question.",
        )
    }

    async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String> {
        let query = parse_required_query(&arguments)?;
        let limit = parse_optional_i64(&arguments, "limit")
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        let offset = parse_optional_i64(&arguments, "offset").unwrap_or(0).max(0);

        let vector = self.embed_client.embed_query(query).await.map_err(|err| {
            format!("embedding the search text failed, so similar_entries could not run: {err:#}")
        })?;

        let entries = retrieve_nearest(&self.pool, &vector, i64::MAX)
            .await
            .map_err(|err| format!("searching Entries by meaning failed: {err}"))?;

        let total = entries.len();
        if total == 0 {
            return Ok(ToolOutcome::new(
                "No Entries have been embedded yet, so nothing could be compared against the \
                 query."
                    .to_string(),
            ));
        }

        let window: Vec<&GroundingEntry> = entries.iter().skip(offset as usize).collect();
        if window.is_empty() {
            return Ok(ToolOutcome::new(format!(
                "offset={offset} is past the end: only {total} Entries were compared against \
                 the query in total."
            )));
        }

        // Same one-Entry-always-included exception as `entries_in_range`'s
        // and `search_entries`'s own loops — see those modules' doc
        // comments for why.
        let mut shown: Vec<(&GroundingEntry, String)> = Vec::new();
        let mut char_count = 0usize;
        for entry in window.iter().take(limit as usize) {
            let rendered = format!("[{}] {}", entry.created_at.format("%Y-%m-%d"), entry.body);
            let next_count = char_count + rendered.chars().count();
            if !shown.is_empty() && next_count > CONTENT_CHAR_BUDGET {
                break;
            }
            char_count = next_count;
            shown.push((entry, rendered));
        }

        let shown_count = shown.len() as i64;
        let body = shown
            .iter()
            .map(|(_, rendered)| rendered.clone())
            .collect::<Vec<_>>()
            .join("\n\n");

        let start = offset + 1;
        let end = offset + shown_count;
        let content = if end < total as i64 {
            format!(
                "{body}\n\n[Showing {start}-{end} of {total}. Use offset={next} to continue.]",
                next = end + 1
            )
        } else {
            // Complete: nothing appended after the Entries at all — see
            // `entries_in_range.rs`'s doc comment for why silence is the
            // signal.
            body
        };

        let entries_detail: Vec<Value> = shown
            .iter()
            .map(|(entry, _)| {
                json!({
                    "id": entry.id,
                    "created_at": entry.created_at,
                    "body": entry.body,
                })
            })
            .collect();
        let entry_ids = shown.iter().map(|(entry, _)| entry.id).collect();

        let details = json!({
            "query": query,
            "total": total,
            "offset": offset,
            "shown": shown_count,
            "entries": entries_detail,
        });

        Ok(ToolOutcome::new(content)
            .with_details(details)
            .with_entry_ids(entry_ids))
    }
}

fn parse_required_query(arguments: &Value) -> Result<&str, String> {
    let raw = arguments
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| "`query` is required and must be a non-empty string.".to_string())?;
    if raw.trim().is_empty() {
        return Err("`query` is required and must be a non-empty string.".to_string());
    }
    Ok(raw)
}

fn parse_optional_i64(arguments: &Value, field: &str) -> Option<i64> {
    arguments.get(field).and_then(Value::as_i64)
}

#[cfg(test)]
mod tests {
    use anyhow::bail;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use sqlx::PgPool;
    use uuid::Uuid;

    use crate::llm::ChatMessage;

    use super::*;

    /// A deterministic, no-network `LlmClient` double: `embed_query`
    /// either returns a fixed vector or fails outright, per `behavior` —
    /// the same shape `tests/embedding.rs::FakeLlmClient` already
    /// establishes for the write-side worker, mirrored here for the
    /// read-side tool.
    struct FakeEmbedClient {
        behavior: FakeBehavior,
    }

    enum FakeBehavior {
        AlwaysSucceed,
        AlwaysFail,
    }

    #[async_trait]
    impl LlmClient for FakeEmbedClient {
        async fn chat(&self, _messages: &[ChatMessage]) -> anyhow::Result<String> {
            unimplemented!("similar_entries never calls chat")
        }

        async fn embed_document(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
            unimplemented!("similar_entries only ever calls embed_query")
        }

        async fn embed_query(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
            match self.behavior {
                FakeBehavior::AlwaysSucceed => Ok(vec![0.1_f32; 640]),
                FakeBehavior::AlwaysFail => {
                    bail!("simulated connection refused talking to Ollama")
                }
            }
        }
    }

    async fn insert_embedded_entry(pool: &PgPool, body: &str, created_at: DateTime<Utc>) {
        sqlx::query(
            "insert into entries (id, device_id, body, created_at, embedding, embedding_model)
             values ($1, $2, $3, $4, $5::vector, 'test-model')",
        )
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(body)
        .bind(created_at)
        .bind(crate::embedding::vector_literal(&[0.1_f32; 640]))
        .execute(pool)
        .await
        .unwrap();
    }

    fn day(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
    }

    fn succeeding_client() -> Arc<dyn LlmClient + Send + Sync> {
        Arc::new(FakeEmbedClient {
            behavior: FakeBehavior::AlwaysSucceed,
        })
    }

    fn failing_client() -> Arc<dyn LlmClient + Send + Sync> {
        Arc::new(FakeEmbedClient {
            behavior: FakeBehavior::AlwaysFail,
        })
    }

    /// The acceptance criterion issue #94 names directly: an embedding
    /// failure must surface as a recoverable tool result, never fail the
    /// whole Question outright — `AgentTool::execute`'s `Err(String)`
    /// contract is what `agent_loop` (issue #93) turns into an ordinary
    /// `is_error: true` tool result the model reads and can try something
    /// else after, so this test only needs to confirm `execute` itself
    /// returns `Err`, not panic or a misleading `Ok`.
    #[sqlx::test]
    async fn an_embedding_failure_is_a_recoverable_error_result(pool: PgPool) {
        let tool = SimilarEntriesTool::new(pool, failing_client());
        let err = tool
            .execute(json!({"query": "how was my trip to Japan"}))
            .await
            .unwrap_err();
        assert!(
            err.contains("embedding"),
            "the error should say plainly that embedding failed: {err}"
        );
    }

    #[sqlx::test]
    async fn no_embedded_entries_gets_plain_empty_wording(pool: PgPool) {
        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let outcome = tool.execute(json!({"query": "anything"})).await.unwrap();
        assert!(outcome.content.contains("No Entries have been embedded"));
        assert!(outcome.entry_ids.is_empty());
        assert!(!outcome.content.contains("Showing"));
    }

    #[sqlx::test]
    async fn a_complete_page_has_no_continuation_notice(pool: PgPool) {
        insert_embedded_entry(&pool, "one", day(2026, 3, 10)).await;
        insert_embedded_entry(&pool, "two", day(2026, 3, 11)).await;

        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let outcome = tool.execute(json!({"query": "anything"})).await.unwrap();

        assert!(
            !outcome.content.contains("Showing"),
            "a complete page must say nothing at all about pagination: {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 2);
    }

    #[sqlx::test]
    async fn a_truncated_page_names_the_exact_next_offset(pool: PgPool) {
        for i in 0..25 {
            insert_embedded_entry(&pool, &format!("entry {i}"), day(2026, 3, 1 + i as u32)).await;
        }

        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let outcome = tool.execute(json!({"query": "anything"})).await.unwrap();

        assert!(
            outcome
                .content
                .contains("[Showing 1-20 of 25. Use offset=21 to continue.]"),
            "{}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), DEFAULT_PAGE_SIZE as usize);
    }

    #[sqlx::test]
    async fn offset_continues_where_the_previous_page_left_off(pool: PgPool) {
        for i in 0..25 {
            insert_embedded_entry(&pool, &format!("entry {i}"), day(2026, 3, 1 + i as u32)).await;
        }

        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let outcome = tool
            .execute(json!({"query": "anything", "offset": 20}))
            .await
            .unwrap();

        assert!(
            !outcome.content.contains("Showing"),
            "the remaining 5 fit in one page: {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 5);
    }

    #[sqlx::test]
    async fn an_offset_past_the_end_is_reported_plainly(pool: PgPool) {
        insert_embedded_entry(&pool, "only one", day(2026, 3, 10)).await;

        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let outcome = tool
            .execute(json!({"query": "anything", "offset": 5}))
            .await
            .unwrap();

        assert!(outcome.content.contains("past the end"));
        assert!(outcome.entry_ids.is_empty());
    }

    #[sqlx::test]
    async fn limit_is_clamped_to_the_hard_cap(pool: PgPool) {
        for i in 0..150 {
            let day_of_month = 1 + (i % 28);
            insert_embedded_entry(
                &pool,
                &format!("entry {i}"),
                day(2026, 1 + (i / 28) as u32, day_of_month as u32),
            )
            .await;
        }

        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let outcome = tool
            .execute(json!({"query": "anything", "limit": 500}))
            .await
            .unwrap();

        assert_eq!(outcome.entry_ids.len(), MAX_PAGE_SIZE as usize);
    }

    #[sqlx::test]
    async fn a_missing_query_is_an_error_result(pool: PgPool) {
        let tool = SimilarEntriesTool::new(pool, succeeding_client());
        let err = tool.execute(json!({})).await.unwrap_err();
        assert!(err.contains("query"));
    }
}
