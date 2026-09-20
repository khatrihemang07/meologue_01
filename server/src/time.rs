//! Server-owned Time source configuration and Toggl Activity import.

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

#[derive(Debug, Clone, Serialize, sqlx::FromRow, ToSchema)]
pub struct ActivityInterval {
    pub id: Uuid,
    pub source_id: Uuid,
    pub provider_record_id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub label: String,
    pub detail: Option<String>,
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

fn canonical_source_path(value: &str) -> Result<PathBuf, String> {
    let expanded = if value == "~" || value.starts_with("~/") {
        let home = std::env::var("HOME").map_err(|_| "cannot expand ~ without HOME")?;
        PathBuf::from(home).join(value.strip_prefix("~/").unwrap_or(""))
    } else {
        PathBuf::from(value)
    };
    std::fs::canonicalize(&expanded).map_err(|_| "source database is unreadable".to_string())
}

fn validate_toggl(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "source database is unreadable".to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "source database is busy".to_string())?;
    let mut statement = connection
        .prepare("select ZID, ZSTART, ZEND, ZFILENAME, ZTITLE from ZMANAGEDACTIVITY limit 1")
        .map_err(|_| "source database is not a Toggl Activity Recording database".to_string())?;
    statement
        .exists([])
        .map_err(|_| "source database is not a Toggl Activity Recording database".to_string())?;
    Ok(())
}

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

#[utoipa::path(post, path = "/v1/time/sources", request_body = CreateTimeSource, responses((status = 201, body = TimeSource), (status = 400), (status = 423)))]
pub async fn create_source_handler(
    State(pool): State<PgPool>,
    State(ConfigLocked(locked)): State<ConfigLocked>,
    Json(input): Json<CreateTimeSource>,
) -> Result<(StatusCode, Json<TimeSource>), (StatusCode, String)> {
    if locked {
        return Err((StatusCode::LOCKED, "Server configuration is locked".into()));
    }
    if input.name.trim().is_empty() || input.kind != "toggl_activity" {
        return Err((
            StatusCode::BAD_REQUEST,
            "name and toggl_activity kind are required".into(),
        ));
    }
    let path = canonical_source_path(&input.path).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    validate_toggl(&path).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let source = TimeSource {
        id: Uuid::new_v4(),
        name: input.name.trim().to_owned(),
        kind: input.kind,
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
    let import_source = source.clone();
    let import_pool = pool.clone();
    tokio::spawn(async move {
        // SQLite work stays on a blocking worker; inserts use the async
        // Postgres pool after the worker returns, never Handle::current().
        let rows = tokio::task::spawn_blocking({
            let path = import_source.path.clone();
            move || read_toggl(&path)
        })
        .await
        .unwrap_or_default();
        for (provider_record_id, started_at, ended_at, label, detail, raw_row) in rows {
            let _ = sqlx::query("insert into activity_intervals (id,source_id,provider_record_id,started_at,ended_at,label,detail,raw_row) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (source_id,provider_record_id) do nothing")
                .bind(Uuid::new_v4()).bind(import_source.id).bind(provider_record_id).bind(started_at).bind(ended_at).bind(label).bind(detail).bind(raw_row).execute(&import_pool).await;
        }
    });
    Ok((StatusCode::CREATED, Json(source)))
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
    sqlx::query_as("select id,source_id,provider_record_id,started_at,ended_at,label,detail from activity_intervals where started_at < $2 and ended_at > $1 and ($3::uuid is null or source_id=$3) order by started_at")
        .bind(start).bind(end).bind(query.source_id).fetch_all(&pool).await.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// The single-interval route's own row. `ActivityIntervalDetail` cannot be
/// queried directly because `#[serde(flatten)]` puts the normalized fields one
/// level down, while the table stores them and `raw_row` side by side.
#[derive(sqlx::FromRow)]
struct IntervalDetailRow {
    id: Uuid,
    source_id: Uuid,
    provider_record_id: String,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    label: String,
    detail: Option<String>,
    raw_row: Value,
}

#[utoipa::path(get, path = "/v1/time/intervals/{id}", params(("id" = Uuid, Path)), responses((status = 200, body = ActivityIntervalDetail), (status = 404)))]
pub async fn interval_detail_handler(
    State(pool): State<PgPool>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<ActivityIntervalDetail>, StatusCode> {
    let row: Option<IntervalDetailRow> = sqlx::query_as(
        "select id, source_id, provider_record_id, started_at, ended_at, label, detail, raw_row \
         from activity_intervals where id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    row.map(|row| {
        Json(ActivityIntervalDetail {
            interval: ActivityInterval {
                id: row.id,
                source_id: row.source_id,
                provider_record_id: row.provider_record_id,
                started_at: row.started_at,
                ended_at: row.ended_at,
                label: row.label,
                detail: row.detail,
            },
            raw_row: row.raw_row,
        })
    })
    .ok_or(StatusCode::NOT_FOUND)
}

fn uuid_hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
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

type TogglRow = (
    String,
    DateTime<Utc>,
    DateTime<Utc>,
    String,
    Option<String>,
    Value,
);

fn read_toggl(path: &str) -> Vec<TogglRow> {
    let Ok(connection) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let _ = connection.busy_timeout(std::time::Duration::from_secs(2));
    let Ok(mut statement) =
        connection.prepare("select * from ZMANAGEDACTIVITY where ZEND is not null")
    else {
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
            .map(|(i, column)| Ok((column.clone(), raw_value(row.get_ref(i)?))))
            .collect::<rusqlite::Result<Map<String, Value>>>()?;
        let id: Vec<u8> = row.get("ZID")?;
        let start: f64 = row.get("ZSTART")?;
        let end: f64 = row.get("ZEND")?;
        let label: String = row.get("ZFILENAME")?;
        let detail: Option<String> = row.get("ZTITLE")?;
        Ok((uuid_hex(&id), start, end, label, detail, Value::Object(raw)))
    }) else {
        return vec![];
    };
    rows.flatten()
        .filter_map(|(provider, start, end, label, detail, raw)| {
            (end > start).then_some((
                provider,
                apple_timestamp(start)?,
                apple_timestamp(end)?,
                label,
                detail,
                raw,
            ))
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
}
