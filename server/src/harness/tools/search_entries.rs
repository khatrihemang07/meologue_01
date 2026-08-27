//! `search_entries` — issue #94's word-search tool. Wraps
//! `reflect::search_words` (English stemming via `websearch_to_tsquery`,
//! falling back to `pg_trgm` word similarity when that finds nothing —
//! see that function's own doc comment, and migration
//! `0007_add_entries_word_search.sql`, for the index and the reasoning
//! behind the two-step query) the same way `EntriesInRangeTool` wraps
//! `reflect::retrieve_range`: this file owns pagination and rendering, the
//! query itself lives in `reflect.rs` so `tests/eval_retrieval.rs`'s
//! word-search arm (issue #100) can call it directly without going through
//! the harness.
//!
//! Pagination is copied from `entries_in_range.rs` deliberately, not
//! shared through an extracted helper: `search_words` has no natural
//! "total that matched" independent of `limit` the way `retrieve_range`
//! does either (Postgres doesn't report "rows that would have matched
//! beyond `LIMIT`" any more than the date-range query does), so the same
//! trick applies — ask for everything (`i64::MAX`), then slice the full,
//! ranked result in memory. See `entries_in_range.rs`'s own doc comment for
//! why that limit is safe at this dataset's scale, and for the
//! continuation-notice contract this tool's tests re-verify independently
//! (a truncated page names the exact next `offset`; a complete page says
//! nothing at all).

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::reflect::{GroundingEntry, search_words};
use sqlx::PgPool;

use super::{AgentTool, ToolOutcome};

/// See `entries_in_range.rs::DEFAULT_PAGE_SIZE` — same value, same
/// reasoning (a small default page keeps one turn cheap; the model can
/// always page further), kept as this tool's own constant rather than a
/// shared one so each tool's pagination tuning stays independently
/// adjustable, the same way each tool owns its own prompt contribution.
pub const DEFAULT_PAGE_SIZE: i64 = 20;

/// See `entries_in_range.rs::MAX_PAGE_SIZE`.
pub const MAX_PAGE_SIZE: i64 = 100;

/// See `entries_in_range.rs::CONTENT_CHAR_BUDGET`.
pub const CONTENT_CHAR_BUDGET: usize = 8_000;

/// `search_entries(query, limit?, offset?)` — the tool itself. Holds a
/// `PgPool` only; unlike `SimilarEntriesTool`, word search makes no
/// network call and needs no embedding client at all.
pub struct SearchEntriesTool {
    pool: PgPool,
}

impl SearchEntriesTool {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AgentTool for SearchEntriesTool {
    fn name(&self) -> &str {
        "search_entries"
    }

    fn description(&self) -> &str {
        "Finds journal Entries containing the given words, ranked most-relevant first. \
         Tolerates a word written in a different form (e.g. \"run\" matches an Entry that only \
         says \"running\") and, if nothing matches at all, a small misspelling. Results are \
         paginated — pass the offset a truncated page names to keep reading."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The word or short phrase to search Entry bodies for.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max Entries to return in this page (default 20, capped at 100).",
                },
                "offset": {
                    "type": "integer",
                    "description": "How many matching Entries, most-relevant first, to skip before this page starts (default 0).",
                },
            },
            "required": ["query"],
        })
    }

    fn snippet(&self) -> &str {
        "search_entries(query, limit?, offset?) — finds journal Entries containing given words, \
         most-relevant first. Use this for a Question about specific words or phrasing, distinct \
         from similar_entries below, which searches by meaning instead."
    }

    fn guidelines(&self) -> Option<&str> {
        Some(
            "A page ends with a bracketed note naming the exact offset to call next when there's \
             more to see; no such note means every matching Entry has already been shown. If this \
             comes back empty, try similar_entries instead — the two fail on different kinds of \
             Question, and either can find what the other misses.",
        )
    }

    async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String> {
        let query = parse_required_query(&arguments)?;
        let limit = parse_optional_i64(&arguments, "limit")
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        let offset = parse_optional_i64(&arguments, "offset").unwrap_or(0).max(0);

        let entries = search_words(&self.pool, query, i64::MAX)
            .await
            .map_err(|err| format!("searching Entries failed: {err}"))?;

        let total = entries.len();
        if total == 0 {
            return Ok(ToolOutcome::new(format!("No Entries matched {query:?}.")));
        }

        let window: Vec<&GroundingEntry> = entries.iter().skip(offset as usize).collect();
        if window.is_empty() {
            return Ok(ToolOutcome::new(format!(
                "offset={offset} is past the end: only {total} Entries matched {query:?} in \
                 total."
            )));
        }

        // Same one-Entry-always-included exception as `entries_in_range`'s
        // own loop — see that module's doc comment for why.
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
            // this module's own doc comment and `entries_in_range.rs`'s.
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
    use chrono::{DateTime, Duration, Utc};
    use sqlx::PgPool;
    use uuid::Uuid;

    use super::*;

    async fn insert_entry_at(pool: &PgPool, body: &str, created_at: DateTime<Utc>) {
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
        chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
    }

    #[sqlx::test]
    async fn no_match_gets_plain_empty_wording(pool: PgPool) {
        insert_entry_at(
            &pool,
            "Uneventful evening, tea and a book.",
            day(2026, 3, 10),
        )
        .await;

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool.execute(json!({"query": "aardvark"})).await.unwrap();
        assert!(outcome.content.contains("No Entries matched"));
        assert!(outcome.entry_ids.is_empty());
        assert!(!outcome.content.contains("Showing"));
    }

    /// The stemming half of the acceptance criteria: the body only ever
    /// says "running", the query says "run" — `websearch_to_tsquery`'s
    /// English stemming is what bridges the two without either side
    /// spelling out every inflected form by hand.
    #[sqlx::test]
    async fn a_differing_word_form_is_found_via_stemming(pool: PgPool) {
        insert_entry_at(
            &pool,
            "Went running by the river this morning.",
            day(2026, 3, 10),
        )
        .await;

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool.execute(json!({"query": "run"})).await.unwrap();

        assert!(
            outcome.content.contains("running by the river"),
            "stemming should have matched \"run\" against \"running\": {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 1);
    }

    /// The misspelling half: the body says "physio", the query is
    /// deliberately misspelled — no stem in common, so this only succeeds
    /// through the trigram fallback.
    #[sqlx::test]
    async fn a_small_misspelling_is_found_via_the_trigram_fallback(pool: PgPool) {
        insert_entry_at(
            &pool,
            "First physio appointment today, went well.",
            day(2026, 3, 10),
        )
        .await;

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool.execute(json!({"query": "phyiso"})).await.unwrap();

        assert!(
            outcome.content.contains("physio appointment"),
            "the trigram fallback should have matched \"phyiso\" against \"physio\": {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 1);
    }

    /// A query that legitimately matches nothing — no shared stem, and not
    /// close enough by trigram similarity either.
    #[sqlx::test]
    async fn a_query_matching_nothing_stays_empty_through_both_paths(pool: PgPool) {
        insert_entry_at(
            &pool,
            "Finished the book, made a cup of tea, went to bed.",
            day(2026, 3, 10),
        )
        .await;

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool
            .execute(json!({"query": "xenotransplantation"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("No Entries matched"));
        assert!(outcome.entry_ids.is_empty());
    }

    #[sqlx::test]
    async fn a_complete_page_has_no_continuation_notice(pool: PgPool) {
        insert_entry_at(&pool, "Wrote about the wedding today.", day(2026, 3, 10)).await;
        insert_entry_at(
            &pool,
            "More wedding planning, dress fitting.",
            day(2026, 3, 11),
        )
        .await;

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool.execute(json!({"query": "wedding"})).await.unwrap();

        assert!(
            !outcome.content.contains("Showing"),
            "a complete page must say nothing at all about pagination: {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 2);
    }

    #[sqlx::test]
    async fn a_truncated_page_names_the_exact_next_offset(pool: PgPool) {
        let base = day(2026, 3, 1);
        for i in 0..25 {
            insert_entry_at(
                &pool,
                &format!("wedding entry number {i}"),
                base + Duration::hours(i),
            )
            .await;
        }

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool.execute(json!({"query": "wedding"})).await.unwrap();

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
        let base = day(2026, 3, 1);
        for i in 0..25 {
            insert_entry_at(
                &pool,
                &format!("wedding entry number {i}"),
                base + Duration::hours(i),
            )
            .await;
        }

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool
            .execute(json!({"query": "wedding", "offset": 20}))
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
        insert_entry_at(&pool, "Only one wedding entry.", day(2026, 3, 10)).await;

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool
            .execute(json!({"query": "wedding", "offset": 5}))
            .await
            .unwrap();

        assert!(outcome.content.contains("past the end"));
        assert!(outcome.entry_ids.is_empty());
    }

    #[sqlx::test]
    async fn limit_is_clamped_to_the_hard_cap(pool: PgPool) {
        let base = day(2026, 3, 1);
        for i in 0..150 {
            insert_entry_at(
                &pool,
                &format!("wedding entry number {i}"),
                base + Duration::hours(i),
            )
            .await;
        }

        let tool = SearchEntriesTool::new(pool);
        let outcome = tool
            .execute(json!({"query": "wedding", "limit": 500}))
            .await
            .unwrap();

        assert_eq!(outcome.entry_ids.len(), MAX_PAGE_SIZE as usize);
    }

    #[sqlx::test]
    async fn a_missing_query_is_an_error_result(pool: PgPool) {
        let tool = SearchEntriesTool::new(pool);
        let err = tool.execute(json!({})).await.unwrap_err();
        assert!(err.contains("query"));
    }

    #[sqlx::test]
    async fn a_blank_query_is_an_error_result(pool: PgPool) {
        let tool = SearchEntriesTool::new(pool);
        let err = tool.execute(json!({"query": "   "})).await.unwrap_err();
        assert!(err.contains("query"));
    }
}
