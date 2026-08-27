//! `entries_in_range` — the one tool issue #93 pass 2 ships. Finds Entries
//! written within an inclusive local calendar-date range, oldest first,
//! paginated. Reuses `reflect::retrieve_range` (already `pub`) and
//! `reflect::local_date_range_to_utc` (made `pub(crate)` for this) rather
//! than writing a second query or a second local-date conversion — a date
//! range is resolved against the asking Device's own local day exactly the
//! way the old extraction pipeline resolved its extracted range, for
//! exactly the same reason (`local_date_range_to_utc`'s own doc comment).
//!
//! Pagination is the part worth reading closely: a page ends at whichever
//! of three limits is hit first — `DEFAULT_PAGE_SIZE` unless the model asks
//! for more, `MAX_PAGE_SIZE` regardless of what it asks for, or
//! `CONTENT_CHAR_BUDGET` if the Entries themselves are long enough to hit
//! it first. A truncated page's `content` ends with a bracketed note naming
//! the *exact* next call (`[Showing 1-20 of 47. Use offset=21 to
//! continue.]`); a complete page adds nothing after the Entries at all —
//! silence is how the model knows it has everything, so the absence of that
//! note is load-bearing, not an oversight (see the tests below that assert
//! it explicitly).

use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::{Value, json};

use crate::reflect::{GroundingEntry, local_date_range_to_utc, retrieve_range};
use sqlx::PgPool;

use super::{AgentTool, ToolOutcome, render_entry};

/// How many Entries a page holds unless the model asks for more —
/// `reflect.rs`'s own retrieval limits (`RETRIEVAL_LIMIT`) are a comparable
/// order of magnitude, but this one is deliberately smaller: this tool can
/// be called again, so a small default page keeps any one turn's reply
/// short and cheap, at the cost of more round trips for a genuinely wide
/// range — a trade the fixed pipeline this replaces never had to make,
/// since it only ever got one look.
pub const DEFAULT_PAGE_SIZE: i64 = 20;

/// The hard ceiling on `limit`, regardless of what the model asks for — a
/// runaway `limit` (or one a malformed reply happens to carry) must not be
/// able to make a single tool result unboundedly large.
pub const MAX_PAGE_SIZE: i64 = 100;

/// The character budget a page's rendered `content` will not exceed, unless
/// a single Entry alone is already over budget — see
/// `EntriesInRangeTool::execute`'s pagination loop for how that one
/// guaranteed-at-least-one-Entry exception is handled. Sized generously for
/// a page of `DEFAULT_PAGE_SIZE` ordinary journal Entries while still
/// bounding what a page of unusually long ones can cost.
pub const CONTENT_CHAR_BUDGET: usize = 8_000;

/// `entries_in_range(from, to, limit?, offset?)` — the tool itself. Holds a
/// `PgPool` (cheap to clone; it's already a connection-pool handle) and the
/// asking Device's `utc_offset_minutes`, both fixed for the lifetime of one
/// `/v1/reflect` request — `reflect.rs` constructs a fresh one per request
/// rather than sharing one across requests with different askers.
pub struct EntriesInRangeTool {
    pool: PgPool,
    utc_offset_minutes: i32,
}

impl EntriesInRangeTool {
    pub fn new(pool: PgPool, utc_offset_minutes: i32) -> Self {
        Self {
            pool,
            utc_offset_minutes,
        }
    }
}

#[async_trait]
impl AgentTool for EntriesInRangeTool {
    fn name(&self) -> &str {
        "entries_in_range"
    }

    fn description(&self) -> &str {
        "Finds journal Entries written within an inclusive local calendar-date range, oldest \
         first. Results are paginated — pass the offset a truncated page names to keep reading."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "from": {
                    "type": "string",
                    "description": "Start date, inclusive, as YYYY-MM-DD.",
                },
                "to": {
                    "type": "string",
                    "description": "End date, inclusive, as YYYY-MM-DD.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max Entries to return in this page (default 20, capped at 100).",
                },
                "offset": {
                    "type": "integer",
                    "description": "How many matching Entries, oldest first, to skip before this page starts (default 0).",
                },
            },
            "required": ["from", "to"],
        })
    }

    fn snippet(&self) -> &str {
        "entries_in_range(from, to, limit?, offset?) — finds journal Entries written between two \
         dates (inclusive, YYYY-MM-DD), oldest first."
    }

    fn guidelines(&self) -> Option<&str> {
        Some(
            "A page ends with a bracketed note naming the exact offset to call next when there's \
             more to see; no such note means every matching Entry has already been shown.",
        )
    }

    async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String> {
        let from = parse_required_date(&arguments, "from")?;
        let to = parse_required_date(&arguments, "to")?;
        if to < from {
            return Err(format!(
                "`to` ({to}) is before `from` ({from}) — swap them, or narrow the range."
            ));
        }

        let limit = parse_optional_i64(&arguments, "limit")
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        let offset = parse_optional_i64(&arguments, "offset").unwrap_or(0).max(0);

        let (from_utc, to_utc) = local_date_range_to_utc(from, to, self.utc_offset_minutes);

        // `retrieve_range` orders most-recent-first; this tool reads
        // oldest-first (the order a Conversation is actually lived in, the
        // same call `reflect.rs`'s own `merged.sort_by_key` makes for the
        // fixed pipeline's Grounding) and offsets against that same order,
        // so it's reversed once here rather than asking every caller to
        // account for the reversal itself. `i64::MAX` asks for everything
        // in range — a personal-scale journal's date range never holds
        // enough rows for that to be a real cost, and getting an honest
        // total (the "of 47" in a truncation note) matters more than
        // bounding this one query.
        let mut entries = retrieve_range(&self.pool, from_utc, to_utc, i64::MAX)
            .await
            .map_err(|err| format!("looking up Entries failed: {err}"))?;
        entries.reverse();

        let total = entries.len();
        if total == 0 {
            return Ok(ToolOutcome::new(format!(
                "No Entries were found from {from} to {to}."
            )));
        }

        let window: Vec<&GroundingEntry> = entries.iter().skip(offset as usize).collect();
        if window.is_empty() {
            return Ok(ToolOutcome::new(format!(
                "offset={offset} is past the end: only {total} Entries were found from {from} \
                 to {to} in total."
            )));
        }

        // Stop at whichever of `limit` or `CONTENT_CHAR_BUDGET` is hit
        // first — except the very first Entry in the window is always
        // included even if it alone exceeds the budget, so one unusually
        // long Entry can never produce an empty, stuck page.
        let mut shown: Vec<(&GroundingEntry, String)> = Vec::new();
        let mut char_count = 0usize;
        for entry in window.iter().take(limit as usize) {
            let rendered = render_entry(entry.created_at, &entry.body, self.utc_offset_minutes);
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
            // Complete: nothing appended after the Entries at all. This is
            // the signal, not an omission — see this module's own doc
            // comment.
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
            "from": from.to_string(),
            "to": to.to_string(),
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

fn parse_required_date(arguments: &Value, field: &str) -> Result<NaiveDate, String> {
    let raw = arguments
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{field}` is required and must be a \"YYYY-MM-DD\" string."))?;
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| format!("`{field}` ({raw:?}) is not a valid \"YYYY-MM-DD\" date."))
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
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
    }

    #[sqlx::test]
    async fn no_entries_in_range_gets_plain_empty_wording(pool: PgPool) {
        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-01-01", "to": "2026-01-31"}))
            .await
            .unwrap();
        assert!(outcome.content.contains("No Entries were found"));
        assert!(outcome.entry_ids.is_empty());
        assert!(!outcome.content.contains("Showing"));
    }

    #[sqlx::test]
    async fn a_complete_page_has_no_continuation_notice(pool: PgPool) {
        insert_entry_at(&pool, "one", day(2026, 3, 10)).await;
        insert_entry_at(&pool, "two", day(2026, 3, 10) + Duration::hours(1)).await;

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-10", "to": "2026-03-10"}))
            .await
            .unwrap();

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
            insert_entry_at(&pool, &format!("entry {i}"), base + Duration::hours(i)).await;
        }

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-01", "to": "2026-03-31"}))
            .await
            .unwrap();

        assert!(
            outcome
                .content
                .contains("[Showing 1-20 of 25. Use offset=21 to continue.]")
        );
        assert_eq!(outcome.entry_ids.len(), DEFAULT_PAGE_SIZE as usize);
    }

    #[sqlx::test]
    async fn offset_continues_where_the_previous_page_left_off(pool: PgPool) {
        let base = day(2026, 3, 1);
        for i in 0..25 {
            insert_entry_at(&pool, &format!("entry {i}"), base + Duration::hours(i)).await;
        }

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-01", "to": "2026-03-31", "offset": 20}))
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
        insert_entry_at(&pool, "only one", day(2026, 3, 10)).await;

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-10", "to": "2026-03-10", "offset": 5}))
            .await
            .unwrap();

        assert!(outcome.content.contains("past the end"));
        assert!(outcome.entry_ids.is_empty());
    }

    #[sqlx::test]
    async fn limit_is_clamped_to_the_hard_cap(pool: PgPool) {
        let base = day(2026, 3, 1);
        for i in 0..150 {
            insert_entry_at(&pool, &format!("entry {i}"), base + Duration::hours(i)).await;
        }

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-01", "to": "2026-06-01", "limit": 500}))
            .await
            .unwrap();

        assert_eq!(outcome.entry_ids.len(), MAX_PAGE_SIZE as usize);
    }

    #[sqlx::test]
    async fn a_zero_or_negative_limit_is_clamped_up_to_at_least_one(pool: PgPool) {
        insert_entry_at(&pool, "one", day(2026, 3, 10)).await;
        insert_entry_at(&pool, "two", day(2026, 3, 10) + Duration::hours(1)).await;

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-10", "to": "2026-03-10", "limit": 0}))
            .await
            .unwrap();

        assert_eq!(outcome.entry_ids.len(), 1);
    }

    #[sqlx::test]
    async fn a_reversed_range_is_an_error_result(pool: PgPool) {
        let tool = EntriesInRangeTool::new(pool, 0);
        let err = tool
            .execute(json!({"from": "2026-03-10", "to": "2026-03-01"}))
            .await
            .unwrap_err();
        assert!(err.contains("before"));
    }

    #[sqlx::test]
    async fn a_missing_from_field_is_an_error_result(pool: PgPool) {
        let tool = EntriesInRangeTool::new(pool, 0);
        let err = tool.execute(json!({"to": "2026-03-10"})).await.unwrap_err();
        assert!(err.contains("from"));
    }

    #[sqlx::test]
    async fn an_unparseable_date_is_an_error_result(pool: PgPool) {
        let tool = EntriesInRangeTool::new(pool, 0);
        let err = tool
            .execute(json!({"from": "not-a-date", "to": "2026-03-10"}))
            .await
            .unwrap_err();
        assert!(err.contains("from"));
    }

    #[sqlx::test]
    async fn entries_read_oldest_first(pool: PgPool) {
        insert_entry_at(&pool, "second", day(2026, 3, 10) + Duration::hours(2)).await;
        insert_entry_at(&pool, "first", day(2026, 3, 10)).await;

        let tool = EntriesInRangeTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"from": "2026-03-10", "to": "2026-03-10"}))
            .await
            .unwrap();

        let first_index = outcome.content.find("first").unwrap();
        let second_index = outcome.content.find("second").unwrap();
        assert!(first_index < second_index);
    }

    /// The acceptance criterion that actually pins issue #101's bug: a
    /// range Question must return no Entry labelled outside the range it
    /// asked for. This reproduces the exact case from the issue's live
    /// report — `created_at = 2026-06-30 19:45 UTC` at
    /// `utc_offset_minutes: 330` (IST, east of UTC) is `2026-07-01 01:15`
    /// locally, correctly inside a `2026-07-01..2026-08-31` range asked in
    /// that same local day, and correctly retrieved by
    /// `local_date_range_to_utc`'s window either way — the retrieval was
    /// never the bug. Rendering it must say `[2026-07-01]`, not the UTC
    /// `[2026-06-30]`, which is a date outside the very range that was
    /// asked for and is exactly what a model reading this result would
    /// have grounds to distrust.
    #[sqlx::test]
    async fn a_boundary_entry_east_of_utc_is_labelled_with_its_local_day_not_utc(pool: PgPool) {
        insert_entry_at(
            &pool,
            "physio today",
            day(2026, 6, 30) + Duration::hours(19) + Duration::minutes(45),
        )
        .await;

        let tool = EntriesInRangeTool::new(pool, 330);
        let outcome = tool
            .execute(json!({"from": "2026-07-01", "to": "2026-08-31"}))
            .await
            .unwrap();

        assert!(
            outcome.content.contains("[2026-07-01] physio today"),
            "expected the local day 2026-07-01, got: {}",
            outcome.content
        );
        assert!(
            !outcome.content.contains("[2026-06-30]"),
            "must not render the UTC day, which falls outside the requested range: {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 1);
    }

    /// The direction issue #101 explicitly calls out as the one that gets
    /// forgotten: west of UTC, where an early-morning UTC Entry is still
    /// *yesterday* locally — a genuine day rollback, not merely "no
    /// change" (which offset 0 already covers) or "roll forward" (which
    /// the IST case above covers). At offset `-480` (UTC-8),
    /// `2026-07-01 03:00 UTC` is `2026-06-30 19:00` locally, inside a
    /// `2026-06-01..2026-06-30` range asked in that local day.
    #[sqlx::test]
    async fn a_boundary_entry_west_of_utc_is_labelled_with_its_local_day_not_utc(pool: PgPool) {
        insert_entry_at(
            &pool,
            "late night thoughts",
            day(2026, 7, 1) + Duration::hours(3),
        )
        .await;

        let tool = EntriesInRangeTool::new(pool, -480);
        let outcome = tool
            .execute(json!({"from": "2026-06-01", "to": "2026-06-30"}))
            .await
            .unwrap();

        assert!(
            outcome.content.contains("[2026-06-30] late night thoughts"),
            "expected the local day 2026-06-30, got: {}",
            outcome.content
        );
        assert!(
            !outcome.content.contains("[2026-07-01]"),
            "must not render the UTC day, which falls outside the requested range: {}",
            outcome.content
        );
        assert_eq!(outcome.entry_ids.len(), 1);
    }
}
