//! All timezone and calendar maths for Digests lives here, and nowhere
//! else — see CONTEXT.md's Period entry and `docs/adr/0027`. This module
//! is pure: no database, no LLM, no `Utc::now()` called internally (every
//! function that needs "now" takes it as a parameter, so tests are
//! deterministic — the same seam ADR 0022 established for the embedding
//! worker's `scan_interval`).
//!
//! In particular: **no SQL in this codebase may do `at time zone` or any
//! other timezone conversion.** `server/src/digest.rs` always buckets a
//! timestamp into a Period in Rust, via `period_start_of`, after pulling
//! plain UTC instants out of Postgres. Two independent implementations of
//! "what local day does this instant fall on" — one in SQL, one here —
//! would drift the moment either one is touched without the other, and the
//! failure mode is a Digest silently missing or double-counting an Entry
//! near a boundary. One implementation, used everywhere, is the whole
//! point.

use std::env;
use std::str::FromStr;

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

/// The three granularities a Digest can cover (CONTEXT.md's Period entry).
/// Deliberately not `Copy`-derived-away-from — every function in this
/// module and in `digest.rs` passes it by value, and it's small enough
/// (a three-variant tag) that there's never a reason to borrow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Period {
    Day,
    Week,
    Month,
}

impl Period {
    /// Every Period this worker ever considers, in a fixed order. `digest.rs`
    /// iterates this once per tick; the order doesn't matter for
    /// correctness (each Period's resume state is independent) but keeping
    /// it stable makes a tick's tracing output easier to read across runs.
    pub const ALL: [Period; 3] = [Period::Day, Period::Week, Period::Month];

    /// The string stored in `digests.period` and used as the SQL bind value
    /// for every query keyed on it. Stable, lower-case, singular — matches
    /// the migration's comment.
    pub fn as_str(self) -> &'static str {
        match self {
            Period::Day => "day",
            Period::Week => "week",
            Period::Month => "month",
        }
    }

    /// The inverse of `as_str`. Returns `None` for anything else rather
    /// than panicking — a row this doesn't recognise (a future Period
    /// variant added without a migration for old rows, or a hand-edited
    /// database) should be a value a caller can react to, not a crash.
    pub fn parse(value: &str) -> Option<Period> {
        match value {
            "day" => Some(Period::Day),
            "week" => Some(Period::Week),
            "month" => Some(Period::Month),
            _ => None,
        }
    }
}

/// Reads `MEOLOGUE_TZ` from the environment and resolves it to a `Tz`. See
/// `parse_timezone` for the actual parsing and fallback rule — this is
/// just the environment-reading wrapper around it, kept separate so
/// `parse_timezone` stays a pure function tests can call directly without
/// mutating process environment (Rust 2024 made `std::env::set_var`
/// `unsafe`, precisely because it's process-global and races with any
/// other thread reading the environment — a pure function sidesteps that
/// entirely rather than working around it).
pub fn server_timezone() -> Tz {
    parse_timezone(env::var("MEOLOGUE_TZ").ok().as_deref())
}

/// Resolves an optional `MEOLOGUE_TZ` value to a `Tz`, and is the thing
/// `docs/adr/0027` means by "extends ADR 0023 rather than contradicting
/// it": ADR 0023 says the Server never *guesses* the timezone; a
/// configured value here is not a guess. `None` or an empty string (the
/// same "unset means off" reading `LlmConfig::from_env` gives every other
/// `MEOLOGUE_*` variable) defaults to UTC. A value that doesn't parse as an
/// IANA zone name warns and *also* falls back to UTC — this must never
/// panic or refuse to start, because a background worker misconfigured
/// this way should degrade to "boundaries are UTC" rather than take the
/// whole Server down.
pub fn parse_timezone(value: Option<&str>) -> Tz {
    match value {
        None => Tz::UTC,
        Some("") => Tz::UTC,
        Some(raw) => match Tz::from_str(raw) {
            Ok(tz) => tz,
            Err(_) => {
                tracing::warn!(
                    value = raw,
                    "MEOLOGUE_TZ is not a recognised IANA timezone name; falling back to UTC"
                );
                Tz::UTC
            }
        },
    }
}

/// The local date on which the Period containing `instant` begins.
///
/// Day: the local date itself. Week: ISO weeks, so the Monday on or before
/// that local date. Month: the 1st of that local month. All three read
/// `instant` in `tz`'s local time first (`with_timezone`) — nothing here
/// ever reasons about a UTC calendar date.
pub fn period_start_of(period: Period, tz: Tz, instant: DateTime<Utc>) -> NaiveDate {
    let local_date = instant.with_timezone(&tz).date_naive();
    match period {
        Period::Day => local_date,
        Period::Week => {
            let days_since_monday = i64::from(local_date.weekday().num_days_from_monday());
            local_date - Duration::days(days_since_monday)
        }
        Period::Month => NaiveDate::from_ymd_opt(local_date.year(), local_date.month(), 1)
            .expect("year/month taken from an existing NaiveDate, day 1 is always valid"),
    }
}

/// The local date on which the Period immediately following the one
/// starting at `start` begins. Day: `start + 1`. Week: `start + 7`. Month:
/// the 1st of the next calendar month, wrapping the year — this is the one
/// case that can't be expressed as "add a fixed number of days", since
/// months vary in length.
pub fn next_period_start(period: Period, start: NaiveDate) -> NaiveDate {
    match period {
        Period::Day => start + Duration::days(1),
        Period::Week => start + Duration::days(7),
        Period::Month => {
            let (year, month) = if start.month() == 12 {
                (start.year() + 1, 1)
            } else {
                (start.year(), start.month() + 1)
            };
            NaiveDate::from_ymd_opt(year, month, 1)
                .expect("day 1 of any (year, month) pair is always valid")
        }
    }
}

/// The last local date the Period starting at `start` includes, inclusive
/// — for display (a Digest's date range in its own prompt, see
/// `digest.rs::build_messages`). Always `next_period_start(period, start) -
/// 1 day`: whatever Period type, "the day before the next one starts" is
/// exactly its own last day, so there's no need for a second, parallel
/// case-by-case implementation that could drift from `next_period_start`.
pub fn period_end(period: Period, start: NaiveDate) -> NaiveDate {
    next_period_start(period, start) - Duration::days(1)
}

/// The start date of the Period immediately *before* the one `now` falls
/// in — i.e. the newest Period that has fully completed as of `now`. This
/// is the resume rule's "horizon" (`digest.rs::run`): the newest Period
/// type eligible for a Digest, and — when no Digest of that type exists
/// yet — the *only* one eligible, which is what keeps a cold start from
/// reaching back through the journal's whole History (`docs/adr/0027`).
pub fn most_recently_completed(period: Period, tz: Tz, now: DateTime<Utc>) -> NaiveDate {
    let current_start = period_start_of(period, tz, now);
    match period {
        Period::Day => current_start - Duration::days(1),
        Period::Week => current_start - Duration::days(7),
        Period::Month => {
            let (year, month) = if current_start.month() == 1 {
                (current_start.year() - 1, 12)
            } else {
                (current_start.year(), current_start.month() - 1)
            };
            NaiveDate::from_ymd_opt(year, month, 1)
                .expect("day 1 of any (year, month) pair is always valid")
        }
    }
}

/// The half-open UTC instant range `[start_of_period, start_of_next_period)`
/// a Period starting at `start` covers — what `digest.rs` binds directly
/// into its `created_at >= $1 and created_at < $2` queries. Half-open so a
/// day, week or month never double-counts the instant exactly on its
/// boundary with the next one.
pub fn period_bounds(period: Period, tz: Tz, start: NaiveDate) -> (DateTime<Utc>, DateTime<Utc>) {
    let next_start = next_period_start(period, start);
    (
        local_midnight_to_utc(tz, start),
        local_midnight_to_utc(tz, next_start),
    )
}

/// Resolves local midnight on `date`, in `tz`, to the UTC instant it means
/// — handling both cases `TimeZone::from_local_datetime`'s `LocalResult`
/// can return besides `Single`, explicitly, rather than `.unwrap()`ing and
/// risking a panic that would take the whole worker down over a single
/// DST transition:
///
/// - `Ambiguous` (a "fall back" repeats a local hour, so two UTC instants
///   both read as this local time): the **earliest** of the two is picked.
///   For a period boundary specifically, an earlier start only ever makes
///   the range include one extra hour it might otherwise have missed on a
///   fall-back day — it can never cause a Digest to skip an Entry, and the
///   half-open range on the *other* end of `period_bounds` means that hour
///   is still claimed by exactly one Period, never two.
/// - `None` (a "spring forward" skips a local hour, so this exact
///   wall-clock time never occurs): step forward a minute at a time until a
///   real instant is found. Real IANA DST shifts are at most a few hours,
///   so this terminates almost immediately in practice; picking the
///   earliest local time that *does* exist is the natural reading of "the
///   period starts here" when its literal midnight got skipped.
fn local_midnight_to_utc(tz: Tz, date: NaiveDate) -> DateTime<Utc> {
    let naive = date
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 is always a valid time");
    earliest_utc_for_local(tz, naive)
}

fn earliest_utc_for_local(tz: Tz, naive: NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc),
        LocalResult::Ambiguous(earliest, _latest) => earliest.with_timezone(&Utc),
        LocalResult::None => {
            let mut probe = naive;
            for _ in 0..180 {
                probe += Duration::minutes(1);
                match tz.from_local_datetime(&probe) {
                    LocalResult::Single(dt) => return dt.with_timezone(&Utc),
                    LocalResult::Ambiguous(earliest, _) => return earliest.with_timezone(&Utc),
                    LocalResult::None => continue,
                }
            }
            // Unreachable for any real IANA zone — no DST transition skips
            // more than a few hours. If it somehow happened anyway,
            // treating the naive time as UTC is a harmless fallback rather
            // than a panic: a background worker must never crash the
            // process over calendar maths.
            DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
        DateTime::<Utc>::from_naive_utc_and_offset(
            NaiveDate::from_ymd_opt(year, month, day)
                .unwrap()
                .and_hms_opt(hour, minute, 0)
                .unwrap(),
            Utc,
        )
    }

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    // -------------------------------------------------------------------
    // Period::as_str / parse
    // -------------------------------------------------------------------

    #[test]
    fn every_period_round_trips_through_its_string() {
        for period in Period::ALL {
            assert_eq!(Period::parse(period.as_str()), Some(period));
        }
    }

    #[test]
    fn an_unrecognised_string_fails_to_parse() {
        assert_eq!(Period::parse("fortnight"), None);
    }

    // -------------------------------------------------------------------
    // period_start_of — ISO weeks start on Monday
    // -------------------------------------------------------------------

    #[test]
    fn a_weeks_start_lands_on_monday() {
        // 2026-08-19 is a Wednesday.
        let wednesday = utc(2026, 8, 19, 12, 0);
        let start = period_start_of(Period::Week, Tz::UTC, wednesday);
        assert_eq!(start, date(2026, 8, 17)); // the preceding Monday
        assert_eq!(start.weekday(), chrono::Weekday::Mon);
    }

    #[test]
    fn a_weeks_start_can_fall_in_the_previous_year() {
        // 2025-01-01 is a Wednesday; its ISO week began the previous Monday,
        // in the prior calendar year.
        let new_years_day = utc(2025, 1, 1, 0, 30);
        let start = period_start_of(Period::Week, Tz::UTC, new_years_day);
        assert_eq!(start, date(2024, 12, 30));
        assert_eq!(start.weekday(), chrono::Weekday::Mon);
    }

    // -------------------------------------------------------------------
    // period_start_of / period_end — months, including a leap February
    // -------------------------------------------------------------------

    #[test]
    fn a_months_start_is_the_first_of_the_month() {
        let mid_february = utc(2024, 2, 15, 9, 0);
        assert_eq!(
            period_start_of(Period::Month, Tz::UTC, mid_february),
            date(2024, 2, 1)
        );
    }

    #[test]
    fn a_leap_februarys_end_is_the_29th() {
        assert_eq!(
            period_end(Period::Month, date(2024, 2, 1)),
            date(2024, 2, 29)
        );
    }

    #[test]
    fn a_non_leap_februarys_end_is_the_28th() {
        assert_eq!(
            period_end(Period::Month, date(2025, 2, 1)),
            date(2025, 2, 28)
        );
    }

    #[test]
    fn decembers_next_period_start_wraps_the_year() {
        assert_eq!(
            next_period_start(Period::Month, date(2025, 12, 1)),
            date(2026, 1, 1)
        );
    }

    // -------------------------------------------------------------------
    // most_recently_completed
    // -------------------------------------------------------------------

    #[test]
    fn the_most_recently_completed_day_is_yesterday() {
        // 2026-08-19 12:00 UTC — the day in progress starts 2026-08-19.
        let now = utc(2026, 8, 19, 12, 0);
        assert_eq!(
            most_recently_completed(Period::Day, Tz::UTC, now),
            date(2026, 8, 18)
        );
    }

    #[test]
    fn the_most_recently_completed_week_is_last_monday() {
        let now = utc(2026, 8, 19, 12, 0); // Wednesday, in the week starting 2026-08-17
        assert_eq!(
            most_recently_completed(Period::Week, Tz::UTC, now),
            date(2026, 8, 10)
        );
    }

    #[test]
    fn the_most_recently_completed_month_is_last_month() {
        let now = utc(2026, 8, 19, 12, 0); // in August, the month in progress starts 2026-08-01
        assert_eq!(
            most_recently_completed(Period::Month, Tz::UTC, now),
            date(2026, 7, 1)
        );
    }

    #[test]
    fn the_most_recently_completed_month_wraps_backwards_across_a_year_boundary() {
        let now = utc(2026, 1, 15, 12, 0); // in January, the previous month is last December
        assert_eq!(
            most_recently_completed(Period::Month, Tz::UTC, now),
            date(2025, 12, 1)
        );
    }

    // -------------------------------------------------------------------
    // period_bounds — a non-UTC zone, mirroring reflect.rs's IST test
    // -------------------------------------------------------------------

    #[test]
    fn period_bounds_at_ist_starts_the_previous_utc_evening() {
        let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
        let day = date(2026, 8, 15);

        // IST is UTC+5:30, so local midnight on the 15th is 18:30 UTC on
        // the 14th, and the half-open range ends exactly 24 local hours
        // later.
        let (from_utc, to_utc) = period_bounds(Period::Day, kolkata, day);
        assert_eq!(from_utc.to_rfc3339(), "2026-08-14T18:30:00+00:00");
        assert_eq!(to_utc.to_rfc3339(), "2026-08-15T18:30:00+00:00");
    }

    #[test]
    fn period_bounds_at_utc_starts_exactly_at_local_midnight() {
        let day = date(2026, 8, 15);
        let (from_utc, to_utc) = period_bounds(Period::Day, Tz::UTC, day);
        assert_eq!(from_utc.to_rfc3339(), "2026-08-15T00:00:00+00:00");
        assert_eq!(to_utc.to_rfc3339(), "2026-08-16T00:00:00+00:00");
    }

    // -------------------------------------------------------------------
    // parse_timezone — the pure parsing helper `server_timezone` wraps
    // -------------------------------------------------------------------

    #[test]
    fn no_value_defaults_to_utc() {
        assert_eq!(parse_timezone(None), Tz::UTC);
    }

    #[test]
    fn an_empty_value_defaults_to_utc() {
        assert_eq!(parse_timezone(Some("")), Tz::UTC);
    }

    #[test]
    fn an_unparseable_value_falls_back_to_utc() {
        assert_eq!(parse_timezone(Some("Not/A_Real_Zone")), Tz::UTC);
    }

    #[test]
    fn a_valid_iana_name_parses() {
        assert_eq!(parse_timezone(Some("Asia/Kolkata")), Tz::Asia__Kolkata);
    }

    // -------------------------------------------------------------------
    // the timezone parameter actually changes which local day an instant
    // falls on — the property digest.rs's cold-start and resume logic
    // depends on entirely
    // -------------------------------------------------------------------

    #[test]
    fn a_late_evening_utc_instant_lands_in_the_next_local_day_at_ist() {
        let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
        let late_evening_utc = utc(2026, 8, 15, 18, 45);
        assert_eq!(
            period_start_of(Period::Day, Tz::UTC, late_evening_utc),
            date(2026, 8, 15)
        );
        assert_eq!(
            period_start_of(Period::Day, kolkata, late_evening_utc),
            date(2026, 8, 16)
        );
    }
}
