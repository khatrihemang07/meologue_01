//! `list_tasks` — issue #175's harness tool: the loop's own reach into
//! Tasks (ADR 0047's second root noun), registered beside `entries_in_range`,
//! `search_entries`, `similar_entries` and `read_digest` rather than folded
//! into any of them. "Being able to ask 'what did I say I'd do about
//! this?'" is much of the point of holding a journal and a task list in
//! one app (issue #175's own framing) — a Task is not an Entry, so none of
//! the four existing tools can ever surface one, and this is the gap that
//! leaves open until now.
//!
//! **ADR 0023's fixed three-source fan-out — long since superseded by ADR
//! 0031's tool loop — is not touched by this file, and could not be even
//! if it still existed.** The fan-out was *retrieval*: something run for
//! every Question, whether or not the words in it had anything to do with
//! dates or keywords. A tool is the opposite shape by construction — see
//! `AgentTool`'s own doc comment (`mod.rs`) — the model has to *choose* to
//! call `list_tasks`, on its own initiative, exactly the same way it has
//! to choose `search_entries` or `read_digest`. A Question about a feeling
//! that never mentions a task, a plan, or something the user said they'd
//! do simply never produces a `<tool_call>` naming this tool, and so never
//! spends any of its grounding budget on the to-do list — that is not a
//! guard this file adds, it is the harness's existing contract (ADR 0031)
//! applied to a fifth tool. See ADR 0052 for the fuller record.
//!
//! **A Task is not an Entry, and this tool never claims otherwise** — the
//! identical discipline `read_digest.rs` already established for a Digest.
//! `ToolOutcome::entry_ids` feeds `grounding_entry_ids` on the wire, which
//! specifically means "an Entry appeared in a tool result this run," so
//! `execute` below never calls `.with_entry_ids(...)`. A Task's own ids
//! travel in `ToolOutcome::details` instead, tagged `"source": "tasks"`,
//! mirroring `read_digest`'s `"source": "digest"` tag exactly.
//!
//! **No Project or Section name resolution.** A Task's `project_id` is a
//! bare, unvalidated uuid on this Server (`server/migrations/
//! 0010_create_tasks.sql`'s own header comment: Projects and Sections do
//! not sync server-side as of issue #172/#175) — there is no `projects`
//! table here to join against, so a rendered line never claims a Project
//! name it cannot actually look up. This mirrors ADR 0051's own
//! "an unresolved reference degrades to itself, honestly" rule for the
//! identical id, applied here to a read instead of a Sync arrival.

use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::{AgentTool, ToolOutcome};

/// See `entries_in_range.rs::DEFAULT_PAGE_SIZE` — same value, same
/// reasoning, kept as this tool's own constant so its pagination tuning
/// stays independently adjustable from the Entry-facing tools.
pub const DEFAULT_PAGE_SIZE: i64 = 20;

/// See `entries_in_range.rs::MAX_PAGE_SIZE`.
pub const MAX_PAGE_SIZE: i64 = 100;

/// See `entries_in_range.rs::CONTENT_CHAR_BUDGET`. Task lines are short —
/// one line each, unlike a multi-paragraph Entry body — so this budget is
/// rarely the limit that bites in practice; it exists for the same
/// protective reason every other tool here carries one, not because a
/// personal Task list is expected to approach it.
pub const CONTENT_CHAR_BUDGET: usize = 8_000;

/// Which slice of Tasks `list_tasks` reads — the tool's own required
/// `status` argument, parsed once in `execute` rather than matched on the
/// raw string at every call site below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskStatus {
    Active,
    Completed,
    Overdue,
}

impl TaskStatus {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "active" => Some(Self::Active),
            "completed" => Some(Self::Completed),
            "overdue" => Some(Self::Overdue),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Overdue => "overdue",
        }
    }

    /// The noun phrase this status's own "nothing matched" and pagination
    /// messages are built from — "active Tasks", "completed Tasks",
    /// "overdue Tasks" — kept in one place so the three wordings can never
    /// drift out of sync with `as_str` above.
    fn noun_phrase(self) -> &'static str {
        match self {
            Self::Active => "active Tasks",
            Self::Completed => "completed Tasks",
            Self::Overdue => "overdue Tasks",
        }
    }
}

/// One row `list_tasks` reads back — a small projection of `tasks`, not
/// the whole row: this tool answers "what did the user say they'd do,"
/// which needs the Task's own text and enough scheduling context to say
/// *when*, not every field Export's own `ExportManifestTask` carries
/// losslessly for a different purpose entirely.
#[derive(Debug, Clone, sqlx::FromRow)]
struct TaskRow {
    id: Uuid,
    content: String,
    completed_at: Option<DateTime<Utc>>,
    date: Option<String>,
    deadline: Option<String>,
    date_string: Option<String>,
    priority: i32,
    project_id: Option<Uuid>,
}

/// `list_tasks(status, query?, limit?, offset?)` — the tool itself. Holds
/// a `PgPool` and the asking Device's `utc_offset_minutes`, the same pair
/// `EntriesInRangeTool`/`SearchEntriesTool` hold and for the identical
/// reason: `status: "overdue"` has to know what day it is in the asking
/// Device's own local time (ADR 0023's "the client injects its own UTC
/// offset, the Server never guesses the timezone" rule, applied here to
/// deciding "today" rather than to a date-range argument), and a
/// completed Task's own `completed_at` is rendered in that same local
/// time — the identical `render_entry`-style choice the other tools make,
/// just inlined here rather than shared, since a Task line has no other
/// use for that function.
pub struct TasksTool {
    pool: PgPool,
    utc_offset_minutes: i32,
}

impl TasksTool {
    pub fn new(pool: PgPool, utc_offset_minutes: i32) -> Self {
        Self {
            pool,
            utc_offset_minutes,
        }
    }
}

#[async_trait]
impl AgentTool for TasksTool {
    fn name(&self) -> &str {
        "list_tasks"
    }

    fn description(&self) -> &str {
        "Lists Tasks from Todo — the user's to-do list, a separate thing from their journal \
         Entries. `status` selects active (not yet done), completed, or overdue (still active, \
         with a date or deadline that has already passed) Tasks. `query` optionally narrows to \
         Tasks whose text contains the given words. Results are paginated — pass the offset a \
         truncated page names to keep reading."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["active", "completed", "overdue"],
                    "description": "Which Tasks to list.",
                },
                "query": {
                    "type": "string",
                    "description": "Optional: only Tasks whose text contains this word or phrase.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max Tasks to return in this page (default 20, capped at 100).",
                },
                "offset": {
                    "type": "integer",
                    "description": "How many matching Tasks to skip before this page starts (default 0).",
                },
            },
            "required": ["status"],
        })
    }

    fn snippet(&self) -> &str {
        "list_tasks(status, query?, limit?, offset?) — lists Tasks from Todo (active, completed, \
         or overdue), not journal Entries. Use this for a Question about something the user said \
         they would do, is planning to do, or has finished doing as a Task."
    }

    fn guidelines(&self) -> Option<&str> {
        Some(
            "A page ends with a bracketed note naming the exact offset to call next when there's \
             more to see; no such note means every matching Task has already been shown. \
             \"overdue\" means an active Task whose date or deadline has already passed as of \
             today, in the asking Device's own local time — it does not include a Task merely due \
             later today. A Task has nothing to do with an Entry: use entries_in_range or \
             search_entries for what the user wrote, and this tool for what they're tracking as a \
             Task.",
        )
    }

    async fn execute(&self, arguments: Value) -> Result<ToolOutcome, String> {
        let status = parse_required_status(&arguments, "status")?;
        let query = parse_optional_query(&arguments, "query");
        let limit = parse_optional_i64(&arguments, "limit")
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        let offset = parse_optional_i64(&arguments, "offset").unwrap_or(0).max(0);

        let pattern = query.as_ref().map(|q| format!("%{q}%"));
        // The asking Device's own local "today" — see this struct's own
        // doc comment for why `status: "overdue"` needs it and why it's
        // computed from the injected offset rather than the Server's own
        // clock (ADR 0023).
        let today = (Utc::now() + Duration::minutes(i64::from(self.utc_offset_minutes))).date_naive();

        let rows = fetch_rows(&self.pool, status, pattern.as_deref(), today)
            .await
            .map_err(|err| format!("looking up Tasks failed: {err}"))?;

        let total = rows.len();
        if total == 0 {
            return Ok(ToolOutcome::new(format!(
                "No {} were found{}.",
                status.noun_phrase(),
                describe_query_suffix(query.as_deref()),
            )));
        }

        let window: Vec<&TaskRow> = rows.iter().skip(offset as usize).collect();
        if window.is_empty() {
            return Ok(ToolOutcome::new(format!(
                "offset={offset} is past the end: only {total} {} were found{} in total.",
                status.noun_phrase(),
                describe_query_suffix(query.as_deref()),
            )));
        }

        // Same "stop at whichever limit is hit first, but the first row
        // in the window always survives" pagination shape every other
        // tool here uses — see `entries_in_range.rs`'s own doc comment
        // for the full reasoning.
        let mut shown: Vec<(&TaskRow, String)> = Vec::new();
        let mut char_count = 0usize;
        for row in window.iter().take(limit as usize) {
            let rendered = render_task_line(row, self.utc_offset_minutes);
            let next_count = char_count + rendered.chars().count();
            if !shown.is_empty() && next_count > CONTENT_CHAR_BUDGET {
                break;
            }
            char_count = next_count;
            shown.push((row, rendered));
        }

        let shown_count = shown.len() as i64;
        let body = shown
            .iter()
            .map(|(_, rendered)| rendered.clone())
            .collect::<Vec<_>>()
            .join("\n");

        let start = offset + 1;
        let end = offset + shown_count;
        let content = if end < total as i64 {
            format!(
                "{body}\n\n[Showing {start}-{end} of {total}. Use offset={next} to continue.]",
                next = end + 1
            )
        } else {
            // Complete: nothing appended after the Tasks at all — the
            // same silence-is-the-signal convention every other tool
            // here uses (`mod.rs`'s own doc comment).
            body
        };

        let tasks_detail: Vec<Value> = shown
            .iter()
            .map(|(row, _)| {
                json!({
                    "id": row.id,
                    "content": row.content,
                    "completed_at": row.completed_at,
                    "date": row.date,
                    "deadline": row.deadline,
                    "priority": row.priority,
                    "project_id": row.project_id,
                })
            })
            .collect();

        let details = json!({
            "source": "tasks",
            "status": status.as_str(),
            "query": query,
            "total": total,
            "offset": offset,
            "shown": shown_count,
            "tasks": tasks_detail,
        });

        // Deliberately no `.with_entry_ids(...)` — see this module's own
        // doc comment for why a Task's own ids stay out of `entry_ids`
        // and travel in `details` instead, mirroring `read_digest.rs`.
        Ok(ToolOutcome::new(content).with_details(details))
    }
}

async fn fetch_rows(
    pool: &PgPool,
    status: TaskStatus,
    pattern: Option<&str>,
    today: NaiveDate,
) -> Result<Vec<TaskRow>, sqlx::Error> {
    match status {
        TaskStatus::Active => {
            sqlx::query_as::<_, TaskRow>(
                "select id, content, completed_at, date, deadline, date_string, priority, project_id \
                 from tasks \
                 where deleted_at is null and completed_at is null \
                   and ($1::text is null or content ilike $1) \
                 order by order_key asc, id asc",
            )
            .bind(pattern)
            .fetch_all(pool)
            .await
        }
        TaskStatus::Completed => {
            sqlx::query_as::<_, TaskRow>(
                "select id, content, completed_at, date, deadline, date_string, priority, project_id \
                 from tasks \
                 where deleted_at is null and completed_at is not null \
                   and ($1::text is null or content ilike $1) \
                 order by completed_at desc, id desc",
            )
            .bind(pattern)
            .fetch_all(pool)
            .await
        }
        TaskStatus::Overdue => {
            // A Task is overdue the moment its `date` or `deadline`'s own
            // calendar date is strictly before the asking Device's local
            // "today" — matching this tool's own `guidelines()` promise
            // that a Task merely due later today is not overdue yet. `date`
            // is floating text, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`
            // (task-types.ts's own doc comment); `substring(date, 1, 10)`
            // reads the date part of either shape identically.
            sqlx::query_as::<_, TaskRow>(
                "select id, content, completed_at, date, deadline, date_string, priority, project_id \
                 from tasks \
                 where deleted_at is null and completed_at is null \
                   and ( \
                     (date is not null and substring(date, 1, 10)::date < $2) \
                     or (deadline is not null and deadline::date < $2) \
                   ) \
                   and ($1::text is null or content ilike $1) \
                 order by coalesce(substring(date, 1, 10)::date, deadline::date) asc, id asc",
            )
            .bind(pattern)
            .bind(today)
            .fetch_all(pool)
            .await
        }
    }
}

fn describe_query_suffix(query: Option<&str>) -> String {
    match query {
        Some(q) => format!(" matching {q:?}"),
        None => String::new(),
    }
}

fn render_task_line(row: &TaskRow, utc_offset_minutes: i32) -> String {
    let marker = if row.completed_at.is_some() { "[x]" } else { "[ ]" };
    let mut parts: Vec<String> = Vec::new();
    // Priority is stored inverted (1 = "no priority"/UI p4, 4 = UI p1, the
    // most urgent — task-types.ts's own doc comment on `uiPriorityOf`).
    // Only shown when it's actually a choice the user made, not the
    // default every Task starts with.
    if row.priority > 1 {
        parts.push(format!("p{}", 5 - row.priority));
    }
    if let Some(date) = &row.date {
        parts.push(format!("due {date}"));
    }
    if let Some(deadline) = &row.deadline {
        parts.push(format!("deadline {deadline}"));
    }
    if let Some(date_string) = &row.date_string {
        parts.push(date_string.clone());
    }
    if let Some(completed_at) = row.completed_at {
        let local = completed_at + Duration::minutes(i64::from(utc_offset_minutes));
        parts.push(format!("completed {}", local.format("%Y-%m-%d")));
    }

    if parts.is_empty() {
        format!("- {marker} {}", row.content)
    } else {
        format!("- {marker} {} ({})", row.content, parts.join(", "))
    }
}

fn parse_required_status(arguments: &Value, field: &str) -> Result<TaskStatus, String> {
    let raw = arguments.get(field).and_then(Value::as_str).ok_or_else(|| {
        format!("`{field}` is required and must be \"active\", \"completed\", or \"overdue\".")
    })?;
    TaskStatus::parse(raw).ok_or_else(|| {
        format!("`{field}` ({raw:?}) is not \"active\", \"completed\", or \"overdue\".")
    })
}

fn parse_optional_query(arguments: &Value, field: &str) -> Option<String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_optional_i64(arguments: &Value, field: &str) -> Option<i64> {
    arguments.get(field).and_then(Value::as_i64)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sqlx::PgPool;

    use super::*;
    use crate::harness::tools::render_tool_guidance;

    async fn insert_task(
        pool: &PgPool,
        id: Uuid,
        content: &str,
        completed_at: Option<DateTime<Utc>>,
        date: Option<&str>,
        deadline: Option<&str>,
        priority: i32,
    ) {
        sqlx::query(
            "insert into tasks (id, device_id, content, completed_at, order_key, created_at, \
             date, deadline, priority) \
             values ($1, $2, $3, $4, $5, now(), $6, $7, $8)",
        )
        .bind(id)
        .bind(Uuid::new_v4())
        .bind(content)
        .bind(completed_at)
        .bind(format!("k{id}")) // a unique order_key per row is enough to give (orderKey, id) a stable order without needing real fractional keys
        .bind(date)
        .bind(deadline)
        .bind(priority)
        .execute(pool)
        .await
        .unwrap();
    }

    // -------------------------------------------------------------------
    // status: "active" / "completed" / "overdue" each read the right rows.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn active_status_excludes_completed_and_deleted_tasks(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "still open", None, None, None, 1).await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "done",
            Some(Utc::now()),
            None,
            None,
            1,
        )
        .await;
        let deleted = Uuid::new_v4();
        insert_task(&pool, deleted, "gone", None, None, None, 1).await;
        sqlx::query("update tasks set deleted_at = now() where id = $1")
            .bind(deleted)
            .execute(&pool)
            .await
            .unwrap();

        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "active"})).await.unwrap();

        assert!(outcome.content.contains("still open"));
        assert!(!outcome.content.contains("done"));
        assert!(!outcome.content.contains("gone"));
    }

    #[sqlx::test]
    async fn completed_status_reads_only_completed_tasks_newest_first(pool: PgPool) {
        insert_task(
            &pool,
            Uuid::new_v4(),
            "older",
            Some(Utc::now() - chrono::Duration::days(2)),
            None,
            None,
            1,
        )
        .await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "newer",
            Some(Utc::now()),
            None,
            None,
            1,
        )
        .await;
        insert_task(&pool, Uuid::new_v4(), "still open", None, None, None, 1).await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"status": "completed"}))
            .await
            .unwrap();

        assert!(!outcome.content.contains("still open"));
        assert!(
            outcome.content.find("newer").unwrap() < outcome.content.find("older").unwrap(),
            "completed Tasks should read newest-completion-first: {}",
            outcome.content
        );
    }

    #[sqlx::test]
    async fn overdue_status_excludes_a_task_due_later_today(pool: PgPool) {
        let today = chrono::Utc::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);
        let tomorrow = today + chrono::Duration::days(1);

        insert_task(
            &pool,
            Uuid::new_v4(),
            "was due yesterday",
            None,
            Some(&yesterday.format("%Y-%m-%d").to_string()),
            None,
            1,
        )
        .await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "due later today",
            None,
            Some(&today.format("%Y-%m-%d").to_string()),
            None,
            1,
        )
        .await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "due tomorrow",
            None,
            Some(&tomorrow.format("%Y-%m-%d").to_string()),
            None,
            1,
        )
        .await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "overdue"})).await.unwrap();

        assert!(outcome.content.contains("was due yesterday"));
        assert!(!outcome.content.contains("due later today"));
        assert!(!outcome.content.contains("due tomorrow"));
    }

    #[sqlx::test]
    async fn overdue_status_also_matches_on_a_passed_deadline(pool: PgPool) {
        let yesterday = chrono::Utc::now().date_naive() - chrono::Duration::days(1);
        insert_task(
            &pool,
            Uuid::new_v4(),
            "deadline passed",
            None,
            None,
            Some(&yesterday.format("%Y-%m-%d").to_string()),
            1,
        )
        .await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "overdue"})).await.unwrap();

        assert!(outcome.content.contains("deadline passed"));
    }

    // -------------------------------------------------------------------
    // query narrows within a status.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn a_query_narrows_to_tasks_whose_content_matches(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "buy milk", None, None, None, 1).await;
        insert_task(&pool, Uuid::new_v4(), "call plumber", None, None, None, 1).await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"status": "active", "query": "milk"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("buy milk"));
        assert!(!outcome.content.contains("call plumber"));
    }

    // -------------------------------------------------------------------
    // Empty results are a plain result, never an error — the same
    // discipline every other tool's own empty-page test pins.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn no_matching_tasks_is_a_plain_result_not_an_error(pool: PgPool) {
        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "completed"})).await.unwrap();

        assert!(outcome.content.contains("No completed Tasks were found"));
    }

    // -------------------------------------------------------------------
    // Rendering: priority, date, deadline, recurrence, completion date.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn priority_is_shown_only_when_the_user_actually_chose_one(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "no priority", None, None, None, 1).await;
        insert_task(&pool, Uuid::new_v4(), "urgent", None, None, None, 4).await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "active"})).await.unwrap();

        assert!(outcome.content.contains("- [ ] no priority"));
        assert!(!outcome.content.contains("no priority ("));
        // Stored priority 4 is UI p1, the most urgent (inverted, per
        // task-types.ts's own doc comment) — 5 - 4 = 1.
        assert!(outcome.content.contains("urgent (p1)"));
    }

    #[sqlx::test]
    async fn a_completed_tasks_date_is_rendered_in_the_asking_devices_local_time(pool: PgPool) {
        use chrono::TimeZone;
        let completed_at = chrono_tz::Tz::UTC
            .with_ymd_and_hms(2026, 8, 30, 20, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        insert_task(
            &pool,
            Uuid::new_v4(),
            "call plumber",
            Some(completed_at),
            None,
            None,
            1,
        )
        .await;

        // +05:30 (IST): 2026-08-30 20:00 UTC is 2026-08-31 01:30 local.
        let tool = TasksTool::new(pool, 330);
        let outcome = tool
            .execute(json!({"status": "completed"}))
            .await
            .unwrap();

        assert!(outcome.content.contains("completed 2026-08-31"));
    }

    // -------------------------------------------------------------------
    // entry_ids stays empty and details carries the tasks tag — see this
    // module's own doc comment for why a Task is never laundered into
    // grounding_entry_ids.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn a_found_task_is_tagged_in_details_and_never_in_entry_ids(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "buy milk", None, None, None, 1).await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "active"})).await.unwrap();

        assert_eq!(outcome.details["source"], "tasks");
        assert_eq!(outcome.details["status"], "active");
        assert!(outcome.entry_ids.is_empty());
    }

    // -------------------------------------------------------------------
    // Pagination — the same truncation-note contract every other tool
    // here carries.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn a_truncated_page_names_the_exact_next_offset(pool: PgPool) {
        for i in 0..3 {
            insert_task(&pool, Uuid::new_v4(), &format!("task {i}"), None, None, None, 1).await;
        }

        let tool = TasksTool::new(pool, 0);
        let outcome = tool
            .execute(json!({"status": "active", "limit": 2}))
            .await
            .unwrap();

        assert!(outcome.content.contains("Use offset=3 to continue"));
    }

    #[sqlx::test]
    async fn a_complete_page_names_no_further_offset(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "only task", None, None, None, 1).await;

        let tool = TasksTool::new(pool, 0);
        let outcome = tool.execute(json!({"status": "active"})).await.unwrap();

        assert!(!outcome.content.contains("Use offset"));
    }

    // -------------------------------------------------------------------
    // Malformed arguments — correctable error results, never a panic.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn an_unrecognised_status_is_an_error_result(pool: PgPool) {
        let tool = TasksTool::new(pool, 0);
        let err = tool
            .execute(json!({"status": "someday"}))
            .await
            .unwrap_err();
        assert!(err.contains("status"));
    }

    #[sqlx::test]
    async fn a_missing_status_field_is_an_error_result(pool: PgPool) {
        let tool = TasksTool::new(pool, 0);
        let err = tool.execute(json!({})).await.unwrap_err();
        assert!(err.contains("status"));
    }

    // -------------------------------------------------------------------
    // The tool's own guidance reaches the rendered system prompt.
    // -------------------------------------------------------------------

    #[sqlx::test]
    async fn the_tools_guidance_appears_in_the_rendered_system_prompt(pool: PgPool) {
        let tools: Vec<Arc<dyn AgentTool>> = vec![Arc::new(TasksTool::new(pool, 0))];
        let prompt = render_tool_guidance("Base.", &tools);

        assert!(prompt.contains(
            "list_tasks(status, query?, limit?, offset?) — lists Tasks from Todo"
        ));
        assert!(prompt.contains("not journal Entries"));
    }
}
