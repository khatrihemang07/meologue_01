//! Issue #90: retrieval becomes measurable, with a recorded baseline.
//!
//! Reflection (`reflect.rs`) has been judged so far by whether an Answer
//! "felt right." This harness turns that into a number: a fixed set of
//! Questions over the seeded Sandbox corpus, each with hand-marked expected
//! Entry ids, run independently against each retrieval arm that exists
//! today — `semantic` (`retrieve_nearest`, `MIN_SIMILARITY` floor included)
//! and `date_range` (`retrieve_range`) — reporting recall per arm, and
//! cost (wall-clock, call counts) *separately* from the score. See
//! `docs/adr/0023` for why those two functions exist and what the floor
//! does and doesn't guarantee; this harness measures that ADR's claims
//! against a much smaller corpus than the 572-Entry one it was written
//! against (see `docs/adr/0029`'s "Consequences" — retrieval looks better
//! on ~120 Entries than it will on a real History, and that gap is exactly
//! why this baseline needs re-measuring, not re-guessing, whenever the
//! corpus or the retrieval code changes).
//!
//! ## Why this talks to the Sandbox directly, not `#[sqlx::test]`
//!
//! Every other integration test in this crate uses `#[sqlx::test]`, which
//! provisions a fresh, empty throwaway database per test and inserts
//! exactly the rows that test needs. That is the right tool for testing
//! `reflect_handler`'s *behaviour*, but wrong for this ticket: the whole
//! point is to measure retrieval against the seeded corpus's ~120 Entries
//! of realistic, interleaved journal content (`scripts/seed/sandbox-journal.sql`)
//! and the embeddings Ollama actually produced for them — a hand-built
//! throwaway fixture would be measuring nothing real. So this file opens
//! its own connection straight at the Sandbox Postgres and never touches
//! `#[sqlx::test]` at all.
//!
//! `SANDBOX_DATABASE_URL` below is a **literal, hard-wired constant** —
//! not `std::env::var("DATABASE_URL")` with a fallback. A fallback that
//! *could* resolve to `:5432` (the developer's real journal, per
//! `docs/adr/0029`'s Production/Sandbox split) is exactly the kind of
//! convention-not-construction gap that ADR spent itself avoiding
//! elsewhere; a literal `:5442` cannot be redirected by an inherited
//! environment variable from a shell that had been pointed at Production.
//!
//! ## Why this needs `#[ignore]`
//!
//! Every Question in the `semantic` arm makes a real HTTP call to Ollama
//! (`embed_query`) and a real query against a Postgres that must already
//! be seeded — neither is available in a bare `cargo test` environment (CI
//! or otherwise), and this file's assertions are deliberately not the kind
//! that should gate a normal build (see "cost stays separate from score"
//! below). Run explicitly: `cargo test --test eval_retrieval -- --ignored
//! --nocapture` (the `--nocapture` is what makes the report visible; the
//! test itself does not write one to disk on every run — see
//! `eval-baseline.md` for the one-time recorded snapshot).
//!
//! ## Arms are added without changing the harness
//!
//! `RetrievalArm` is the seam: each arm is a small `async_trait` impl that
//! turns a `Question` into a `Vec<Uuid>` (or declines to run at all, for a
//! Question it doesn't apply to — see `DateRangeArm` below). The driving
//! loop in `eval_retrieval_baseline` iterates `ARMS` and never
//! pattern-matches on which arm it's running; a third arm is a new
//! `RetrievalArm` impl pushed onto that list, nothing else.
//!
//! **Word search is deliberately not built here.** Issue #94 gives the
//! Server a full-text search endpoint that doesn't exist yet; issue #100 is
//! where the three-way arm comparison that decides embeddings' fate
//! happens once it does. This file's job is narrower: the harness, the
//! Questions, the expected Entries, and today's number for the two arms
//! that already exist. `WORD_SEARCH_ARM_GOES_HERE` below marks the seam
//! `#94`'s arm plugs into — one more `RetrievalArm` impl, one more line in
//! `ARMS`.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use meologue_server::llm::{LlmClient, OpenAiCompatibleClient};
use meologue_server::reflect::{
    GroundingEntry, MIN_SIMILARITY, RETRIEVAL_LIMIT, retrieve_nearest, retrieve_range,
};
use sqlx::PgPool;
use uuid::Uuid;

/// The Sandbox Postgres (`docs/adr/0029`), hard-wired rather than read from
/// `DATABASE_URL` — see the module doc comment's "Why this talks to the
/// Sandbox directly" for why a fallback is not an acceptable shape here.
/// This is the one and only place this file may name a Postgres instance.
const SANDBOX_DATABASE_URL: &str = "postgres://meologue:meologue@localhost:5442/meologue";

/// Ollama, serving the same `harrier-270m` model the Sandbox Server's
/// `MEOLOGUE_EMBED_*` env points at (`server/.env`) — 640-dim, L2-normalised,
/// so `1 - (a <=> b)` is cosine similarity (`docs/adr/0022`).
const EMBED_BASE_URL: &str = "http://localhost:11434/v1";
const EMBED_MODEL: &str = "harrier-270m";

// ---------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------

/// One hand-marked evaluation case. `expected` is ground truth for
/// *this specific Question*, not "every Entry that ever mentions the
/// thread" — a broad Question ("tell me about the wedding") is marked
/// against the broad set of Entries a human would call correct Grounding
/// for it, and a narrow Question ("when did I first hurt my knee") is
/// marked against just the one or two Entries that actually answer it.
/// Both shapes are represented on purpose: the semantic arm's recall
/// looks very different against a broad thread-summary Question than
/// against a narrow fact-lookup one, and that contrast is itself part of
/// what this baseline should show.
struct Question {
    /// Short, stable name for the report — not shown to any model.
    id: &'static str,
    /// Which of the corpus's seven threads this exercises, or `"absent"`
    /// for a control Question about a topic that was never written down.
    thread: &'static str,
    /// The text a Device would actually send as the Question. Never
    /// contains an absolute date — the corpus is seeded relative to
    /// `now()` (`scripts/seed/sandbox-journal.sql`'s header) and drifts,
    /// so a Question that named a calendar date would go stale the day
    /// after it was written.
    text: &'static str,
    /// Hand-marked expected Entry ids, ground truth for every arm run
    /// against this Question. Empty for the three absent-topic controls.
    expected: &'static [&'static str],
    /// Present only for Questions that are genuinely about a span of time
    /// (a specific day or few days) rather than a topic — these are the
    /// ones the `date_range` arm runs against, in addition to `semantic`.
    /// See `DateWindowSpec` for how the window is resolved without
    /// hard-coding an absolute date.
    date_window: Option<DateWindowSpec>,
}

/// Resolves to a half-open UTC window `[from, to)` at test run time, by
/// reading the *live* `created_at` of `marker_id` from the Sandbox and
/// offsetting from there — never from a literal calendar date. Entry
/// `created_at` values are fixed at seed time (computed once, from
/// whatever `now()` was when `scripts/seed/sandbox-journal.sql` ran) and
/// never change, so a window built relative to one specific Entry's real
/// timestamp stays correct indefinitely, unlike a window built from
/// "N days ago as of right now" — that drifts by exactly however much
/// real time has passed since the corpus was seeded, which is exactly the
/// bug the "no hard-coded absolute dates" instruction exists to prevent.
struct DateWindowSpec {
    marker_id: &'static str,
    /// Whole days added to `marker_id`'s UTC calendar day (may be
    /// negative) before the window starts.
    start_offset_days: i64,
    /// Width of the window in whole days.
    span_days: i64,
}

/// The evaluation set: ~25 Questions across the corpus's seven threads
/// (`scripts/seed/sandbox-journal.sql`'s header comment names them: knee
/// injury/physio, the Aurora migration with Devika, Priya's wedding, the
/// caffeine/sleep experiment, books, the flat move, and mum's health
/// check-up), plus three absent-topic controls and four date-anchored
/// Questions that also exercise the `date_range` arm.
///
/// Every id below was read out of the live Sandbox (`docker exec
/// meologue-postgres-sandbox psql ... select id, created_at, body from
/// entries where deleted_at is null order by created_at`), not guessed
/// from the seed SQL's relative-interval arithmetic — the ticket's
/// instruction to "read the actual seed SQL" is honoured by using the
/// rows it actually produced rather than re-deriving offsets by hand and
/// risking an off-by-one day.
fn questions() -> Vec<Question> {
    vec![
        // --- knee injury / physio arc -----------------------------------
        Question {
            id: "knee-arc",
            thread: "knee",
            text: "How has my knee injury been progressing over time — is it better or worse than when it started?",
            expected: &[
                "8c1a840a-a8f5-45ac-b203-ff47f9b05580", // first twinge
                "b6c771a6-76ad-4989-8669-abc52e9bb6f1", // worse, still there
                "26bd2328-d0a7-4f49-b605-90cc3d757c43", // booked physio
                "406acfab-a806-4c14-8beb-5dd2f1fafe24", // first physio appt, Anya
                "f4b61e4e-f404-40f1-a0fc-84d54e0ea406", // exercises properly
                "ad98dec8-1b90-4119-a074-c5d02ae7eb5f", // exercises, small victory
                "84a6d39f-956a-421e-9e8a-95f595c6a32c", // cleared for stationary bike
                "dbf10b3d-a194-4889-aa06-b8a020243309", // bike, knee fine
                "4f67d85f-03ef-403c-8a8a-523b47cefad9", // jumped the gun, twinge
                "c6bb9739-cc07-4152-8217-9289c77bb4e8", // iced it, sulked
                "23fca809-8963-4835-8240-2fb3e35aa774", // cleared for light jogging
                "4580dc50-a0cc-48d7-8595-fbebdcd1d30c", // first jog since the ban
            ],
            date_window: None,
        },
        Question {
            id: "knee-onset",
            thread: "knee",
            text: "When did I first notice something wrong with my knee?",
            expected: &[
                "8c1a840a-a8f5-45ac-b203-ff47f9b05580",
                "b6c771a6-76ad-4989-8669-abc52e9bb6f1",
            ],
            date_window: None,
        },
        Question {
            id: "knee-physio",
            thread: "knee",
            text: "What has physio with Anya actually involved for my knee?",
            expected: &[
                "406acfab-a806-4c14-8beb-5dd2f1fafe24",
                "f4b61e4e-f404-40f1-a0fc-84d54e0ea406",
                "e131d036-98ea-49c6-b922-9d889224f8a8",
                "84a6d39f-956a-421e-9e8a-95f595c6a32c",
                "41eaaefe-78fd-49df-a82c-e1018d8b32d4",
            ],
            date_window: None,
        },
        Question {
            id: "knee-back-running",
            thread: "knee",
            text: "Now that I'm running again, how does my knee actually feel?",
            expected: &[
                "4580dc50-a0cc-48d7-8595-fbebdcd1d30c",
                "3f034620-054c-4c14-8bdd-88d493f42dd6",
                "2d8bd6a4-d49b-46d6-b3f9-cde84549853c",
            ],
            date_window: None,
        },
        // --- Aurora migration / Devika ----------------------------------
        Question {
            id: "aurora-overview",
            thread: "aurora",
            text: "What's been going on with the Aurora database migration project at work?",
            expected: &[
                "763f3f35-a3a7-471a-88d6-b51bd81f12eb", // kickoff
                "1a15ecd9-a3f9-4e1a-b800-007774dec08f", // status meeting
                "19f0cfcb-9fd6-4642-b25a-19e2cbe73dc1", // dual-write sync
                "5b23b747-ff08-44ea-a684-02addf046239", // deadline slipping
                "c7e35d39-f95e-47ce-9e97-7115c58efef8", // revised timeline
                "d00b305a-6fee-4650-a718-4a9d29f5753f", // failed cutover attempt
                "b6b0720c-33b8-42f3-a63a-47bc857618ce", // postmortem
                "dd38d14b-2b2d-4707-8bf5-dd61085ca75a", // next attempt estimate
                "85e9c41f-8bfc-43d6-b737-9a3286be8e8b", // firmer footing
                "09bcd26b-5911-4e69-8987-0bd55c193231", // aiming for cutover again
                "f76a8480-9a07-4d40-bcec-77629da9182c", // cutover tomorrow
                "e941d902-8684-4856-99bb-79b76561f842", // cutover succeeded
                "c9c6811d-9a0e-4a1a-b9c6-3fd47fea03bf", // celebrated
                "cb455fb9-ef54-4ecc-8735-a4cb4fce7da3", // final launch
            ],
            date_window: None,
        },
        Question {
            id: "aurora-cutover-success",
            thread: "aurora",
            text: "Did the Aurora cutover eventually succeed, after the failed attempt?",
            expected: &[
                "d00b305a-6fee-4650-a718-4a9d29f5753f",
                "b6b0720c-33b8-42f3-a63a-47bc857618ce",
                "f76a8480-9a07-4d40-bcec-77629da9182c",
                "e941d902-8684-4856-99bb-79b76561f842",
                "c9c6811d-9a0e-4a1a-b9c6-3fd47fea03bf",
                "cb455fb9-ef54-4ecc-8735-a4cb4fce7da3",
            ],
            date_window: None,
        },
        Question {
            id: "aurora-devika",
            thread: "aurora",
            text: "Who is Devika and what has she been doing on the Aurora project?",
            expected: &[
                "763f3f35-a3a7-471a-88d6-b51bd81f12eb",
                "1a15ecd9-a3f9-4e1a-b800-007774dec08f",
                "19f0cfcb-9fd6-4642-b25a-19e2cbe73dc1",
                "5b23b747-ff08-44ea-a684-02addf046239",
                "c7e35d39-f95e-47ce-9e97-7115c58efef8",
                "dd38d14b-2b2d-4707-8bf5-dd61085ca75a",
                "09bcd26b-5911-4e69-8987-0bd55c193231",
                "f76a8480-9a07-4d40-bcec-77629da9182c",
            ],
            date_window: None,
        },
        // --- Priya's wedding ---------------------------------------------
        Question {
            id: "wedding-overview",
            thread: "wedding",
            text: "Tell me about Priya's wedding.",
            expected: &[
                "0101e868-1935-4249-8122-78d1b2eb6ac8", // asked to be bridesmaid
                "e40f2f75-0abe-4b5e-994c-f3c03d3db79c", // dress fitting
                "a69809f6-8285-4e62-aac5-704f089b1d4a", // hen do logistics
                "bf8b1a25-396a-4a23-aa34-2827a72e536f", // getting ready for hen do
                "1dae1843-60fd-438e-9d2f-46390c8ae14f", // hen do night
                "dd95b141-9940-48e1-b9ea-bfe17f3b49c3", // booked travel + final fitting
                "57e7bfbe-a0a1-43f6-896b-b98fcecc7d94", // train down
                "632efc23-d4b3-4579-906a-b0d4588b1469", // checked into B&B
                "0d640071-be71-474e-9ffa-88402969c33f", // rehearsal dinner
                "74102f1f-414f-44a9-9128-28512f8ac680", // wedding day
                "22f1319b-4f3b-40b5-988f-de1633bcc56b", // ceremony
                "940bc414-daad-4e48-a96e-0fbfd7efed39", // morning after
                "debffcfb-1a55-4def-bf08-2a3c9aae4fb0", // bridesmaids' brunch
                "6598f7e7-0570-4b33-af7e-1c05cc1179b0", // wedding photos, laundry
            ],
            date_window: None,
        },
        Question {
            id: "wedding-hen-do",
            thread: "wedding",
            text: "What happened at Priya's hen do?",
            expected: &[
                "a69809f6-8285-4e62-aac5-704f089b1d4a",
                "bf8b1a25-396a-4a23-aa34-2827a72e536f",
                "1dae1843-60fd-438e-9d2f-46390c8ae14f",
            ],
            date_window: None,
        },
        Question {
            id: "wedding-day",
            thread: "wedding",
            text: "What was the wedding day itself like?",
            // date-anchored: every live Entry actually written on that UTC
            // calendar day, not just the ones a human would call
            // "about the wedding" — see DateWindowSpec's doc comment.
            expected: &[
                "74102f1f-414f-44a9-9128-28512f8ac680",
                "22f1319b-4f3b-40b5-988f-de1633bcc56b",
                "c8db57b9-0f70-49f3-8c6f-18ad2add8a41",
            ],
            date_window: Some(DateWindowSpec {
                marker_id: "74102f1f-414f-44a9-9128-28512f8ac680",
                start_offset_days: 0,
                span_days: 1,
            }),
        },
        // --- caffeine / sleep experiment ---------------------------------
        Question {
            id: "caffeine-experiment",
            thread: "caffeine",
            text: "How did the no-caffeine-after-2pm experiment affect my sleep?",
            expected: &[
                "6ce208b3-9182-4583-94cc-5379ba95db49", // started the rule
                "82ef5ad4-f1fb-457c-9162-d07987cb31c1", // day one, herbal tea
                "0adc8c75-4c67-4710-8706-7e71634232bb", // coffee didn't fix waking early
                "fc1a12af-8ebd-49df-b5d4-1faf5a1b4421", // one week in, sleeping better
                "99e2b7ed-9385-405a-8777-003eaacba30f", // slipped, had a 4pm coffee
                "fc6b8f47-d08a-4232-8e59-343514501b16", // back on it after a wobble
                "76e608b2-fc56-4876-ab76-84360ebd1547", // two months in, real improvement
            ],
            date_window: None,
        },
        Question {
            id: "caffeine-slip",
            thread: "caffeine",
            text: "Did I ever slip up and break the no-caffeine-after-2pm rule?",
            expected: &[
                "99e2b7ed-9385-405a-8777-003eaacba30f",
                "172287bb-9a33-4260-ba7f-10bdfd30a389",
            ],
            date_window: None,
        },
        // --- books ---------------------------------------------------------
        Question {
            id: "books-reading",
            thread: "books",
            text: "What have I been reading lately?",
            expected: &[
                "25b09eea-db83-4471-96f0-834b41a91750", // started Piranesi
                "f8bde55d-e86c-4836-978c-29bc10ba8ab2", // more Piranesi
                "d4169107-32ca-4f50-97d1-88498f24ab61", // still on Piranesi
                "2a7b6b66-a5b8-48af-9a07-08b18f3d28bb", // finished Piranesi
                "67e24170-fe66-4469-b41b-2f5e748a6bd2", // Lessons in Chemistry, halfway
                "64926104-9169-45fc-973e-e58836ae55e6", // finished Lessons in Chemistry
            ],
            date_window: None,
        },
        Question {
            id: "books-piranesi-finished",
            thread: "books",
            text: "Did I finish Piranesi, and what did I think of it?",
            expected: &["2a7b6b66-a5b8-48af-9a07-08b18f3d28bb"],
            date_window: None,
        },
        // --- flat move -------------------------------------------------
        Question {
            id: "flat-move-reason",
            thread: "flat-move",
            text: "Why did I have to move out of my old flat?",
            expected: &[
                "86e9b064-9816-47b0-8b3b-86b1585f434a",
                "7ae07d4f-3659-4ea5-a0f6-01928dd304ae",
            ],
            date_window: None,
        },
        Question {
            id: "flat-move-search",
            thread: "flat-move",
            text: "How did the flat search go before I found the new place?",
            expected: &[
                "495f97df-7652-4ae3-869e-26f576163d14", // started looking properly
                "dd7073e2-213b-4cdb-b464-29ccedb3dd33", // viewed a flat, weird smell
                "ca8e45bf-4339-4e1f-a362-10bfd4b10cd0", // found one
                "7b8026c9-1c98-4608-bafe-3cdb303f76d8", // one viewing fell through
                "2edefd21-0386-4e93-b847-adf1c1787b84", // signed the lease
            ],
            date_window: None,
        },
        Question {
            id: "flat-move-day",
            thread: "flat-move",
            text: "What was packing and moving day like when the movers actually came?",
            // date-anchored, same reasoning as wedding-day above.
            expected: &[
                "f95066c8-c9b1-4611-9b4f-21525695082c",
                "9382f13d-ecbc-4aca-987f-bb70756a7a78",
                "80bde7a5-e953-43ca-b223-2958e2b8c974",
                "cb455fb9-ef54-4ecc-8735-a4cb4fce7da3",
                "77b12d24-b623-4243-82e3-49d5eb140f3d",
            ],
            date_window: Some(DateWindowSpec {
                marker_id: "9382f13d-ecbc-4aca-987f-bb70756a7a78",
                start_offset_days: 0,
                span_days: 2,
            }),
        },
        // --- mum's health check-up ---------------------------------------
        Question {
            id: "mum-health-overview",
            thread: "mum-health",
            text: "How did mum's health check-up and follow-up scan turn out?",
            expected: &[
                "720f8ea6-c87e-4201-bc87-6a3a08f4a299", // check-up booked
                "29242b8c-06cc-43bd-b0ea-c81fc662f588", // check-up happened
                "7e13baaa-7cb9-4115-87a0-b3216bc09a78", // extra test fine
                "a1429c50-b154-494b-aeca-3ade2e5fd349", // follow-up scan booked
                "befd9fd7-97c7-48e8-abbd-2fc22c18be12", // scan in a couple of days
                "fb18121a-a598-4b78-81ad-8c177c5618be", // scan results all clear
            ],
            date_window: None,
        },
        Question {
            id: "mum-health-results",
            thread: "mum-health",
            text: "Were the results of mum's medical tests okay in the end?",
            expected: &[
                "7e13baaa-7cb9-4115-87a0-b3216bc09a78",
                "fb18121a-a598-4b78-81ad-8c177c5618be",
            ],
            date_window: None,
        },
        Question {
            id: "mum-health-worry",
            thread: "mum-health",
            text: "Was mum's scan something I was worried about beforehand?",
            expected: &[
                "befd9fd7-97c7-48e8-abbd-2fc22c18be12",
                "fb18121a-a598-4b78-81ad-8c177c5618be",
            ],
            date_window: None,
        },
        // --- date-anchored, cross-thread ---------------------------------
        // These two ask about a *date*, not a topic — the correct answer
        // is "everything written in that window," whatever it's about
        // (retrieve_range doesn't and shouldn't judge relevance; that's
        // the whole point of ADR 0023's "no `embedding is not null` guard"
        // on it). The semantic arm is expected to do badly here, on
        // exactly the entries the range window pulls in that aren't
        // about the Question's nominal topic — that gap is the point.
        Question {
            id: "aurora-cutover-days",
            thread: "aurora",
            text: "What did I write across the couple of days the Aurora cutover finally succeeded?",
            expected: &[
                "a738b6ef-739d-48b2-a866-dff1db6380be",
                "f76a8480-9a07-4d40-bcec-77629da9182c",
                "e941d902-8684-4856-99bb-79b76561f842",
                "c9c6811d-9a0e-4a1a-b9c6-3fd47fea03bf",
                "7160c7c7-bbdb-4591-a78a-5a0a41d3d26f",
                "3f034620-054c-4c14-8bdd-88d493f42dd6",
            ],
            date_window: Some(DateWindowSpec {
                marker_id: "e941d902-8684-4856-99bb-79b76561f842",
                start_offset_days: -1,
                span_days: 3,
            }),
        },
        Question {
            id: "knee-physio-week",
            thread: "knee",
            text: "What was going on the week I first started physio for my knee?",
            expected: &[
                "26bd2328-d0a7-4f49-b605-90cc3d757c43",
                "f8bde55d-e86c-4836-978c-29bc10ba8ab2",
                "0adc8c75-4c67-4710-8706-7e71634232bb",
                "719bfc90-af61-47d9-ace8-5fb50ee7c6f0",
                "406acfab-a806-4c14-8beb-5dd2f1fafe24",
                "fc1a12af-8ebd-49df-b5d4-1faf5a1b4421",
            ],
            date_window: Some(DateWindowSpec {
                marker_id: "26bd2328-d0a7-4f49-b605-90cc3d757c43",
                start_offset_days: 0,
                span_days: 3,
            }),
        },
        // --- absent-topic controls ---------------------------------------
        // Nothing in the corpus is about any of these. Reference
        // measurement taken by hand while writing this ticket: "the
        // football match" (absent) reached 0.361 top cosine, and Priya's
        // wedding (present, five real Entries) topped out at 0.363 — this
        // harness's job is to keep reproducing that pathology as a number,
        // not to fix it (fixing it is ticket #92/#100's job, moving the
        // relevance judgment off cosine).
        Question {
            id: "absent-cat",
            thread: "absent",
            text: "Have I written anything about my cat?",
            expected: &[],
            date_window: None,
        },
        Question {
            id: "absent-japan",
            thread: "absent",
            text: "Did I mention a trip to Japan anywhere?",
            expected: &[],
            date_window: None,
        },
        Question {
            id: "absent-football",
            thread: "absent",
            text: "What have I said about the football match?",
            expected: &[],
            date_window: None,
        },
    ]
}

fn parse_ids(ids: &[&str]) -> HashSet<Uuid> {
    ids.iter()
        .map(|s| Uuid::parse_str(s).expect("fixture id must be a valid uuid"))
        .collect()
}

// ---------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------

/// One retrieval strategy, run against one `Question`. Adding a new arm
/// (word search, #94) means one new impl of this trait plus one new entry
/// in `ARMS` — the driving loop in `eval_retrieval_baseline` never changes.
#[async_trait]
trait RetrievalArm {
    /// Name used in the report — also what a reader six months from now
    /// greps for.
    fn name(&self) -> &'static str;

    /// Runs this arm against `question`, or returns `None` if the
    /// Question doesn't carry the input this arm needs (e.g. `date_range`
    /// against a Question with no `date_window`) — `None` means "not
    /// applicable," reported as such, never silently scored as zero.
    async fn run(&self, ctx: &EvalContext<'_>, question: &Question) -> Option<ArmRun>;
}

/// What one arm run against one Question produced, cost and correctness
/// kept as separate fields on purpose — nothing here ever multiplies them
/// together into a single number. See `print_report`.
struct ArmRun {
    retrieved: Vec<Uuid>,
    wall_clock: Duration,
    /// Round trips this run made (an embedding call plus a query, a query
    /// alone, ...) — the "steps" the ticket asks to report alongside
    /// wall-clock. Not a token count: see the module doc comment and
    /// `print_report`'s cost section for why token counts aren't reported
    /// here — `OpenAiCompatibleClient::embed`'s response type
    /// (`server/src/llm.rs`) never parses the endpoint's `usage` field, and
    /// this file only has `pub` access to `retrieve_nearest`/`retrieve_range`
    /// and `LlmClient`, not a reason to widen that struct for an eval.
    steps: u32,
}

struct EvalContext<'a> {
    pool: &'a PgPool,
    // `+ Sync`, not just `LlmClient`: `#[async_trait]` desugars `run` into
    // a `Pin<Box<dyn Future + Send>>`, and holding a bare `&dyn LlmClient`
    // across an `.await` only typechecks as `Send` if the trait object
    // behind the reference is `Sync` too. `OpenAiCompatibleClient` already
    // is (its fields are a `reqwest::Client` and a couple of `String`s),
    // so this only widens the bound this file asks for, not the trait
    // itself in `llm.rs`.
    embed_client: &'a (dyn LlmClient + Sync),
}

/// `retrieve_nearest` (`reflect.rs`) exactly as `/v1/reflect`'s
/// question-search retrieval calls it: embed the Question with
/// `embed_query` (the same `Instruct:`-wrapping, sentence-punctuation-
/// normalising path production code uses — this file never reimplements
/// that template), then the floored nearest-neighbour query, capped at
/// `RETRIEVAL_LIMIT`.
struct SemanticArm;

#[async_trait]
impl RetrievalArm for SemanticArm {
    fn name(&self) -> &'static str {
        "semantic"
    }

    async fn run(&self, ctx: &EvalContext<'_>, question: &Question) -> Option<ArmRun> {
        let start = Instant::now();
        let vector = ctx
            .embed_client
            .embed_query(question.text)
            .await
            .unwrap_or_else(|err| panic!("embed_query failed for {:?}: {err:#}", question.id));
        let rows = retrieve_nearest(ctx.pool, &vector, RETRIEVAL_LIMIT)
            .await
            .unwrap_or_else(|err| panic!("retrieve_nearest failed for {:?}: {err:#}", question.id));
        Some(ArmRun {
            retrieved: ids_of(&rows),
            wall_clock: start.elapsed(),
            steps: 2,
        })
    }
}

/// `retrieve_range` (`reflect.rs`), against the window `question.date_window`
/// resolves to. Declines (`None`) for any Question that doesn't carry one
/// — this arm has nothing to say about a purely topical Question, and
/// reporting a recall of zero for it would misrepresent "not asked" as
/// "asked and failed."
struct DateRangeArm;

#[async_trait]
impl RetrievalArm for DateRangeArm {
    fn name(&self) -> &'static str {
        "date_range"
    }

    async fn run(&self, ctx: &EvalContext<'_>, question: &Question) -> Option<ArmRun> {
        let window = question.date_window.as_ref()?;
        let start = Instant::now();
        let (from, to) = resolve_window(ctx.pool, window).await;
        let rows = retrieve_range(ctx.pool, from, to, RETRIEVAL_LIMIT)
            .await
            .unwrap_or_else(|err| panic!("retrieve_range failed for {:?}: {err:#}", question.id));
        Some(ArmRun {
            retrieved: ids_of(&rows),
            wall_clock: start.elapsed(),
            steps: 2,
        })
    }
}

// WORD_SEARCH_ARM_GOES_HERE — issue #94 adds full-text search to the
// Server; when it lands, its arm is a `struct WordSearchArm;` with a
// `RetrievalArm` impl here (calling whatever `word_search`-shaped function
// #94 introduces) and one more line in `ARMS` below. The three-way
// comparison that decides embeddings' fate against it is #100's job, not
// this file's.

async fn resolve_window(pool: &PgPool, window: &DateWindowSpec) -> (DateTime<Utc>, DateTime<Utc>) {
    let marker_id =
        Uuid::parse_str(window.marker_id).expect("fixture marker id must be a valid uuid");
    let marker_created_at: DateTime<Utc> =
        sqlx::query_scalar("select created_at from entries where id = $1")
            .bind(marker_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|err| panic!("could not load marker Entry {marker_id}: {err:#}"));
    let day: NaiveDate = marker_created_at.date_naive();
    let day_start =
        Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).expect("midnight is always valid"));
    let from = day_start + chrono::Duration::days(window.start_offset_days);
    let to = from + chrono::Duration::days(window.span_days);
    (from, to)
}

fn ids_of(rows: &[GroundingEntry]) -> Vec<Uuid> {
    rows.iter().map(|row| row.id).collect()
}

// ---------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------

/// One row of the recall report: a Question, an arm, and how that arm did
/// against this Question's expected ids.
struct RecallRow {
    question_id: &'static str,
    thread: &'static str,
    arm: &'static str,
    expected_count: usize,
    retrieved_count: usize,
    hits: usize,
    /// `None` only for the "not applicable" case (`RetrievalArm::run`
    /// returned `None`) — never conflated with "applicable, scored zero."
    recall: Option<f64>,
}

/// Retrieval becomes measurable: run every applicable arm against every
/// Question, print recall and cost as two separate reports, and assert
/// nothing about the scores themselves — `docs/adr/0023`'s and this
/// ticket's own framing is explicit that a low score is a finding, not a
/// test failure. What this test *does* assert on is purely structural:
/// that the harness itself ran end to end against the Sandbox (the pool
/// connects, every arm call returns `Ok`) — if Ollama or the Sandbox
/// Postgres is down, that's a setup problem this test should say so about
/// plainly, via `panic!`, rather than reporting a silently-empty recall
/// table that looks like "everything failed to retrieve."
#[tokio::test]
#[ignore = "needs a seeded Sandbox Postgres on :5442 and Ollama on :11434 — see the module doc comment"]
async fn eval_retrieval_baseline() {
    assert!(
        SANDBOX_DATABASE_URL.contains(":5442"),
        "this eval must only ever address the Sandbox instance, never :5432"
    );

    // A generous `acquire_timeout` (sqlx's default is 30s): this run makes
    // one real embedding HTTP call to Ollama per Question before each
    // `semantic` query, and a dev machine busy with something else (a
    // concurrent `cargo build`, another agent's own test run) can push a
    // single round trip past 30s without anything actually being stuck —
    // measured directly: the default timeout fired here under exactly that
    // load, minutes into an otherwise-succeeding run.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_secs(120))
        .connect(SANDBOX_DATABASE_URL)
        .await
        .expect("could not connect to the Sandbox Postgres on :5442 — is it running and seeded?");

    let live_entries: i64 =
        sqlx::query_scalar("select count(*) from entries where deleted_at is null")
            .fetch_one(&pool)
            .await
            .expect("could not count live Entries");
    assert!(
        live_entries > 0,
        "the Sandbox has no live Entries — seed it first (scripts/seed-sandbox.sh)"
    );

    let embed_client = OpenAiCompatibleClient::new(EMBED_BASE_URL, EMBED_MODEL, None);
    let ctx = EvalContext {
        pool: &pool,
        embed_client: &embed_client,
    };

    let arms: Vec<Box<dyn RetrievalArm>> = vec![Box::new(SemanticArm), Box::new(DateRangeArm)];

    let mut recall_rows = Vec::new();
    let mut cost_by_arm: Vec<(&'static str, Duration, u32, usize)> = Vec::new(); // (name, total_wall_clock, total_steps, question_count)

    for question in &questions() {
        let expected = parse_ids(question.expected);
        for arm in &arms {
            let Some(run) = arm.run(&ctx, question).await else {
                continue;
            };
            let retrieved: HashSet<Uuid> = run.retrieved.iter().copied().collect();
            let hits = retrieved.intersection(&expected).count();
            let recall = if expected.is_empty() {
                // Absent-topic control: there is no "fraction found," only
                // "did anything wrongly clear the floor." Report as
                // Some(0.0) when clean (nothing retrieved) and leave the
                // retrieved_count column to show the false-positive count
                // otherwise — recall as a fraction genuinely doesn't apply
                // to an empty expected set, so it stays a count, not a
                // divide-by-zero dressed up as 0.0 either way.
                None
            } else {
                Some(hits as f64 / expected.len() as f64)
            };
            recall_rows.push(RecallRow {
                question_id: question.id,
                thread: question.thread,
                arm: arm.name(),
                expected_count: expected.len(),
                retrieved_count: run.retrieved.len(),
                hits,
                recall,
            });

            let entry = cost_by_arm
                .iter_mut()
                .find(|(name, ..)| *name == arm.name());
            match entry {
                Some((_, total_wall_clock, total_steps, count)) => {
                    *total_wall_clock += run.wall_clock;
                    *total_steps += run.steps;
                    *count += 1;
                }
                None => cost_by_arm.push((arm.name(), run.wall_clock, run.steps, 1)),
            }
        }
    }

    print_report(&recall_rows, &cost_by_arm);
}

fn print_report(rows: &[RecallRow], cost_by_arm: &[(&'static str, Duration, u32, usize)]) {
    println!("\n=== Retrieval eval (issue #90) — recall, by Question and arm ===");
    println!(
        "{:<24} {:<10} {:<12} {:>8} {:>9} {:>5} {:>8}",
        "question", "thread", "arm", "expected", "retrieved", "hits", "recall"
    );
    for row in rows {
        let recall_str = match row.recall {
            Some(r) => format!("{:.2}", r),
            None => "n/a".to_string(),
        };
        println!(
            "{:<24} {:<10} {:<12} {:>8} {:>9} {:>5} {:>8}",
            row.question_id,
            row.thread,
            row.arm,
            row.expected_count,
            row.retrieved_count,
            row.hits,
            recall_str
        );
    }

    println!(
        "\n=== Recall summary, by arm (mean over Questions with a non-empty expected set) ==="
    );
    for arm_name in ["semantic", "date_range"] {
        let scored: Vec<f64> = rows
            .iter()
            .filter(|r| r.arm == arm_name)
            .filter_map(|r| r.recall)
            .collect();
        if scored.is_empty() {
            println!("{arm_name:<12} no scored Questions (arm not applicable to any Question run)");
            continue;
        }
        let mean = scored.iter().sum::<f64>() / scored.len() as f64;
        let zero = scored.iter().filter(|r| **r == 0.0).count();
        println!(
            "{arm_name:<12} mean recall {mean:.3} over {n} Questions ({zero} scored exactly 0)",
            n = scored.len()
        );
    }

    println!("\n=== Absent-topic controls (expected: nothing retrieved) ===");
    for row in rows.iter().filter(|r| r.thread == "absent") {
        println!(
            "{:<24} {:<12} retrieved {} Entries above the {:.2} floor (false positives, since nothing about this topic exists)",
            row.question_id, row.arm, row.retrieved_count, MIN_SIMILARITY
        );
    }

    println!(
        "\n=== Cost, kept separate from the score above (steps and wall-clock, never folded into recall) ==="
    );
    println!(
        "{:<12} {:>10} {:>16} {:>18} {:>18}",
        "arm", "questions", "total steps", "total wall-clock", "mean wall-clock"
    );
    for (name, total_wall_clock, total_steps, count) in cost_by_arm {
        let mean = *total_wall_clock / (*count as u32).max(1);
        println!(
            "{:<12} {:>10} {:>16} {:>18?} {:>18?}",
            name, count, total_steps, total_wall_clock, mean
        );
    }
    println!(
        "\nToken counts are not reported: OpenAiCompatibleClient::embed (server/src/llm.rs) parses only \
         `data[0].embedding` out of the embeddings response and never reads a `usage` field, so no token \
         count is available from this client without widening it beyond what this ticket's file-ownership \
         permits (only `pub` visibility changes to reflect.rs, no llm.rs edits). Step counts (one embed \
         call + one query per semantic run; one query per date_range run) stand in for it above."
    );
}
