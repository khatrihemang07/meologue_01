//! Server-owned Time source configuration and Activity import.
//!
//! Two recorders are supported: Toggl Track's Activity Recording database and
//! Clockify Desktop's Auto Tracker. Both are Core Data SQLite files living on
//! the same machine as the Server, and everything that differs between them is
//! collected in one place — `SourceKind::adapter` — so a third recorder is a
//! new variant and a new `Adapter`, not a new branch in the import loop.
//!
//! What the two providers actually store was read off this machine's own
//! installs rather than inferred:
//!
//! | | Toggl | Clockify |
//! |---|---|---|
//! | table | `ZMANAGEDACTIVITY` | `ZCDAUTOTRACKERITEM` |
//! | identity | `ZID`, a **BLOB** | `ZID`, **TEXT** (24 hex chars) |
//! | start / end | `ZSTART` / `ZEND`, REAL | `ZTIMESTARTED` / `ZTIMEENDED`, INTEGER |
//! | label | `ZFILENAME` | `ZNAME` |
//! | detail | `ZTITLE` | `ZITEMDESCRIPTION` |
//! | idle | `ZISIDLE`, a flag | `ZIDLETIME`, idle **seconds** |
//!
//! Two of those differences are the reason the seam is shaped this way. The
//! identity column has the same name in both but a different storage class, so
//! identity is read through `provider_identity` rather than as a fixed Rust
//! type. And the timestamps are REAL in one and INTEGER in the other despite
//! both being Core Data seconds, so they are read as `f64` — which rusqlite
//! widens an INTEGER into — rather than matched on storage class.

use std::path::{Path, PathBuf};

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
};
#[cfg(test)]
use chrono::Timelike as _;
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{ConfigLocked, ServerTimezone};

const APPLE_EPOCH: i64 = 978_307_200;

// ---------------------------------------------------------------------------
// The adapter seam
// ---------------------------------------------------------------------------

/// Which recorder a Time source reads.
///
/// Stored as its wire string in `time_sources.kind`, where a check constraint
/// holds it to exactly these values — an unknown kind would be a source row
/// nothing could ever import.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    TogglActivity,
    ClockifyAutoTracker,
}

/// Where one provider keeps each field of an Activity interval.
///
/// Only column names live here. Everything about *how* a value is read —
/// identity storage class, Core Data conversion, idle normalization — is
/// shared, because those turned out not to vary per provider once the real
/// databases were looked at.
struct Adapter {
    /// The table holding one row per observed stretch of activity.
    table: &'static str,
    /// Both providers happen to name this `ZID`; it is spelled out rather than
    /// hard-coded so a provider that does not is a one-line change here.
    identity: &'static str,
    started: &'static str,
    ended: &'static str,
    label: &'static str,
    detail: &'static str,
    idle: &'static str,
    /// What a failed schema probe should tell the user, in their words.
    describes: &'static str,
}

impl SourceKind {
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "toggl_activity" => Some(Self::TogglActivity),
            "clockify_auto_tracker" => Some(Self::ClockifyAutoTracker),
            _ => None,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::TogglActivity => "toggl_activity",
            Self::ClockifyAutoTracker => "clockify_auto_tracker",
        }
    }

    fn adapter(self) -> Adapter {
        match self {
            Self::TogglActivity => Adapter {
                table: "ZMANAGEDACTIVITY",
                identity: "ZID",
                started: "ZSTART",
                ended: "ZEND",
                label: "ZFILENAME",
                detail: "ZTITLE",
                idle: "ZISIDLE",
                describes: "a Toggl Activity Recording database",
            },
            Self::ClockifyAutoTracker => Adapter {
                table: "ZCDAUTOTRACKERITEM",
                identity: "ZID",
                started: "ZTIMESTARTED",
                ended: "ZTIMEENDED",
                label: "ZNAME",
                detail: "ZITEMDESCRIPTION",
                idle: "ZIDLETIME",
                describes: "a Clockify Desktop Auto Tracker database",
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow, ToSchema)]
pub struct TimeSource {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub enabled: bool,
    /// What the last import run made of this source (issue #421). Separate
    /// attempt and success timestamps because the difference between them is
    /// the whole point: a recent attempt with a stale success is a recorder
    /// failing right now.
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_inserted_count: i32,
    pub last_warning_count: i32,
    pub last_error: Option<String>,
    /// The Server-local day this source last completed a *scheduled* import
    /// for (issue #422). Only the nightly and catch-up triggers write it, so
    /// it is what tells a completed daily run apart from a manual or initial
    /// one — `last_success_at` moves on all of them.
    pub last_scheduled_run_on: Option<NaiveDate>,
    /// Where this source is in the run happening *now*, which is memory, not
    /// a column: a Server restart has no queued sources, and persisting
    /// "running" would leave a source stuck that way after a crash.
    #[sqlx(skip)]
    pub state: SourceRunState,
}

/// The columns `time_sources` actually stores, for the queries that read one.
/// A macro rather than a `const` so the queries below assemble with `concat!`
/// into `&'static str`s — sqlx 0.9 refuses SQL built at runtime, and that
/// refusal is worth keeping for a string that is entirely literal anyway.
macro_rules! source_columns {
    () => {
        "id, name, kind, path, enabled, last_attempt_at, last_success_at, \
         last_inserted_count, last_warning_count, last_error, last_scheduled_run_on"
    };
}

const LIST_SOURCES_SQL: &str = concat!(
    "select ",
    source_columns!(),
    " from time_sources order by created_at"
);

const SOURCE_BY_ID_SQL: &str = concat!(
    "select ",
    source_columns!(),
    " from time_sources where id = $1"
);

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateTimeSource {
    pub name: String,
    pub kind: String,
    pub path: String,
}

/// A change to one existing Time source. Every field is optional: this is a
/// patch, and leaving one out means "leave it alone" rather than "clear it".
///
/// `kind` and `path` are only accepted until the source's first successful
/// import (issue #423). After that they name the database a body of stored
/// evidence actually came from, and repointing a source is how one recorder's
/// history would quietly become another's — a different database is a new
/// source.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTimeSource {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub kind: Option<String>,
    pub path: Option<String>,
}

/// One immutable stretch of activity, in provider-neutral terms.
///
/// The source's name, kind and enabled flag are carried on every interval
/// rather than being left for the client to join: a timeline showing several
/// lanes needs to name each lane's recorder, and an archived source's rows
/// still have to be identifiable on the days they cover long after the source
/// stopped importing (issue #423).
#[derive(Debug, Clone, Serialize, sqlx::FromRow, ToSchema)]
pub struct ActivityInterval {
    pub id: Uuid,
    pub source_id: Uuid,
    pub source_name: String,
    pub source_kind: String,
    pub source_enabled: bool,
    pub provider_record_id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub label: String,
    pub detail: Option<String>,
    /// Whether the recorder reported idleness on this record. This is
    /// deliberately weaker than "the whole interval was idle": Toggl stores a
    /// flag and Clockify stores a count of idle seconds inside the record, and
    /// collapsing both to a boolean is the most the two honestly share. The
    /// exact provider value is in `raw_row` on the single-interval route.
    pub idle: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ActivityIntervalDetail {
    #[serde(flatten)]
    pub interval: ActivityInterval,
    pub raw_row: Value,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct IntervalQuery {
    /// A calendar date, `YYYY-MM-DD`. Which instants it covers is the
    /// Server's answer rather than each Device's — see `day_bounds`.
    pub day: String,
    /// Comma-separated source ids. Absent means every source; present and
    /// empty means none, which is what a reader who has switched every lane
    /// off has actually asked for.
    pub source_ids: Option<String>,
    /// Free text matched against an interval's label and detail, case
    /// insensitively. Nothing here reaches outside `activity_intervals`:
    /// Time searches what recorders observed, not Entries or Tasks.
    pub q: Option<String>,
}

/// Every interval column the daily timeline serves, joined to its source.
///
/// A macro rather than a `const` so the queries below can be assembled with
/// `concat!` into `&'static str`s: sqlx 0.9 refuses SQL built at runtime, and
/// that refusal is worth keeping rather than waiving with an assertion for a
/// string that is entirely literal anyway.
///
/// `raw_row` is absent on purpose and not by omission: a dense day would drag
/// every provider's binary payload down with it, so the raw evidence is served
/// only by the single-interval route.
macro_rules! interval_columns {
    () => {
        "i.id, i.source_id, s.name as source_name, s.kind as source_kind, \
         s.enabled as source_enabled, i.provider_record_id, i.started_at, \
         i.ended_at, i.label, i.detail, i.idle"
    };
}

/// Overlap, not containment: a stretch of work that ran past midnight belongs
/// to both days it covers rather than being truncated out of one.
const LIST_INTERVALS_SQL: &str = concat!(
    "select ",
    interval_columns!(),
    " from activity_intervals i join time_sources s on s.id = i.source_id \
      where i.started_at < $2 and i.ended_at > $1 \
        and ($3::uuid[] is null or i.source_id = any($3)) \
        and ($4::text is null \
             or i.label ilike $4 escape '\\' \
             or coalesce(i.detail, '') ilike $4 escape '\\') \
      order by i.started_at"
);

const INTERVAL_DETAIL_SQL: &str = concat!(
    "select ",
    interval_columns!(),
    ", i.raw_row \
      from activity_intervals i join time_sources s on s.id = i.source_id \
      where i.id = $1"
);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn canonical_source_path(value: &str) -> Result<PathBuf, String> {
    let expanded = if value == "~" || value.starts_with("~/") {
        let home = std::env::var("HOME").map_err(|_| "cannot expand ~ without HOME")?;
        PathBuf::from(home).join(value.strip_prefix("~/").unwrap_or(""))
    } else {
        PathBuf::from(value)
    };
    std::fs::canonicalize(&expanded).map_err(|_| "source database is unreadable".to_string())
}

/// Opens a provider database the way every read of it opens: read-only, so the
/// Server can never checkpoint, vacuum or otherwise rewrite a file another
/// application owns, and with a busy timeout because that application is
/// normally running and writing while this reads.
fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "source database is unreadable".to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "source database is busy".to_string())?;
    Ok(connection)
}

/// Proves the file really is the provider database it claims to be, before a
/// row is written. Naming every column the importer will later read is what
/// makes this a schema check rather than a "does a table with this name exist"
/// check — a same-named table with different columns fails here rather than
/// importing nothing and looking healthy.
fn validate_source(kind: SourceKind, path: &Path) -> Result<(), String> {
    let adapter = kind.adapter();
    let connection = open_read_only(path)?;
    let wrong_shape = || format!("source database is not {}", adapter.describes);
    let mut statement = connection
        .prepare(&format!(
            "select {}, {}, {}, {}, {}, {} from {} limit 1",
            adapter.identity,
            adapter.started,
            adapter.ended,
            adapter.label,
            adapter.detail,
            adapter.idle,
            adapter.table,
        ))
        .map_err(|_| wrong_shape())?;
    statement.exists([]).map_err(|_| wrong_shape())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(get, path = "/v1/time/sources", responses((status = 200, body = [TimeSource])))]
pub async fn list_sources_handler(
    State(pool): State<PgPool>,
    State(runs): State<ImportRuns>,
) -> Result<Json<Vec<TimeSource>>, StatusCode> {
    let mut sources: Vec<TimeSource> = sqlx::query_as(LIST_SOURCES_SQL)
        .fetch_all(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for source in &mut sources {
        source.state = runs.state_for(source.id);
    }
    Ok(Json(sources))
}

#[utoipa::path(post, path = "/v1/time/sources", request_body = CreateTimeSource, responses((status = 201, body = TimeSource), (status = 400), (status = 409), (status = 423)))]
pub async fn create_source_handler(
    State(pool): State<PgPool>,
    State(ConfigLocked(locked)): State<ConfigLocked>,
    Json(input): Json<CreateTimeSource>,
) -> Result<(StatusCode, Json<TimeSource>), (StatusCode, String)> {
    if locked {
        return Err((StatusCode::LOCKED, "Server configuration is locked".into()));
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "a source name is required".into()));
    }
    let kind = SourceKind::from_wire(&input.kind).ok_or((
        StatusCode::BAD_REQUEST,
        "unsupported Time source kind".to_string(),
    ))?;

    let path = canonical_source_path(&input.path).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    validate_source(kind, &path).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let source = TimeSource {
        id: Uuid::new_v4(),
        name: name.to_owned(),
        kind: kind.as_wire().to_owned(),
        path: path.to_string_lossy().into_owned(),
        enabled: true,
        // A source that has just been saved has no import history yet; its
        // first run is queued by `spawn_import` below.
        last_attempt_at: None,
        last_success_at: None,
        last_inserted_count: 0,
        last_warning_count: 0,
        last_error: None,
        last_scheduled_run_on: None,
        state: SourceRunState::Queued,
    };
    sqlx::query("insert into time_sources (id,name,kind,path,enabled) values ($1,$2,$3,$4,$5)")
        .bind(source.id)
        .bind(&source.name)
        .bind(&source.kind)
        .bind(&source.path)
        .bind(source.enabled)
        .execute(&pool)
        .await
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                "a Time source already uses this path".into(),
            )
        })?;

    spawn_import(pool, source.id, kind, source.path.clone());
    Ok((StatusCode::CREATED, Json(source)))
}

/// What importing one source did.
#[derive(Debug, Default, Clone, Serialize, ToSchema)]
pub struct ImportOutcome {
    pub inserted: i32,
    pub warnings: i32,
    pub error: Option<String>,
}

/// Imports one source and records the outcome on its own row.
///
/// Never returns an error. A source that cannot be read is a fact about that
/// source, recorded against it, and the run moves on to the next one — one
/// failing recorder must not hide every other recorder's result (issue #421).
pub async fn import_source(
    pool: &PgPool,
    source_id: Uuid,
    kind: SourceKind,
    path: String,
) -> ImportOutcome {
    let _ = sqlx::query("update time_sources set last_attempt_at = now() where id = $1")
        .bind(source_id)
        .execute(pool)
        .await;

    // SQLite work stays on a blocking worker; the inserts use the async
    // Postgres pool after that worker returns, never `Handle::current()`.
    let read = tokio::task::spawn_blocking(move || read_source(kind, &path))
        .await
        .unwrap_or_else(|_| SourceRead {
            intervals: vec![],
            warnings: vec![],
            error: Some("the import worker stopped unexpectedly".into()),
        });

    let warnings = read.warnings.len() as i32;
    for warning in &read.warnings {
        tracing::warn!(source_id = %source_id, "time import: {warning}");
    }

    if let Some(error) = read.error {
        tracing::warn!(source_id = %source_id, "time import failed: {error}");
        let _ = sqlx::query(
            "update time_sources set last_warning_count = $2, last_error = $3 where id = $1",
        )
        .bind(source_id)
        .bind(warnings)
        .bind(&error)
        .execute(pool)
        .await;
        return ImportOutcome {
            inserted: 0,
            warnings,
            error: Some(error),
        };
    }

    let mut inserted = 0;
    for row in read.intervals {
        let result = sqlx::query(
            "insert into activity_intervals \
             (id, source_id, provider_record_id, started_at, ended_at, label, detail, idle, raw_row) \
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
             on conflict (source_id, provider_record_id) do nothing",
        )
        .bind(Uuid::new_v4())
        .bind(source_id)
        .bind(row.provider_record_id)
        .bind(row.started_at)
        .bind(row.ended_at)
        .bind(row.label)
        .bind(row.detail)
        .bind(row.idle)
        .bind(row.raw_row)
        .execute(pool)
        .await;
        // `do nothing` reports zero rows affected for a record already stored,
        // which is what makes a repeated refresh report honestly rather than
        // claiming to have imported the whole database again.
        if let Ok(done) = result {
            inserted += done.rows_affected() as i32;
        }
    }

    // `first_imported_at` is stamped only once, and only after a run that
    // actually succeeded: it is what closes the window in which a source's
    // kind and path may still be corrected (issue #423).
    let _ = sqlx::query(
        "update time_sources \
         set last_success_at = now(), last_inserted_count = $2, last_warning_count = $3, \
             last_error = null, first_imported_at = coalesce(first_imported_at, now()) \
         where id = $1",
    )
    .bind(source_id)
    .bind(inserted)
    .bind(warnings)
    .execute(pool)
    .await;

    ImportOutcome {
        inserted,
        warnings,
        error: None,
    }
}

/// Queues the all-history import for a newly configured or re-enabled source
/// without making the Settings request wait for it.
fn spawn_import(pool: PgPool, source_id: Uuid, kind: SourceKind, path: String) {
    tokio::spawn(async move {
        import_source(&pool, source_id, kind, path).await;
    });
}

// ---------------------------------------------------------------------------
// Refresh runs
// ---------------------------------------------------------------------------

/// Where a source is in the current refresh run, if there is one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SourceRunState {
    /// The default, and what a Server that has just started reports: run
    /// state is memory, so nothing is queued or running until something
    /// queues it.
    #[default]
    Idle,
    Queued,
    Running,
}

/// The one refresh run a Server may have in flight.
///
/// A plain `std::sync::Mutex` rather than an async one: nothing holds this
/// lock across an `await`. It is taken to decide whether a run may start, and
/// taken again, briefly, each time the run moves to the next source.
#[derive(Clone, Default)]
pub struct ImportRuns(std::sync::Arc<std::sync::Mutex<RunState>>);

#[derive(Default)]
pub struct RunState {
    running: bool,
    current: Option<Uuid>,
    queued: Vec<Uuid>,
}

impl ImportRuns {
    /// Claims the single run slot. `false` means one is already in flight —
    /// the caller must not start a second, because two runs over the same
    /// sources would race each other's writes.
    pub fn try_start(&self, sources: Vec<Uuid>) -> bool {
        let mut state = self.0.lock().expect("import run state is never poisoned");
        if state.running {
            return false;
        }
        state.running = true;
        state.current = None;
        state.queued = sources;
        true
    }

    fn begin(&self, source: Uuid) {
        let mut state = self.0.lock().expect("import run state is never poisoned");
        state.queued.retain(|queued| *queued != source);
        state.current = Some(source);
    }

    fn finish(&self) {
        let mut state = self.0.lock().expect("import run state is never poisoned");
        *state = RunState::default();
    }

    pub fn is_running(&self) -> bool {
        self.0
            .lock()
            .expect("import run state is never poisoned")
            .running
    }

    pub fn state_for(&self, source: Uuid) -> SourceRunState {
        let state = self.0.lock().expect("import run state is never poisoned");
        if state.current == Some(source) {
            SourceRunState::Running
        } else if state.queued.contains(&source) {
            SourceRunState::Queued
        } else {
            SourceRunState::Idle
        }
    }
}

// ---------------------------------------------------------------------------
// The nightly run (issue #422)
// ---------------------------------------------------------------------------

/// When the nightly import happens, in the Server's own timezone.
///
/// One minute before midnight, so a day's activity is imported while that day
/// is still the one the Server would call "today".
const NIGHTLY_HOUR: u32 = 23;
const NIGHTLY_MINUTE: u32 = 59;

/// The next nightly run strictly after `now`.
///
/// Strictly after, so a worker that wakes exactly on the boundary schedules
/// tomorrow rather than immediately re-running tonight — that loop is how a
/// scheduler ends up importing the same day over and over.
pub fn next_nightly_run(now: DateTime<Utc>, tz: Tz) -> DateTime<Utc> {
    let local_today = now.with_timezone(&tz).date_naive();
    for offset in 0..3 {
        let candidate = nightly_instant(local_today + Duration::days(offset), tz);
        if candidate > now {
            return candidate;
        }
    }
    // Unreachable for any real zone; never returning a past instant matters
    // more than the exact value, because a past instant means no sleep at all.
    now + Duration::days(1)
}

/// 23:59 on `day` in `tz`, as an instant.
fn nightly_instant(day: NaiveDate, tz: Tz) -> DateTime<Utc> {
    let naive = day
        .and_hms_opt(NIGHTLY_HOUR, NIGHTLY_MINUTE, 0)
        .expect("23:59 is a valid time");
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(at) => at.with_timezone(&Utc),
        // Ambiguous: the clock reads 23:59 twice tonight. The first is the
        // one that keeps the run inside the day it is importing.
        LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
        // Skipped: a zone that jumps across 23:59. Run at the first instant
        // that exists after it rather than not at all.
        LocalResult::None => first_existing_instant(naive, tz),
    }
}

/// The most recent Server-local day whose nightly run should already have
/// happened by `now`.
fn last_due_day(now: DateTime<Utc>, tz: Tz) -> NaiveDate {
    let local = now.with_timezone(&tz);
    let today = local.date_naive();
    if local >= nightly_instant(today, tz).with_timezone(&tz) {
        today
    } else {
        today - Duration::days(1)
    }
}

/// Whether startup should queue one catch-up import.
///
/// True when the night that has already passed never ran — the Server was
/// stopped or asleep across it. Several missed nights still answer `true`
/// once and are caught up by a single run, because the importer always
/// rescans the whole source and deduplicates: there is nothing a per-missed-day
/// loop would find that one pass does not.
pub fn needs_catch_up(last_scheduled_on: Option<NaiveDate>, now: DateTime<Utc>, tz: Tz) -> bool {
    match last_scheduled_on {
        None => true,
        Some(last) => last < last_due_day(now, tz),
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RefreshAccepted {
    /// How many enabled sources this run will import, in order.
    pub queued: usize,
}

#[utoipa::path(post, path = "/v1/time/refresh", responses((status = 202, body = RefreshAccepted), (status = 409), (status = 423)))]
pub async fn refresh_handler(
    State(pool): State<PgPool>,
    State(runs): State<ImportRuns>,
    State(ConfigLocked(locked)): State<ConfigLocked>,
) -> Result<(StatusCode, Json<RefreshAccepted>), (StatusCode, String)> {
    if locked {
        return Err((StatusCode::LOCKED, "Server configuration is locked".into()));
    }

    // Archived sources are excluded here rather than inside the run, so the
    // queued count a Device is told matches what will actually be imported.
    let enabled: Vec<(Uuid, String, String)> =
        sqlx::query_as("select id, kind, path from time_sources where enabled order by created_at")
            .fetch_all(&pool)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "could not list Time sources".to_string(),
                )
            })?;

    if !runs.try_start(enabled.iter().map(|(id, _, _)| *id).collect()) {
        return Err((
            StatusCode::CONFLICT,
            "an import is already running".to_string(),
        ));
    }

    let queued = enabled.len();
    tokio::spawn(async move { run_enabled_sources(&pool, &runs, enabled, None).await });

    Ok((StatusCode::ACCEPTED, Json(RefreshAccepted { queued })))
}

/// Every enabled source, imported one after another.
///
/// The one path all four triggers share — creating a source, Refresh now, the
/// nightly run and startup catch-up — so deduplication, error isolation and
/// the statuses a Device reads are identical however the run began (#422).
///
/// Serial, deliberately: two sources importing at once would contend for the
/// same Postgres pool and, worse, make "which source is running" unanswerable.
///
/// `scheduled_for` is `Some` only for the nightly and catch-up triggers. It is
/// what stamps `last_scheduled_run_on`, and so what lets a completed daily run
/// be told apart from a manual or initial import.
async fn run_enabled_sources(
    pool: &PgPool,
    runs: &ImportRuns,
    sources: Vec<(Uuid, String, String)>,
    scheduled_for: Option<NaiveDate>,
) {
    for (id, kind, path) in sources {
        let Some(kind) = SourceKind::from_wire(&kind) else {
            continue;
        };
        runs.begin(id);
        let outcome = import_source(pool, id, kind, path).await;
        // Only a source that actually imported has run for that day. One that
        // failed stays behind, so the next startup still counts the night as
        // missed and catches it up rather than recording a night that did not
        // happen.
        if let (Some(day), None) = (scheduled_for, outcome.error.as_ref()) {
            let _ = sqlx::query("update time_sources set last_scheduled_run_on = $2 where id = $1")
                .bind(id)
                .bind(day)
                .execute(pool)
                .await;
        }
    }
    runs.finish();
}

/// Lists the sources a run would import, in the order it would import them.
async fn enabled_sources(pool: &PgPool) -> Vec<(Uuid, String, String)> {
    sqlx::query_as("select id, kind, path from time_sources where enabled order by created_at")
        .fetch_all(pool)
        .await
        .unwrap_or_default()
}

/// Imports every enabled source and records the night it was for.
///
/// Returns `false` when a run was already in flight. A nightly tick that lands
/// while someone is pressing Refresh now is skipped rather than queued: the
/// run already happening reads the same databases, and the next tick is a day
/// away.
pub async fn run_scheduled_import(pool: &PgPool, runs: &ImportRuns, day: NaiveDate) -> bool {
    let sources = enabled_sources(pool).await;
    if !runs.try_start(sources.iter().map(|(id, _, _)| *id).collect()) {
        return false;
    }
    run_enabled_sources(pool, runs, sources, Some(day)).await;
    true
}

/// Runs one catch-up if the night that has already passed never happened.
///
/// Several missed nights still produce exactly one run: the importer rescans
/// the whole source and deduplicates, so there is nothing a per-missed-day
/// loop would find that one pass does not.
pub async fn catch_up_if_missed(
    pool: &PgPool,
    runs: &ImportRuns,
    tz: Tz,
    now: DateTime<Utc>,
) -> bool {
    let oldest: Option<Option<NaiveDate>> =
        sqlx::query_scalar("select min(last_scheduled_run_on) from time_sources where enabled")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    // No enabled sources at all is nothing to catch up, not a missed night.
    let has_sources: i64 = sqlx::query_scalar("select count(*) from time_sources where enabled")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    if has_sources == 0 {
        return false;
    }
    if !needs_catch_up(oldest.flatten(), now, tz) {
        return false;
    }
    run_scheduled_import(pool, runs, last_due_day(now, tz)).await
}

/// The long-lived worker that runs the nightly import.
///
/// Sleeps until the next 23:59 in the Server's timezone, computed fresh each
/// time round rather than by adding twenty-four hours: on a daylight-saving
/// day those differ by an hour, and the drift compounds.
pub fn spawn_nightly_worker(pool: PgPool, runs: ImportRuns, tz: Tz) {
    tokio::spawn(async move {
        // Startup catch-up first, so a Server that was off across last night
        // does not wait until tonight to notice.
        catch_up_if_missed(&pool, &runs, tz, Utc::now()).await;
        loop {
            let now = Utc::now();
            let next = next_nightly_run(now, tz);
            let wait = (next - now).to_std().unwrap_or(std::time::Duration::ZERO);
            tokio::time::sleep(wait).await;
            let day = last_due_day(Utc::now(), tz);
            run_scheduled_import(&pool, &runs, day).await;
        }
    });
}

#[utoipa::path(patch, path = "/v1/time/sources/{id}", request_body = UpdateTimeSource, params(("id" = Uuid, Path)), responses((status = 200, body = TimeSource), (status = 400), (status = 404), (status = 409), (status = 423)))]
pub async fn update_source_handler(
    State(pool): State<PgPool>,
    State(ConfigLocked(locked)): State<ConfigLocked>,
    AxumPath(id): AxumPath<Uuid>,
    Json(input): Json<UpdateTimeSource>,
) -> Result<Json<TimeSource>, (StatusCode, String)> {
    if locked {
        return Err((StatusCode::LOCKED, "Server configuration is locked".into()));
    }

    let lookup_failed = || {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "lookup failed".to_string(),
        )
    };
    let current: Option<TimeSource> = sqlx::query_as(SOURCE_BY_ID_SQL)
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| lookup_failed())?;
    let current = current.ok_or((StatusCode::NOT_FOUND, "no such Time source".to_string()))?;

    // Read separately rather than widened into `TimeSource`: when a source
    // first imported is the Server's own bookkeeping, not something a Device
    // has any use for.
    let first_imported_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("select first_imported_at from time_sources where id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .map_err(|_| lookup_failed())?;

    let was_enabled = current.enabled;
    let mut next = current.clone();

    if let Some(name) = input.name.as_deref() {
        let name = name.trim();
        if name.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "a source name is required".into()));
        }
        // A name is a label, not an identity — renaming an archived recorder
        // stays allowed however long ago it last imported.
        next.name = name.to_owned();
    }
    if let Some(enabled) = input.enabled {
        next.enabled = enabled;
    }

    let repointing = input.kind.is_some() || input.path.is_some();
    if repointing {
        if first_imported_at.is_some() {
            return Err((
                StatusCode::CONFLICT,
                "this Time source has already imported; add a new source for a different database"
                    .into(),
            ));
        }
        if let Some(kind) = input.kind.as_deref() {
            SourceKind::from_wire(kind).ok_or((
                StatusCode::BAD_REQUEST,
                "unsupported Time source kind".to_string(),
            ))?;
            next.kind = kind.to_owned();
        }
        if let Some(path) = input.path.as_deref() {
            let path = canonical_source_path(path).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            next.path = path.to_string_lossy().into_owned();
        }
        // Re-validated as a pair: a kind that was fine for the old path can be
        // wrong for the new one, and vice versa.
        let kind = SourceKind::from_wire(&next.kind).expect("stored kind is always a known kind");
        validate_source(kind, Path::new(&next.path)).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }

    sqlx::query(
        "update time_sources set name = $2, kind = $3, path = $4, enabled = $5 where id = $1",
    )
    .bind(next.id)
    .bind(&next.name)
    .bind(&next.kind)
    .bind(&next.path)
    .bind(next.enabled)
    .execute(&pool)
    .await
    .map_err(|_| {
        (
            StatusCode::CONFLICT,
            "a Time source already uses this path".to_string(),
        )
    })?;

    // Re-enabling resumes importing where the uniqueness boundary left off:
    // the source keeps its identity, so everything already stored is skipped
    // by `on conflict do nothing` and only what arrived meanwhile is inserted.
    if next.enabled && !was_enabled {
        let kind = SourceKind::from_wire(&next.kind).expect("stored kind is always a known kind");
        spawn_import(pool, next.id, kind, next.path.clone());
    }

    Ok(Json(next))
}

/// The first instant of `day` in `tz`.
///
/// Daylight saving makes this more than `date.and_hms(0,0,0)`. In a zone that
/// springs forward *at* midnight — America/Santiago does — local midnight does
/// not exist on that date at all, and the day begins at the instant the clock
/// jumped to. In a zone that falls back across midnight there are two local
/// midnights, and the day begins at the first. Neither case may be an error:
/// a Device asking for an ordinary calendar date must get an answer.
fn zoned_day_start(day: NaiveDate, tz: Tz) -> DateTime<Utc> {
    let midnight = day
        .and_hms_opt(0, 0, 0)
        .expect("midnight is a valid time on every date");
    match tz.from_local_datetime(&midnight) {
        LocalResult::Single(at) => at.with_timezone(&Utc),
        // Ambiguous: the clock reads this twice. The day starts the first time.
        LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
        // Skipped: walk forward to the first local time that does exist.
        LocalResult::None => first_existing_instant(midnight, tz),
    }
}

/// Walks forward in fifteen-minute steps to the first local time that exists.
/// Every real transition is a whole number of quarter hours and at most two
/// hours wide, so six hours of steps is a wide margin rather than a guess.
fn first_existing_instant(from: NaiveDateTime, tz: Tz) -> DateTime<Utc> {
    for step in 1..=24 {
        let candidate = from + Duration::minutes(15 * step);
        match tz.from_local_datetime(&candidate) {
            LocalResult::Single(at) => return at.with_timezone(&Utc),
            LocalResult::Ambiguous(first, _) => return first.with_timezone(&Utc),
            LocalResult::None => continue,
        }
    }
    // Unreachable for any real zone; falling back to UTC keeps a Device that
    // asked for a date from getting an error instead of a day.
    Utc.from_utc_datetime(&from)
}

/// The half-open instant range one calendar date covers in `tz`.
///
/// The end is the *next date's* start rather than "start plus 24 hours", so a
/// daylight-saving day is correctly 23 or 25 hours long instead of silently
/// losing or double-counting an hour of recorded activity.
pub fn day_bounds(day: NaiveDate, tz: Tz) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = zoned_day_start(day, tz);
    let end = zoned_day_start(day + Duration::days(1), tz);
    (start, end)
}

#[utoipa::path(get, path = "/v1/time/intervals", params(IntervalQuery), responses((status = 200, body = [ActivityInterval])))]
pub async fn list_intervals_handler(
    State(pool): State<PgPool>,
    State(ServerTimezone(tz)): State<ServerTimezone>,
    Query(query): Query<IntervalQuery>,
) -> Result<Json<Vec<ActivityInterval>>, StatusCode> {
    let day =
        NaiveDate::parse_from_str(&query.day, "%Y-%m-%d").map_err(|_| StatusCode::BAD_REQUEST)?;
    let (start, end) = day_bounds(day, tz);
    let sources = parse_source_ids(query.source_ids.as_deref())?;
    let search = normalised_search(query.q.as_deref());

    sqlx::query_as(LIST_INTERVALS_SQL)
        .bind(start)
        .bind(end)
        .bind(sources)
        .bind(search)
        .fetch_all(&pool)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// `None` (every source) or an explicit list, which may be empty.
///
/// The empty list is not folded into `None`: a reader who has switched every
/// lane off has asked for nothing, and answering with everything would be the
/// opposite of what they did.
fn parse_source_ids(value: Option<&str>) -> Result<Option<Vec<Uuid>>, StatusCode> {
    let Some(raw) = value else {
        return Ok(None);
    };
    raw.split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| Uuid::parse_str(part).map_err(|_| StatusCode::BAD_REQUEST))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// A search term as a SQL `ilike` pattern, or `None` when there is nothing to
/// search for. Whitespace-only input is nothing, not a match-everything
/// pattern — a search box that has been cleared should show the whole day.
fn normalised_search(value: Option<&str>) -> Option<String> {
    let term = value?.trim();
    if term.is_empty() {
        return None;
    }
    // Escape the wildcards so a literal % or _ in a window title searches for
    // itself rather than matching everything.
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Some(format!("%{escaped}%"))
}

/// The single-interval route's own row. `ActivityIntervalDetail` cannot be
/// queried directly because `#[serde(flatten)]` puts the normalized fields one
/// level down, while the query returns them and `raw_row` side by side.
#[derive(sqlx::FromRow)]
struct IntervalDetailRow {
    #[sqlx(flatten)]
    interval: ActivityInterval,
    raw_row: Value,
}

#[utoipa::path(get, path = "/v1/time/intervals/{id}", params(("id" = Uuid, Path)), responses((status = 200, body = ActivityIntervalDetail), (status = 404)))]
pub async fn interval_detail_handler(
    State(pool): State<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<ActivityIntervalDetail>, StatusCode> {
    let row: Option<IntervalDetailRow> = sqlx::query_as(INTERVAL_DETAIL_SQL)
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    row.map(|row| {
        Json(ActivityIntervalDetail {
            interval: row.interval,
            raw_row: row.raw_row,
        })
    })
    .ok_or(StatusCode::NOT_FOUND)
}

// ---------------------------------------------------------------------------
// Reading a provider database
// ---------------------------------------------------------------------------

/// One provider record, normalized but not yet stored.
pub struct ImportedInterval {
    pub provider_record_id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub label: String,
    pub detail: Option<String>,
    pub idle: bool,
    pub raw_row: Value,
}

fn uuid_hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The provider's own identifier for a record, as a string, whatever SQLite
/// storage class it happens to be kept in. Toggl stores a BLOB and Clockify
/// stores 24 hex characters of text; both have to survive into a stable
/// external identity, because that identity is half of the uniqueness boundary
/// that makes re-importing idempotent.
fn provider_identity(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Some(uuid_hex(bytes)),
        ValueRef::Integer(number) => Some(number.to_string()),
        // A record with no identity cannot be deduplicated, so it is skipped
        // rather than imported under a made-up one.
        ValueRef::Real(_) | ValueRef::Null => None,
    }
}

fn apple_timestamp(seconds: f64) -> Option<DateTime<Utc>> {
    Utc.timestamp_opt(
        APPLE_EPOCH + seconds.trunc() as i64,
        (seconds.fract() * 1e9) as u32,
    )
    .single()
}

fn raw_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => json!({"type":"null"}),
        ValueRef::Integer(v) => json!({"type":"integer","value":v}),
        ValueRef::Real(v) => json!({"type":"real","value":v}),
        ValueRef::Text(v) => json!({"type":"text","value":String::from_utf8_lossy(v)}),
        ValueRef::Blob(v) => json!({"type":"blob","base64":base64(v)}),
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for part in bytes.chunks(3) {
        let n = ((part[0] as u32) << 16)
            | ((part.get(1).copied().unwrap_or(0) as u32) << 8)
            | part.get(2).copied().unwrap_or(0) as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if part.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if part.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// What one pass over a provider database found.
pub struct SourceRead {
    pub intervals: Vec<ImportedInterval>,
    /// Rows that could not be made sense of and were skipped. Skipping is the
    /// right answer — one unreadable row must not stop the rest of a day's
    /// evidence importing — but skipping *silently* is not, so each one is
    /// described and counted (issue #421).
    pub warnings: Vec<String>,
    /// Why nothing could be read at all: the database vanished, is locked by
    /// something that will not let go, or no longer has the shape it had when
    /// the source was configured.
    pub error: Option<String>,
}

/// Reads every closed record out of one provider database.
///
/// A record still being recorded has no end yet, and is left for a later
/// import rather than being given one — an importer that treated a missing end
/// as "now" would mint an interval that changed length every time it was read.
/// Deferring such a record is not a warning: it is the ordinary state of the
/// one the recorder is writing right now.
fn read_source(kind: SourceKind, path: &str) -> SourceRead {
    let adapter = kind.adapter();
    let failed = |message: &str| SourceRead {
        intervals: vec![],
        warnings: vec![],
        error: Some(message.to_string()),
    };
    let connection = match open_read_only(Path::new(path)) {
        Ok(connection) => connection,
        Err(message) => return failed(&message),
    };
    // `select *` rather than the six mapped columns: the whole row is kept as
    // evidence, including the columns nothing has found a use for yet.
    let Ok(mut statement) = connection.prepare(&format!(
        "select * from {} where {} is not null",
        adapter.table, adapter.ended
    )) else {
        return failed("source database no longer has the shape it was configured with");
    };
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(ToString::to_string)
        .collect();

    let rows = statement.query_map([], |row| {
        let raw = columns
            .iter()
            .enumerate()
            .map(|(index, column)| Ok((column.clone(), raw_value(row.get_ref(index)?))))
            .collect::<rusqlite::Result<Map<String, Value>>>()?;
        Ok((
            provider_identity(row.get_ref(adapter.identity)?),
            row.get::<_, f64>(adapter.started)?,
            row.get::<_, f64>(adapter.ended)?,
            row.get::<_, String>(adapter.label)?,
            row.get::<_, Option<String>>(adapter.detail)?,
            // Toggl's flag and Clockify's idle-seconds count read the same way
            // here: anything non-zero means the recorder reported idleness.
            row.get::<_, Option<f64>>(adapter.idle)?.unwrap_or(0.0) != 0.0,
            Value::Object(raw),
        ))
    });
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return failed("source database could not be read"),
    };

    let mut intervals = Vec::new();
    let mut warnings = Vec::new();
    for row in rows {
        match row {
            // A column the adapter maps is missing, or holds a type it cannot
            // be read as. The row is evidence nobody can interpret, so it is
            // skipped — and said out loud rather than vanishing.
            Err(error) => warnings.push(format!("a record could not be read: {error}")),
            Ok((identity, start, end, label, detail, idle, raw_row)) => {
                let Some(provider_record_id) = identity else {
                    warnings
                        .push("a record has no provider identity and cannot be imported".into());
                    continue;
                };
                if end <= start {
                    warnings.push(format!(
                        "record {provider_record_id} ends before it starts and was skipped"
                    ));
                    continue;
                }
                let (Some(started_at), Some(ended_at)) =
                    (apple_timestamp(start), apple_timestamp(end))
                else {
                    warnings.push(format!(
                        "record {provider_record_id} has a timestamp outside any representable instant"
                    ));
                    continue;
                };
                intervals.push(ImportedInterval {
                    provider_record_id,
                    started_at,
                    ended_at,
                    label,
                    detail,
                    idle,
                    raw_row,
                });
            }
        }
    }

    SourceRead {
        intervals,
        warnings,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_core_data_seconds_with_fractional_precision() {
        assert_eq!(
            apple_timestamp(0.25).unwrap().to_rfc3339(),
            "2001-01-01T00:00:00.250+00:00"
        );
    }

    #[test]
    fn encodes_binary_raw_values_without_loss() {
        assert_eq!(base64(&[0, 255, 1]), "AP8B");
    }

    #[test]
    fn reads_a_provider_identity_out_of_either_storage_class() {
        // Toggl keeps a BLOB here and Clockify keeps text, so both have to
        // land on a stable string without the caller knowing which it got.
        assert_eq!(
            provider_identity(ValueRef::Blob(&[0xaa, 0x0b])),
            Some("aa0b".to_string())
        );
        assert_eq!(
            provider_identity(ValueRef::Text(b"68cf0a1b2c3d4e5f60718293")),
            Some("68cf0a1b2c3d4e5f60718293".to_string())
        );
        assert_eq!(provider_identity(ValueRef::Null), None);
    }

    /// Every expected instant below was computed independently with Python's
    /// `zoneinfo` against the same IANA data, not read back out of this
    /// module. A test that asked `day_bounds` what `day_bounds` should say
    /// would agree with it however wrong it was.
    fn bounds_of(zone: &str, date: (i32, u32, u32)) -> (String, String, f64) {
        let tz: Tz = zone.parse().unwrap();
        let day = NaiveDate::from_ymd_opt(date.0, date.1, date.2).unwrap();
        let (start, end) = day_bounds(day, tz);
        (
            start.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            end.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            (end - start).num_minutes() as f64 / 60.0,
        )
    }

    #[test]
    fn an_ordinary_day_runs_local_midnight_to_local_midnight() {
        assert_eq!(
            bounds_of("UTC", (2026, 3, 15)),
            (
                "2026-03-15T00:00:00Z".into(),
                "2026-03-16T00:00:00Z".into(),
                24.0
            )
        );
        // A fixed-offset zone: the same calendar date names a different pair
        // of instants, which is the whole reason the boundary is the
        // Server's answer rather than each Device's.
        assert_eq!(
            bounds_of("Asia/Kolkata", (2026, 3, 15)),
            (
                "2026-03-14T18:30:00Z".into(),
                "2026-03-15T18:30:00Z".into(),
                24.0
            )
        );
    }

    #[test]
    fn a_daylight_saving_day_is_twenty_three_or_twenty_five_hours_long() {
        // The claim "end is the next date's start", not "start plus 24 hours".
        // Adding a fixed day would lose an hour of recorded activity in spring
        // and count an hour twice in autumn.
        assert_eq!(
            bounds_of("Europe/London", (2026, 3, 29)),
            (
                "2026-03-29T00:00:00Z".into(),
                "2026-03-29T23:00:00Z".into(),
                23.0
            )
        );
        assert_eq!(
            bounds_of("America/New_York", (2026, 11, 1)),
            (
                "2026-11-01T04:00:00Z".into(),
                "2026-11-02T05:00:00Z".into(),
                25.0
            )
        );
    }

    #[test]
    fn a_day_whose_local_midnight_never_happened_starts_when_the_clock_jumped() {
        // Cuba and Chile move their clocks forward *at* midnight, so on these
        // dates 00:00 local does not exist at all. The day has to begin at the
        // instant the clock jumped to — 01:00 local — rather than the request
        // failing, because a Device asked for an ordinary calendar date.
        assert_eq!(
            bounds_of("America/Havana", (2026, 3, 8)),
            (
                "2026-03-08T05:00:00Z".into(),
                "2026-03-09T04:00:00Z".into(),
                23.0
            )
        );
        assert_eq!(
            bounds_of("America/Santiago", (2026, 9, 6)),
            (
                "2026-09-06T04:00:00Z".into(),
                "2026-09-07T03:00:00Z".into(),
                23.0
            )
        );
    }

    #[test]
    fn a_day_with_two_local_midnights_starts_at_the_first() {
        // Havana falls back at 01:00, so 2026-11-01 has one midnight; Lord
        // Howe and others differ. What matters is that an ambiguous local time
        // resolves to the earlier instant, so the day contains both readings
        // of the repeated hour rather than starting after the first of them.
        let tz: Tz = "America/Havana".parse().unwrap();
        let (start, end) = day_bounds(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), tz);
        assert!(end - start >= Duration::hours(24));
        assert_eq!(
            start.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "2026-11-01T04:00:00Z"
        );
    }

    #[test]
    fn consecutive_days_meet_exactly_with_no_gap_or_overlap() {
        // Whatever the zone does, one day's end has to be the next one's
        // start: a gap would drop recorded activity that belongs to neither
        // day, and an overlap would show the same record on two days that do
        // not actually share an instant.
        for zone in [
            "UTC",
            "Asia/Kolkata",
            "Europe/London",
            "America/Santiago",
            "America/Havana",
        ] {
            let tz: Tz = zone.parse().unwrap();
            let mut day = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
            for _ in 0..400 {
                let (_, end) = day_bounds(day, tz);
                let (next_start, _) = day_bounds(day + Duration::days(1), tz);
                assert_eq!(end, next_start, "{zone} leaves a seam after {day}");
                day += Duration::days(1);
            }
        }
    }

    /// An instant stated as a wall clock in a zone, for the schedule tests.
    fn at(zone: &str, y: i32, m: u32, d: u32, hour: u32, minute: u32) -> DateTime<Utc> {
        let tz: Tz = zone.parse().unwrap();
        tz.from_local_datetime(
            &NaiveDate::from_ymd_opt(y, m, d)
                .unwrap()
                .and_hms_opt(hour, minute, 0)
                .unwrap(),
        )
        .earliest()
        .unwrap()
        .with_timezone(&Utc)
    }

    fn local_string(instant: DateTime<Utc>, zone: &str) -> String {
        let tz: Tz = zone.parse().unwrap();
        instant
            .with_timezone(&tz)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    }

    #[test]
    fn the_nightly_run_is_one_minute_before_the_servers_own_midnight() {
        // Not UTC's midnight: a Server in Asia/Kolkata importing at 23:59 UTC
        // would be importing at 05:29 the following morning, local — the
        // middle of the day it had already called tomorrow.
        let zone = "Asia/Kolkata";
        let next = next_nightly_run(at(zone, 2026, 3, 15, 10, 0), zone.parse().unwrap());
        assert_eq!(local_string(next, zone), "2026-03-15 23:59");
    }

    #[test]
    fn waking_exactly_on_the_boundary_schedules_tomorrow_not_now() {
        // `next` is strictly after `now`. A worker that returned the instant
        // it just woke on would re-run the same night in a tight loop.
        let zone = "UTC";
        let boundary = at(zone, 2026, 3, 15, 23, 59);
        let next = next_nightly_run(boundary, zone.parse().unwrap());
        assert!(next > boundary);
        assert_eq!(local_string(next, zone), "2026-03-16 23:59");
    }

    #[test]
    fn a_daylight_saving_night_still_gets_exactly_one_run() {
        // Computed fresh each time round rather than by adding 24 hours: on a
        // 23- or 25-hour day those differ, and the drift compounds until the
        // "nightly" run lands in the afternoon.
        for zone in ["Europe/London", "America/New_York", "America/Santiago"] {
            let tz: Tz = zone.parse().unwrap();
            let mut now = at(zone, 2026, 3, 1, 12, 0);
            let mut seen = Vec::new();
            for _ in 0..400 {
                let next = next_nightly_run(now, tz);
                assert!(next > now, "{zone} scheduled a run in the past");
                let local = next.with_timezone(&tz);
                seen.push(local.date_naive());
                assert_eq!(
                    (local.hour(), local.minute()),
                    (23, 59),
                    "{zone} drifted off 23:59 at {local}"
                );
                now = next;
            }
            // One run per day, never two for the same date and never a
            // skipped one.
            let mut dates = seen.clone();
            dates.dedup();
            assert_eq!(dates.len(), seen.len(), "{zone} ran the same night twice");
            for pair in seen.windows(2) {
                assert_eq!(
                    pair[1],
                    pair[0] + Duration::days(1),
                    "{zone} skipped a night between {} and {}",
                    pair[0],
                    pair[1]
                );
            }
        }
    }

    #[test]
    fn a_server_that_was_off_across_last_night_catches_up_once() {
        let zone = "Asia/Kolkata";
        let tz: Tz = zone.parse().unwrap();
        let morning = at(zone, 2026, 3, 16, 9, 0);
        let yesterday = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();

        // Last night ran: nothing to catch up.
        assert!(!needs_catch_up(Some(yesterday), morning, tz));
        // It did not: catch up.
        assert!(needs_catch_up(
            Some(yesterday - Duration::days(1)),
            morning,
            tz
        ));
        // Several nights missed is still one catch-up, not one per night —
        // the importer rescans and deduplicates, so one pass finds everything.
        assert!(needs_catch_up(
            Some(yesterday - Duration::days(30)),
            morning,
            tz
        ));
        // A source that has never had a scheduled run has one owing.
        assert!(needs_catch_up(None, morning, tz));
    }

    #[test]
    fn restarting_after_tonights_run_does_not_run_it_again() {
        // The night of the 15th has already happened by 23:59:30 on the 15th,
        // so a Server restarted at 23:59:40 must not import it a second time.
        let zone = "UTC";
        let tz: Tz = zone.parse().unwrap();
        let tonight = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
        let after = at(zone, 2026, 3, 15, 23, 59) + Duration::seconds(40);

        assert!(!needs_catch_up(Some(tonight), after, tz));
        // And restarting repeatedly keeps answering the same way.
        assert!(!needs_catch_up(
            Some(tonight),
            after + Duration::minutes(1),
            tz
        ));
    }

    #[test]
    fn before_tonights_run_the_night_that_is_owed_is_yesterdays() {
        // At 10:00 the run due is last night's, not tonight's — a Server
        // started this morning has not missed anything yet today.
        let zone = "UTC";
        let tz: Tz = zone.parse().unwrap();
        let yesterday = NaiveDate::from_ymd_opt(2026, 3, 14).unwrap();
        let morning = at(zone, 2026, 3, 15, 10, 0);

        assert!(!needs_catch_up(Some(yesterday), morning, tz));
        assert!(needs_catch_up(
            Some(yesterday - Duration::days(1)),
            morning,
            tz
        ));
    }

    #[test]
    fn a_search_term_is_a_pattern_only_when_there_is_something_to_search_for() {
        assert_eq!(normalised_search(None), None);
        assert_eq!(normalised_search(Some("   ")), None);
        assert_eq!(
            normalised_search(Some(" xcode ")),
            Some("%xcode%".to_string())
        );
        // A literal wildcard in a window title searches for itself. Without
        // this, typing "%" would match every record of the day.
        assert_eq!(
            normalised_search(Some("100%")),
            Some("%100\\%%".to_string())
        );
        assert_eq!(normalised_search(Some("a_b")), Some("%a\\_b%".to_string()));
    }

    #[test]
    fn an_empty_source_selection_is_not_the_same_as_no_selection() {
        // Absent means "every source". Present-but-empty means the reader has
        // switched every lane off, and answering that with everything would be
        // the opposite of what they asked for.
        assert_eq!(parse_source_ids(None).unwrap(), None);
        assert_eq!(parse_source_ids(Some("")).unwrap(), Some(vec![]));
        let one = Uuid::new_v4();
        assert_eq!(
            parse_source_ids(Some(&format!(" {one} , "))).unwrap(),
            Some(vec![one])
        );
        assert!(parse_source_ids(Some("not-a-uuid")).is_err());
    }

    #[test]
    fn every_wire_kind_round_trips_through_its_adapter() {
        for kind in [SourceKind::TogglActivity, SourceKind::ClockifyAutoTracker] {
            assert_eq!(SourceKind::from_wire(kind.as_wire()), Some(kind));
        }
        assert_eq!(SourceKind::from_wire("rescuetime"), None);
    }
}
