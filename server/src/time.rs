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
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::ConfigLocked;

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
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateTimeSource {
    pub name: String,
    pub kind: String,
    pub path: String,
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
    pub day: String,
    pub source_id: Option<Uuid>,
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
        and ($3::uuid is null or i.source_id = $3) \
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
) -> Result<Json<Vec<TimeSource>>, StatusCode> {
    sqlx::query_as("select id, name, kind, path, enabled from time_sources order by created_at")
        .fetch_all(&pool)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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

/// Queues the all-history import for a newly configured source without making
/// the Settings request wait for it. Two recorders can be configured back to
/// back and neither blocks the other; the `(source_id, provider_record_id)`
/// uniqueness boundary is what keeps repeated runs from duplicating.
fn spawn_import(pool: PgPool, source_id: Uuid, kind: SourceKind, path: String) {
    tokio::spawn(async move {
        // SQLite work stays on a blocking worker; the inserts use the async
        // Postgres pool after that worker returns, never `Handle::current()`.
        let rows = tokio::task::spawn_blocking(move || read_source(kind, &path))
            .await
            .unwrap_or_default();
        for row in rows {
            let _ = sqlx::query(
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
            .execute(&pool)
            .await;
        }
    });
}

#[utoipa::path(get, path = "/v1/time/intervals", params(IntervalQuery), responses((status = 200, body = [ActivityInterval])))]
pub async fn list_intervals_handler(
    State(pool): State<PgPool>,
    Query(query): Query<IntervalQuery>,
) -> Result<Json<Vec<ActivityInterval>>, StatusCode> {
    let day =
        NaiveDate::parse_from_str(&query.day, "%Y-%m-%d").map_err(|_| StatusCode::BAD_REQUEST)?;
    let start = Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).unwrap());
    let end = start + Duration::days(1);

    sqlx::query_as(LIST_INTERVALS_SQL)
        .bind(start)
        .bind(end)
        .bind(query.source_id)
        .fetch_all(&pool)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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
struct ImportedInterval {
    provider_record_id: String,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    label: String,
    detail: Option<String>,
    idle: bool,
    raw_row: Value,
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

/// Reads every closed record out of one provider database.
///
/// A record still being recorded has no end yet, and is left for a later
/// import rather than being given one — an importer that treated a missing end
/// as "now" would mint an interval that changed length every time it was read.
fn read_source(kind: SourceKind, path: &str) -> Vec<ImportedInterval> {
    let adapter = kind.adapter();
    let Ok(connection) = open_read_only(Path::new(path)) else {
        return vec![];
    };
    // `select *` rather than the six mapped columns: the whole row is kept as
    // evidence, including the columns nothing has found a use for yet.
    let Ok(mut statement) = connection.prepare(&format!(
        "select * from {} where {} is not null",
        adapter.table, adapter.ended
    )) else {
        return vec![];
    };
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(ToString::to_string)
        .collect();

    let Ok(rows) = statement.query_map([], |row| {
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
    }) else {
        return vec![];
    };

    rows.flatten()
        .filter_map(|(identity, start, end, label, detail, idle, raw_row)| {
            (end > start).then_some(ImportedInterval {
                provider_record_id: identity?,
                started_at: apple_timestamp(start)?,
                ended_at: apple_timestamp(end)?,
                label,
                detail,
                idle,
                raw_row,
            })
        })
        .collect()
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

    #[test]
    fn every_wire_kind_round_trips_through_its_adapter() {
        for kind in [SourceKind::TogglActivity, SourceKind::ClockifyAutoTracker] {
            assert_eq!(SourceKind::from_wire(kind.as_wire()), Some(kind));
        }
        assert_eq!(SourceKind::from_wire("rescuetime"), None);
    }
}
