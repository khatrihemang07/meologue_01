//! `read_digest` — issue #95: the harness's first tool over a Digest rather
//! than an Entry. The Server already writes one prose summary per completed
//! day, week and month, off the request path (`digest.rs`, ADR 0027); this
//! tool is what lets "how was March" be answered from that summary instead
//! of `entries_in_range` re-reading every raw Entry March held.
//!
//! Issue #95 frames this as a proof, not just a feature: if a Digest — no
//! author, covers a Period rather than a moment, already summarised — costs
//! exactly one tool and nothing else, the claim that this design scales to
//! a new kind of data is demonstrated rather than asserted. It held: this
//! file, `super::read_digest`'s two-line export in `mod.rs`, and one line
//! registering it in `reflect.rs::run_reflect_loop`'s `tools` vec are the
//! whole diff outside this module. The one thing that did *not* stay inside
//! this file is visibility — `digest::DigestRecord` and
//! `digest::select_digest_at` were `pub(crate)`-widened so this tool can
//! call the exact query `digest_at_handler` already runs rather than
//! duplicating it, the same minimal widening `entries_in_range.rs` made of
//! `reflect::local_date_range_to_utc` (see that file's own doc comment).
//! Nothing about the query, the row, or `digest.rs`'s behaviour changed —
//! only what can see two names that were already private to it.
//!
//! **A Digest is not an Entry, and this tool never claims otherwise.**
//! `ToolOutcome::entry_ids` feeds `grounding_entry_ids` on the wire
//! (`reflect.rs::run_reflect_loop`), which is specifically "an Entry
//! appeared in a tool result this run" — so `execute` below never calls
//! `.with_entry_ids(...)`, even though a found Digest carries its own
//! `grounding_entry_ids` (the Entries *it* was written from). Laundering
//! those into this call's `entry_ids` would claim this tool call read those
//! Entries itself, which it didn't; it read a summary of them. Instead the
//! Digest's own Grounding travels in `ToolOutcome::details` — the sidecar
//! the model never sees but the Conversation stores and the client renders
//! (`ToolOutcome`'s own doc comment) — tagged `"source": "digest"` there
//! too. That tag, not a new field on `ToolOutcome` or a new shape on the
//! wire, is where "an Answer drawn from a Digest is distinguishable from
//! one drawn from Entries" actually lives: `details` already exists for
//! exactly this kind of tool-specific structured detail, and every other
//! tool already leaves it well alone for anything the model needs to see.
//! One consequence worth being explicit about: a Question answered from a
//! Digest alone (no other tool call in the same run) reports
//! `grounded: false` on the wire, because `grounding_entry_ids` stays
//! empty — correct under `grounded`'s own definition, not a gap this ticket
//! left open.

use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::digest::select_digest_at;
use crate::period::{self, Period};

use super::{AgentTool, ToolOutcome};

/// `read_digest(period, date)` — the tool itself. Holds only a `PgPool`:
/// unlike `EntriesInRangeTool`, there is no `utc_offset_minutes` to carry,
/// because a Digest's `period_start` is never resolved against the asking
/// Device's offset in the first place — `digest.rs`'s worker buckets
/// Entries into a Period using the Server's own `MEOLOGUE_TZ`
/// (`period::server_timezone`, ADR 0027), not any per-request value, and
/// `digest_at_handler` already reads its `date` path parameter as a bare
/// calendar value with no timezone conversion at all. This tool does the
/// same: `date` names a calendar day, never an instant.
pub struct ReadDigestTool {
    pool: PgPool,
}

impl ReadDigestTool {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AgentTool for ReadDigestTool {
    fn name(&self) -> &str {
        "read_digest"
    }

    fn description(&self) -> &str {
        "Reads the Digest — a prose summary the Server already wrote, not raw journal Entries \
         — for the day, week, or month containing a given date. Prefer this over entries_in_range \
         when the Question is about how a whole stretch of time went (\"how was March\", \"how \
         was last week\") rather than about a specific Entry."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": ["day", "week", "month"],
                    "description": "Which granularity of Digest to read.",
                },
                "date": {
                    "type": "string",
                    "description": "Any date, as YYYY-MM-DD, inside the target day, week, or \
                                     month — not necessarily its first day. For \"week\", any \
                                     day in that ISO week (Monday-Sunday); for \"month\", any \
                                     day in that calendar month.",
                },
            },
            "required": ["period", "date"],
        })
    }

    fn snippet(&self) -> &str {
        "read_digest(period, date) — reads the prose summary already written for the day, week, \
         or month containing `date`, instead of the raw Entries in it."
    }

    fn guidelines(&self) -> Option<&str> {
        Some(
            "Try this before entries_in_range for a Question about how a whole day, week, or \
             month went — a Digest is already a considered summary of that stretch, and reading \
             it is cheaper and more focused than re-reading every raw Entry in it. If no Digest \
             exists yet for the Period asked about, fall back to entries_in_range.",
        )
    }

    async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String> {
        let period = parse_required_period(&arguments, "period")?;
        let date = parse_required_date(&arguments, "date")?;

        let start = period_start_containing(period, date);
        let end = period::period_end(period, start);
        // Mirrors `digest.rs::build_messages`'s own `range` formatting
        // exactly (`"{start} ({period})"` when the Period is a single day,
        // `"{start} to {end} (a {period})"` otherwise) — not reused from
        // there because it isn't a separate function to reuse, just four
        // inline lines, and duplicating a `format!` is a smaller cost than
        // extracting and exporting one for a single caller. Kept identical
        // so a Digest reads the same way here as it does in the prompt
        // that produced it.
        let range = if start == end {
            format!("{} ({})", start, period.as_str())
        } else {
            format!("{} to {} (a {})", start, end, period.as_str())
        };

        let record = select_digest_at(&self.pool, period, start)
            .await
            .map_err(|err| format!("looking up the Digest failed: {err}"))?;

        // No Digest for this Period is an ordinary, plain result — never
        // `is_error: true` — the same discipline `entries_in_range`'s own
        // "No Entries were found from {from} to {to}." uses for an empty
        // range: an empty archive is a fact about the journal, not a
        // mistake the model made asking for it.
        let Some(record) = record else {
            return Ok(ToolOutcome::new(format!(
                "No Digest has been written yet for {range}."
            )));
        };

        let content = format!("Digest for {range}:\n\n{}", record.body);

        let details = json!({
            "source": "digest",
            "period": period.as_str(),
            "period_start": start.to_string(),
            "period_end": end.to_string(),
            "grounding_entry_ids": record.grounding_entry_ids,
        });

        // Deliberately no `.with_entry_ids(...)` — see this module's own
        // doc comment for why a Digest's Grounding stays out of
        // `ToolOutcome::entry_ids` and travels in `details` instead.
        Ok(ToolOutcome::new(content).with_details(details))
    }
}

/// The local calendar date on which the Period containing `date` begins —
/// this tool's own use of `period::period_start_of`'s Monday/1st-of-month
/// arithmetic, applied to a date that is *already* a calendar value rather
/// than a raw instant that still needs bucketing into one.
///
/// `period_start_of` takes a `DateTime<Utc>` plus a `Tz` because its actual
/// job, everywhere else it's called, is "which local day does this instant
/// fall on" (`digest.rs`'s worker, converting a stored `created_at`). This
/// call site has no such question to ask — `date` is already the local day,
/// straight from the argument the model supplied — so `date` is anchored at
/// UTC noon and read back through `Tz::UTC` purely to hand `period_start_of`
/// a `DateTime<Utc>` it can accept; noon is nowhere near a day boundary, so
/// this round trip changes no calendar date, and `Tz::UTC` here carries no
/// timezone claim at all. What's actually being reused is the week/month
/// alignment math itself, not a timezone conversion — reusing it here,
/// rather than re-deriving "the Monday on or before this date" by hand, is
/// what `period.rs`'s own doc comment means by "one implementation, used
/// everywhere": a second copy of that arithmetic is exactly the drift risk
/// it warns about, even a copy with no timezone in it at all.
fn period_start_containing(period: Period, date: NaiveDate) -> NaiveDate {
    let instant = date
        .and_hms_opt(12, 0, 0)
        .expect("noon is always a valid time")
        .and_utc();
    period::period_start_of(period, chrono_tz::Tz::UTC, instant)
}

fn parse_required_period(arguments: &Value, field: &str) -> Result<Period, String> {
    let raw = arguments
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!("`{field}` is required and must be \"day\", \"week\", or \"month\".")
        })?;
    Period::parse(raw)
        .ok_or_else(|| format!("`{field}` ({raw:?}) is not \"day\", \"week\", or \"month\"."))
}

fn parse_required_date(arguments: &Value, field: &str) -> Result<NaiveDate, String> {
    let raw = arguments
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{field}` is required and must be a \"YYYY-MM-DD\" string."))?;
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| format!("`{field}` ({raw:?}) is not a valid \"YYYY-MM-DD\" date."))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sqlx::PgPool;
    use uuid::Uuid;

    use super::*;
    use crate::harness::tools::render_tool_guidance;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    async fn insert_digest(
        pool: &PgPool,
        period: Period,
        period_start: NaiveDate,
        body: &str,
        grounding_entry_ids: &[Uuid],
    ) {
        sqlx::query(
            "insert into digests (id, period, period_start, body, grounding_entry_ids) \
             values ($1, $2, $3, $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(period.as_str())
        .bind(period_start)
        .bind(body)
        .bind(grounding_entry_ids)
        .execute(pool)
        .await
        .unwrap();
    }

    // -------------------------------------------------------------------
    // Reading a Digest that exists, for each Period kind.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn a_day_digest_is_read_by_any_date_naming_that_day(pool: PgPool) {
        let entry_id = Uuid::new_v4();
        insert_digest(
            &pool,
            Period::Day,
            date(2026, 3, 10),
            "You wrote about a long walk.",
            &[entry_id],
        )
        .await;

        let tool = ReadDigestTool::new(pool);
        let outcome = tool
            .execute(json!({"period": "day", "date": "2026-03-10"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("You wrote about a long walk."));
        assert!(outcome.content.contains("2026-03-10 (day)"));
    }

    #[sqlx::test]
    async fn a_week_digest_is_read_by_any_date_inside_that_week(pool: PgPool) {
        // 2026-08-17 is the Monday of the ISO week containing 2026-08-19.
        insert_digest(
            &pool,
            Period::Week,
            date(2026, 8, 17),
            "A quiet week, mostly work.",
            &[],
        )
        .await;

        let tool = ReadDigestTool::new(pool);
        // Wednesday, not the Monday itself — proves the tool resolves the
        // containing Period rather than requiring the exact period_start.
        let outcome = tool
            .execute(json!({"period": "week", "date": "2026-08-19"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("A quiet week, mostly work."));
        assert!(
            outcome
                .content
                .contains("2026-08-17 to 2026-08-23 (a week)")
        );
    }

    #[sqlx::test]
    async fn a_month_digest_is_read_by_any_date_inside_that_month(pool: PgPool) {
        insert_digest(
            &pool,
            Period::Month,
            date(2026, 3, 1),
            "March was busy: a trip, a deadline, a cold.",
            &[],
        )
        .await;

        let tool = ReadDigestTool::new(pool);
        let outcome = tool
            .execute(json!({"period": "month", "date": "2026-03-27"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("March was busy"));
        assert!(
            outcome
                .content
                .contains("2026-03-01 to 2026-03-31 (a month)")
        );
    }

    // -------------------------------------------------------------------
    // A Period with no Digest — plain result, not an error.
    // -------------------------------------------------------------------

    /// The acceptance criterion this ticket names directly: asking for a
    /// Period with no Digest is a plain, successful result (`Ok`, not
    /// `Err`), with wording that says so — never `is_error: true`. This
    /// would fail before the fix in the trivial sense that the tool did
    /// not exist at all; it stays here as the test that pins the exact
    /// discipline `entries_in_range`'s own empty-range wording uses, so a
    /// future change to this tool can't quietly turn an empty archive into
    /// an error result.
    #[sqlx::test]
    async fn a_period_with_no_digest_gets_a_plain_result_not_an_error(pool: PgPool) {
        let tool = ReadDigestTool::new(pool);
        let outcome = tool
            .execute(json!({"period": "month", "date": "2026-03-15"}))
            .await
            .unwrap();

        assert!(
            outcome.content.contains("No Digest has been written"),
            "expected plain empty wording, got: {}",
            outcome.content
        );
        assert!(
            outcome
                .content
                .contains("2026-03-01 to 2026-03-31 (a month)")
        );
        assert!(outcome.entry_ids.is_empty());
    }

    #[sqlx::test]
    async fn a_period_with_no_digest_names_a_single_day_without_a_range(pool: PgPool) {
        let tool = ReadDigestTool::new(pool);
        let outcome = tool
            .execute(json!({"period": "day", "date": "2026-03-15"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("2026-03-15 (day)"));
        assert!(!outcome.content.contains(" to "));
    }

    // -------------------------------------------------------------------
    // Malformed arguments — correctable error results, never a panic.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn an_unrecognised_period_name_is_an_error_result(pool: PgPool) {
        let tool = ReadDigestTool::new(pool);
        let err = tool
            .execute(json!({"period": "fortnight", "date": "2026-03-15"}))
            .await
            .unwrap_err();
        assert!(err.contains("period"));
    }

    #[sqlx::test]
    async fn an_unparseable_date_is_an_error_result(pool: PgPool) {
        let tool = ReadDigestTool::new(pool);
        let err = tool
            .execute(json!({"period": "day", "date": "not-a-date"}))
            .await
            .unwrap_err();
        assert!(err.contains("date"));
    }

    #[sqlx::test]
    async fn a_missing_period_field_is_an_error_result(pool: PgPool) {
        let tool = ReadDigestTool::new(pool);
        let err = tool
            .execute(json!({"date": "2026-03-15"}))
            .await
            .unwrap_err();
        assert!(err.contains("period"));
    }

    #[sqlx::test]
    async fn a_missing_date_field_is_an_error_result(pool: PgPool) {
        let tool = ReadDigestTool::new(pool);
        let err = tool.execute(json!({"period": "day"})).await.unwrap_err();
        assert!(err.contains("date"));
    }

    // -------------------------------------------------------------------
    // `details` carries what makes a Digest-sourced Answer distinguishable
    // from an Entry-sourced one — see this module's own doc comment.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn a_found_digest_is_tagged_in_details_and_never_in_entry_ids(pool: PgPool) {
        let grounding_id = Uuid::new_v4();
        insert_digest(
            &pool,
            Period::Month,
            date(2026, 3, 1),
            "March, summarised.",
            &[grounding_id],
        )
        .await;

        let tool = ReadDigestTool::new(pool);
        let outcome = tool
            .execute(json!({"period": "month", "date": "2026-03-15"}))
            .await
            .unwrap();

        assert_eq!(outcome.details["source"], "digest");
        assert_eq!(outcome.details["period"], "month");
        assert_eq!(outcome.details["period_start"], "2026-03-01");
        assert_eq!(outcome.details["period_end"], "2026-03-31");
        assert_eq!(
            outcome.details["grounding_entry_ids"],
            json!([grounding_id])
        );

        // The load-bearing half of the claim: whatever Entries this Digest
        // was itself written from must not appear in `entry_ids`, which
        // `reflect.rs` folds into the wire-level `grounding_entry_ids` as
        // though this tool call had surfaced those Entries directly. It
        // didn't — it surfaced a summary of them.
        assert!(outcome.entry_ids.is_empty());
    }

    // -------------------------------------------------------------------
    // The tool's own guidance reaches the rendered system prompt when
    // registered — the same mechanism `harness::tools::mod`'s own
    // `a_tools_snippet_and_guidelines_are_appended` proves generically,
    // exercised here against the real tool rather than a `FixedTool`
    // double, so this pins that *this* tool's actual snippet/guidelines
    // text is what shows up, not just that the mechanism works.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn the_tools_guidance_appears_in_the_rendered_system_prompt(pool: PgPool) {
        let tools: Vec<Arc<dyn AgentTool>> = vec![Arc::new(ReadDigestTool::new(pool))];
        let prompt = render_tool_guidance("Base.", &tools);

        assert!(prompt.contains(
            "read_digest(period, date) — reads the prose summary already written for the day, \
             week, or month containing `date`, instead of the raw Entries in it."
        ));
        assert!(prompt.contains("Try this before entries_in_range"));
    }
}
