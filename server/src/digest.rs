//! Writes `digests` ahead of time, off the request path — copying
//! `embedding.rs`'s worker shape directly (ADR 0022), for a different
//! queue: rather than "which Entries lack an embedding," the state
//! question here is "which completed Periods lack a Digest." See ADR 0027
//! for the full reasoning behind every decision below, and `period.rs` for
//! every timezone and calendar computation this module defers to rather
//! than re-deriving.
//!
//! Unlike the embedding worker there is no per-request hint to react to —
//! nothing asks for a Digest, ever (CONTEXT.md's Digest entry: "nobody
//! asked; the Server simply wrote") — so `run` is a plain periodic loop,
//! with no channel alongside the interval.
//!
//! Issue #70 adds the read side, in this same module rather than a
//! sibling one: `latest_digest_handler` and `digest_at_handler` below share
//! the SQL shape (and the `DigestRecord` row) that `write_digest_for` above
//! writes, so keeping reader and writer together means there is exactly one
//! place that knows what a `digests` row looks like, the same reasoning
//! `sessions.rs` gives for holding both `reflect.rs`'s persistence helpers
//! and its own handlers.
//!
//! Issue #132 / ADR 0039 amends the "nothing asks for a Digest, ever" line
//! above: a Digest can now also be asked for, through
//! `POST /v1/digests/{period}/{date}/regenerate` — a synchronous, one-off
//! request, never a second worker loop. That doesn't undo the sentence
//! this module comment led with — the background worker above still never
//! reacts to a request, still writes only a first, never-since-touched
//! revision — it adds a second, deliberately different way a Digest gets
//! written, alongside it rather than instead of it. `digests` gains a
//! `revision` (`0009_digests_gain_revisions.sql`) so regenerating INSERTs
//! rather than rewrites: ADR 0027's immutability clause is exactly as true
//! after this as before it, and what's superseded is narrower — only "at
//! most one Digest per Period."
//!
//! Issue #95 gives the harness a second reader: `harness::tools::read_digest`
//! calls `select_digest_at` directly rather than going over HTTP to its own
//! Server, so `DigestRecord` and `select_digest_at` are `pub(crate)` — the
//! query and the row shape are unchanged; only what can see them is wider,
//! the same minimal widening `entries_in_range.rs` made of
//! `reflect::local_date_range_to_utc`.
//!
//! Issues #135/#136/#137 rebuild how a Digest's body actually gets written,
//! in that order: #135 makes `generate_digest_body` the one validated path
//! both writers use; #136 lets it split an oversized Period into several
//! chat calls (`chunk_entries`); #137 makes a bad chunk among several
//! survivable — the Period gets a partial Digest instead of none at all,
//! with `grounding_entry_ids` and `source_seq = 0` disclosing exactly what
//! was skipped. See `generate_digest_body`'s own doc comment for the full
//! chain of reasoning; nothing about the module's two writers or its
//! "generate once, regenerate on request" shape (issue #132 / ADR 0039,
//! above) changes because of any of it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use sqlx::PgPool;
use tokio::time::MissedTickBehavior;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::llm::{ChatMessage, LlmClient};
use crate::period::{self, Period};
use crate::reflect::strip_code_fences;
use crate::settings::RuntimeFlags;

/// How often the worker re-scans for Periods that completed since the last
/// pass. 5 minutes, much coarser than the embedding worker's 30 seconds
/// (`embedding::SCAN_INTERVAL`): a Digest only ever becomes writable once a
/// whole day, week or month has elapsed, so there is no latency win to
/// chase by polling faster — this cadence exists purely so the worker
/// notices "a Period just ended" within a few minutes rather than waiting
/// on a restart.
pub const SCAN_INTERVAL: Duration = Duration::from_secs(300);

/// Caps how many Digests one tick writes **per Period type**, not across
/// the three combined — see `run` for why a long daily backlog must not be
/// allowed to starve the weekly and monthly Periods of the same tick. A
/// tick can therefore write up to three times this many Digests in total.
/// It counts Digests actually **written**, not Periods merely considered,
/// so a run of empty Periods never eats into the budget a Period that
/// actually needs an LLM call would use. This paces a long backlog — the
/// resume rule (see `run`) can find many Periods to fill at once, right
/// after seeding an anchor row far in the past (`docs/adr/0027`'s backfill
/// mechanism) or after the worker was down for a while — so it trickles
/// over several ticks rather than firing every call in one burst.
///
/// It is a write budget, not a call budget: a Period whose chat call fails
/// writes nothing and so does not spend it, and will be retried on the next
/// tick until `MAX_ATTEMPTS`. So a failing LLM against a large backlog
/// still issues one call per candidate Period per tick. That is bounded
/// overall by `MAX_ATTEMPTS`, not by this constant. The cold-start guarantee itself never needs this cap
/// — with no prior Digest, each Period type has exactly one candidate
/// (`most_recently_completed`) — but the resumed case has no such limit,
/// which is what this constant is actually for.
pub const MAX_DIGESTS_PER_TICK: usize = 3;

/// Caps retries for one `(Period, period_start)` pair, in this process's
/// lifetime. Process-local, not a column — the same choice ADR 0022 made
/// for the embedding worker's attempt cap, and for the same reason: losing
/// the count on restart just means a genuinely poison Period re-earns its
/// cap over a few more ticks, which isn't worth a schema change and a
/// write on every failure. See `run`'s `attempts` map.
pub const MAX_ATTEMPTS: u8 = 5;

/// The fraction of the resolved chat context window Entries may claim in
/// one Digest chat call (issue #136) — the remaining 40% is left for
/// `digest_system_prompt`'s own text, the "Here is everything the user
/// wrote from..." wrapper `build_messages` adds around the Entries block,
/// and the room the model's own reply needs inside that same window. When
/// a Period's Entries would exceed this fraction, `chunk_entries` below
/// splits them across several chat calls rather than one call silently
/// exceeding the model's own limit.
///
/// Deliberately **not** `harness::compaction::RESERVE_TOKENS` (16,384),
/// even though both exist to leave headroom in a context window. That
/// reserve is sized for a *growing multi-turn transcript* — pi's own
/// reserve, kept empty so the reply that follows a compaction always has
/// somewhere to write (`compaction.rs`'s own doc comment) — the exact
/// opposite shape from a Digest's one call, which is a single system/user
/// pair, made once, never revisited or extended with more turns. Reusing
/// it here would also be actively worse than merely mismatched: against
/// the `harness::compaction::DEFAULT_CONTEXT_WINDOW` (32,000) fallback
/// this worker inherits whenever the configured endpoint's own window
/// can't be learned (`llm::LlmConfig::resolve_context_window`),
/// subtracting a flat 16,384-token reserve would leave only about 15,616
/// tokens — under half the window — for Entries, on a call that never
/// carries the multi-turn overhead that reserve exists to protect in the
/// first place. 0.60 is instead sized for what a Digest's one call
/// actually needs room for beyond the Entries themselves: a few hundred
/// tokens of system prompt, a one-line wrapper sentence, and the Digest's
/// own prose reply — all of which fit comfortably inside the remaining
/// 40% even at the smallest realistic window.
pub const DIGEST_ENTRY_BUDGET_FRACTION: f32 = 0.60;

/// One Entry read out of a Period's window, in the shape `build_messages`
/// needs to render it and `write_digest_for` needs to record its id as
/// Grounding.
///
/// `seq` (issue #132 / ADR 0039) is read alongside `id`/`body`/`created_at`
/// for exactly one reason: once a Digest's chat call succeeds,
/// `write_digest_for` and `run_regenerate` both need the highest `seq`
/// among the Entries just read, to record as `source_seq` — the staleness
/// watermark. Reusing this same struct (rather than a second, narrower one)
/// keeps "what an Entry looks like when a Digest reads it" answered in one
/// place.
#[derive(Debug, Clone, sqlx::FromRow)]
struct DigestEntry {
    id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
    seq: i64,
}

/// The staleness watermark a Digest revision is written with: the highest
/// `entries.seq` among the Entries it was built from, or `0` for a Period
/// that held none.
///
/// One function rather than the expression inlined at each of its two call
/// sites (`write_digest_for`, `run_regenerate`) because *which* number goes
/// in this column is the whole of ADR 0039's staleness rule, and it is easy
/// to get subtly wrong: `entries.seq` is reassigned on every edit and delete
/// (`sync.rs`'s `on conflict do update ... seq = nextval(...)`), so the
/// maximum over exactly the Entries that were read is what makes
/// `select_is_stale`'s later `seq > source_seq` mean "something in this
/// Period moved after this revision was written" and nothing else. A
/// watermark that is too low reports a Period stale that never changed —
/// the failure mode `0009_digests_gain_revisions.sql` had to back out of for
/// pre-existing rows.
fn source_seq_of(entries: &[DigestEntry]) -> i64 {
    entries.iter().map(|entry| entry.seq).max().unwrap_or(0)
}

/// Digest's own version of `reflect::is_empty_final_reply` (issue #135):
/// true when `text`, after stripping a wrapping code fence, is nothing but
/// whitespace. That covers the two shapes issue #135 was actually filed
/// against — a genuinely empty or whitespace-only reply (a 200 OK with
/// `""` for a body, which `body text not null` happily accepted because
/// `""` is not null), and a reply that ignores `digest_system_prompt`'s
/// explicit "no backticks" instruction and fences its prose instead,
/// leaving nothing behind once the fence is stripped. `strip_code_fences`
/// (`reflect.rs`, already `pub(crate)` for exactly this kind of reuse) is
/// called here rather than copied — the same function that already
/// reduces a fence-only reply to an empty string for Reflection's own
/// check does the identical job here, and a second copy of that stripping
/// logic would be a second place that could learn to do it slightly
/// differently.
///
/// Deliberately does **not** also strip a stray `<tool_call>` tag
/// fragment the way `is_empty_final_reply` does. That shape can only
/// survive into a final reply because `harness::prompted::PromptedToolClient`
/// parses a tool-calling protocol out of a raw streamed reply, character
/// by character, and an unmatched `</tool_call>` can slip through as
/// literal text (see `is_empty_final_reply`'s own doc comment for the
/// mechanism). A Digest's one chat call never goes anywhere near
/// `prompted.rs` — `generate_digest_body` below calls `client.chat`
/// directly with a plain two-message system/user pair, never through the
/// tool-calling loop that could ever emit or misparse that tag — so there
/// is no protocol here for a stray tag fragment to leak out of. Checking
/// for a shape that structurally cannot occur on this path would not be
/// defensive; it would just be dead code with a misleading comment
/// attached to it.
fn is_empty_digest_body(text: &str) -> bool {
    strip_code_fences(text).trim().is_empty()
}

/// A Digest body that has passed `is_empty_digest_body`'s check — mirrors
/// `reflect::NonEmptyAnswer`'s newtype shape exactly. `generate_digest_body`
/// below is the only function in the crate that ever constructs one, which
/// is what makes it the only path from a raw chat reply to a body either
/// writer can store (issue #135's whole point: two writers, one validated
/// step, rather than two independent trust decisions that can drift).
///
/// As with `NonEmptyAnswer`, this is a narrower guarantee than a
/// type-level ban on ever writing an empty `body` into `digests` anywhere
/// in the crate — `insert_digest`/`regenerate_insert` still take a plain
/// `&str`, and the column itself is `text not null`, not "text, non-empty."
/// What this type actually guarantees is that the one code path that
/// exists today for turning a live model reply into a stored Digest body
/// cannot do so with a rejected one. The raw reply is kept verbatim, not
/// trimmed — unlike `NonEmptyAnswer`, which trims before storing — because
/// a Period that succeeds must produce byte-identical output to what this
/// worker wrote before issue #135 existed, and trimming a reply that
/// happens to carry incidental leading or trailing whitespace would be a
/// (harmless but real) behaviour change this ticket has no mandate to make.
struct ValidatedDigestBody(String);

impl ValidatedDigestBody {
    fn new(raw: &str) -> Option<Self> {
        if is_empty_digest_body(raw) {
            None
        } else {
            Some(Self(raw.to_string()))
        }
    }

    fn into_inner(self) -> String {
        self.0
    }
}

/// A crude chars/4 token estimate for one rendered string — this module's
/// own copy of `harness::compaction`'s identical ratio, not a reuse of it:
/// `compaction::CHARS_PER_TOKEN` is a private constant of that module, and
/// the public `compaction::estimate_tokens` takes
/// `&[harness::types::Message]`, the tool-calling harness's own wire
/// shape, not the plain rendered `String` `chunk_entries` below needs to
/// size. Duplicating a five-line ratio here is simpler and more honest
/// than widening either of those to serve a second, unrelated caller —
/// especially since that ratio is already documented as "crude but
/// conservative" (`compaction::CHARS_PER_TOKEN`'s own doc comment) rather
/// than a value either module is precision-tuned around, so a second copy
/// of it can't drift into meaning something subtly different.
fn estimate_tokens(text: &str) -> usize {
    text.len() / 4
}

/// How many tokens Entries may claim in one Digest chat call, for a
/// resolved context window of `context_window` —
/// `DIGEST_ENTRY_BUDGET_FRACTION` applied directly, floored by the
/// integer cast the same way every other token-budget arithmetic in this
/// codebase floors rather than rounds (`compaction::should_compact`'s own
/// `saturating_sub`): a slightly conservative budget only ever risks an
/// extra, unnecessary chunk, never a call that overruns the window it was
/// sized against.
fn entry_budget_tokens(context_window: u32) -> usize {
    (context_window as f32 * DIGEST_ENTRY_BUDGET_FRACTION) as usize
}

/// Splits `entries` into one or more contiguous slices, each rendering
/// (via `render_entry`) to no more than `budget_tokens`, without ever
/// splitting an Entry across two slices — issue #136's packing rule.
/// Greedy, in the order `entries` already arrives (`select_entries`'s own
/// `order by created_at asc`, preserved end to end): each Entry is added
/// to the current slice unless doing so would push that slice over
/// budget, in which case the current slice ends and a new one starts with
/// that Entry. One code path serves day, week and month alike — nothing
/// here reads `Period` at all, only the Entries and the budget.
///
/// **An Entry that alone exceeds `budget_tokens` still gets a slice of its
/// own**, and the loop still terminates: the over-budget check only ever
/// fires when the current slice already holds at least one Entry (`i >
/// chunk_start`), so a lone oversized Entry is simply accepted into an
/// empty slice — there is no smaller unit to split it into, and dropping
/// it would break the completeness this worker has always guaranteed (a
/// Digest's `grounding_entry_ids` covers every Entry `select_entries`
/// read, never a subset silently thinned to fit). The very next Entry then
/// starts a fresh slice rather than being appended to the already-over
/// slice, so the overrun never compounds across Entries the way it would
/// if the running total were left uncapped after accepting the oversized
/// one.
fn chunk_entries(entries: &[DigestEntry], tz: Tz, budget_tokens: usize) -> Vec<&[DigestEntry]> {
    let mut chunks = Vec::new();
    let mut chunk_start = 0usize;
    let mut chunk_tokens = 0usize;

    for (i, entry) in entries.iter().enumerate() {
        let entry_tokens = estimate_tokens(&render_entry(entry, tz));
        if i > chunk_start && chunk_tokens + entry_tokens > budget_tokens {
            chunks.push(&entries[chunk_start..i]);
            chunk_start = i;
            chunk_tokens = 0;
        }
        chunk_tokens += entry_tokens;
    }
    if chunk_start < entries.len() {
        chunks.push(&entries[chunk_start..]);
    }
    chunks
}

/// Turns one Period's Entries into a validated Digest body — the single
/// step issue #135 introduces so `write_digest_for` (the background
/// worker) and `run_regenerate` (`POST .../regenerate`, issue #132) share
/// one path from "a Period's Entries" to "a body worth storing," instead
/// of each building its own messages, making its own chat call, and
/// trusting whatever came back. Before this function existed, a 200 OK
/// carrying an empty string reached `insert_digest`/`regenerate_insert`
/// exactly as unquestioned as a genuinely useful reply. On the regenerate
/// route that was worse than merely wasteful: reads always take the
/// newest revision unconditionally (ADR 0039), so a blank revision didn't
/// just fail to improve on the last Digest — it shadowed a perfectly good
/// one that was still sitting one revision back.
///
/// Issue #136: this is also the one place a Period's Entries get split
/// across several chat calls, when they don't all fit in one. `entries` is
/// packed by `chunk_entries` into one or more chunks against
/// `entry_budget_tokens(context_window)`, and each chunk gets its own
/// ordinary Digest call — same `digest_system_prompt`, no second prompt
/// variant, built by the same `build_messages` a single-chunk Period
/// always used. The overwhelmingly common case is exactly one chunk
/// (`chunk_entries` never splits unless it must), and that case is
/// deliberately indistinguishable from what this function did before
/// chunking existed: one call, `period_range_label`'s Period-wide range,
/// byte-identical output.
///
/// When there is more than one chunk, each call's user message names
/// *that chunk's own* first-to-last local date span (`chunk_range_label`),
/// never the whole Period's — this is issue #101 again, one level up: that
/// ticket's failure was an Entry rendered under the wrong day inside a
/// call that could see it; this one would be a call's own date label
/// claiming Entries the call was never given at all. "Here is everything
/// the user wrote from X to Y" must stay true of what that one call can
/// actually see.
///
/// The chunk bodies are concatenated with `"\n\n"` once every surviving
/// chunk has run — there is no merge or summarise pass afterwards. Handing
/// a second chat call the concatenation of several already-written
/// summaries, and asking it to summarise *that*, would be exactly the
/// summary-of-summaries ADR 0027 rejects; concatenation has no second
/// lossy pass, so nothing here needs one. For the same reason this
/// function never reaches for `harness::compaction::transform_context`:
/// that machinery exists to condense a *growing multi-turn transcript* by
/// replacing its oldest messages with a model-written summary
/// (`compaction.rs`'s own doc comment) — handed a single user message
/// holding every Entry, it would summarise that one message and then feed
/// the summary back through this function's own chat call to be
/// summarised a second time, the identical shape ADR 0027 ruled out, just
/// reached via different machinery than a manual merge pass would be.
///
/// **Failure semantics (issue #137, superseding #136's original, stricter
/// rule): a bad chunk is skipped, not fatal.** The loop below never lets a
/// single chunk's failure — a transport error from `client.chat`, or a
/// reply `ValidatedDigestBody::new` rejects — end the Period. It catches
/// that one chunk's `Err`, logs it, and moves on; every other chunk still
/// gets its own attempt regardless of where in the sequence the bad one
/// fell. What issue #136 shipped (any chunk failing fails the whole
/// Period, via `?`, without attempting the rest) is exactly the softer
/// case this ticket exists to replace — softening it needed no
/// restructuring, only catching the error here instead of propagating it.
/// Only when *every* chunk in a Period failed does this function return
/// `Err`, once every chunk has had its turn (see the empty-`bodies` check
/// below) — issue #135's original guarantee is unchanged for that case:
/// nothing usable means nothing written, an attempt consumed by the
/// worker and retried within `MAX_ATTEMPTS`, or a 500 with no revision
/// minted on the regenerate route. A lone chunk failing *is* every chunk
/// failing when `chunks.len() == 1` — the single-chunk path this function
/// served before chunking existed is unaffected by any of this.
///
/// Builds each chunk's chat messages, makes its one chat call, and rejects
/// the reply unless `ValidatedDigestBody::new` accepts it — see
/// `is_empty_digest_body`'s doc comment for exactly which shapes that
/// rejects, and why the `<tool_call>` shape `reflect::is_empty_final_reply`
/// also checks for cannot occur on this path at all.
///
/// **Grounding and the staleness watermark now both disclose partiality
/// (issue #137)**, rather than always covering all of `entries`:
///
/// `grounding_entry_ids` holds the ids of only the Entries whose *own*
/// chunk survived — when every chunk succeeds (still the overwhelmingly
/// common outcome, exactly as before this ticket), that is all of
/// `entries`; when a chunk was skipped, its Entries are simply absent.
/// This costs no new mechanism: `grounding_entry_ids` has meant "the
/// Entries this Digest was actually written from" since issue #70, long
/// before chunking or partial failure existed, so a partial body just
/// makes that array smaller — it does its existing job, honestly, on a
/// body that itself now covers less than the whole Period.
///
/// `source_seq` is the second half of that honesty, and it is deliberately
/// **not** `source_seq_of` applied to the surviving Entries — it is the
/// literal constant `0` whenever *any* chunk was skipped, full stop, even
/// though the surviving Entries' own true maximum `seq` is right there and
/// could be computed instead. `entries.seq` starts at `1`
/// (`0001_create_entries.sql`), so recording `0` makes
/// `select_is_stale`'s `seq > source_seq` comparison true for *every*
/// Entry in the Period — including the ones that did make it into the
/// stored body — the instant this revision is written. That is the point,
/// not a side effect: the revision is **born flagged stale**, which is
/// what gets a reader to press Regenerate (the marker `digest-reader-
/// page.tsx`'s `formatStaleCopy` already renders, per ADR 0039) — the only
/// way this Period ever improves, since the worker itself never revisits
/// a Digest once one exists (`fill_period`'s `max(period_start)` anchor
/// walks past any Period with a row at all, regardless of revision — see
/// `write_digest_for`, unchanged by this ticket).
///
/// **This `0` is the deliberate inverse of the case
/// `0009_digests_gain_revisions.sql` backed away from**, not a
/// contradiction of it. That migration refused to default *every
/// pre-existing row's* `source_seq` to `0`, specifically because doing so
/// would have made every Digest already on disk report stale
/// simultaneously, the moment the migration ran, before a single Entry
/// had actually changed — in that migration's own words, "a marker that
/// fires for every Period at once tells a reader nothing." The two cases
/// share only the literal value, `0`; they differ in exactly the respect
/// that decides whether the value means anything. Migration 0009's `0`
/// would have applied uniformly, across the whole table, to rows that
/// were in fact perfectly complete — a false alarm on every single one,
/// with no way for a reader to tell a genuinely stale Digest from the
/// bulk-flagged noise. This function's `0` applies only to a Digest that
/// is, right now, actually incomplete — some chunk of its own Period was
/// dropped — so every time it fires, the Period it fires for really did
/// lose material. A **complete** Digest (still the common case) keeps
/// `source_seq_of(entries)` — today's true watermark, the max `seq` over
/// every Entry the Period holds — exactly as it always has, and reports
/// `stale = false` unless and until a real edit moves an Entry's `seq`
/// past it.
/// What `generate_digest_body` produces: a Digest body worth storing, and the
/// two facts a caller has to record alongside it that only body-generation
/// itself can answer.
///
/// A named type rather than the `(String, Vec<Uuid>, i64)` tuple this used to
/// be, because all three travel together to both writers and are destructured
/// identically at each — and because two of the three are easy to confuse for
/// something they are not. `grounding_entry_ids` is not "the Period's Entries"
/// (issue #137: a skipped chunk's Entries are absent from it), and `source_seq`
/// is not always `source_seq_of(entries)` (it is a literal `0` when any chunk
/// was skipped, which is what makes a partial Digest report stale on its very
/// next read). A bare `i64` in third position invites a caller to reach for
/// the watermark it already has; a field named for what it means does not.
struct GeneratedDigest {
    /// The prose to store — one chunk's reply, or several joined by a blank
    /// line. Never empty: `generate_digest_body` returns `Err` rather than
    /// construct this with nothing in it.
    body: String,
    /// The Entries this `body` was actually written from, which is what
    /// `grounding_entry_ids` has always meant. Narrower than the Period's own
    /// Entries exactly when a chunk was skipped.
    grounding_entry_ids: Vec<Uuid>,
    /// The staleness watermark to record (ADR 0039). `0` for a partial
    /// Digest, so every Entry in the Period trips `select_is_stale`'s
    /// `seq > source_seq` and the reader is told to regenerate.
    source_seq: i64,
}

async fn generate_digest_body(
    client: &(dyn LlmClient + Send + Sync),
    period: Period,
    start: NaiveDate,
    entries: &[DigestEntry],
    tasks: &DigestTasks,
    tz: Tz,
    context_window: u32,
) -> anyhow::Result<GeneratedDigest> {
    let budget_tokens = entry_budget_tokens(context_window);
    let chunks = chunk_entries(entries, tz, budget_tokens);

    let mut bodies = Vec::with_capacity(chunks.len());
    let mut entry_ids: Vec<Uuid> = Vec::with_capacity(entries.len());
    let mut any_chunk_skipped = false;
    for (i, chunk) in chunks.iter().enumerate() {
        // The single-chunk case renders the Period's own range, unchanged
        // from before chunking existed; only a genuine split names a
        // chunk's own narrower span. See this function's own doc comment
        // for why that distinction matters (issue #101).
        let range = if chunks.len() == 1 {
            period_range_label(period, start)
        } else {
            chunk_range_label(chunk, tz)
        };
        // Issue #175: Task facts ride only the *last* chunk's own call,
        // never every chunk's — the overwhelmingly common case is exactly
        // one chunk (`chunks.len() == 1`, so "last" and "only" are the
        // same call), and the rare multi-chunk case would otherwise repeat
        // "you completed X" once per chunk in the final concatenated body
        // (`bodies.join("\n\n")` below), which is exactly the scoreboard
        // this ticket's own "reads as prose" framing argues against. The
        // accepted cost: if the last chunk is the one issue #137 skips
        // (a transport error or a rejected reply), this Period's Digest
        // loses Task coverage along with that chunk's own Entries — no
        // worse than losing any other chunk's material, and no separate
        // mechanism exists (or is worth building) to retry Task facts on
        // their own.
        let tasks_block = if i == chunks.len() - 1 {
            render_tasks_block(tasks)
        } else {
            None
        };
        let messages = build_messages(&range, chunk, tasks_block.as_deref(), tz);

        // Issue #137: a chunk's own failure — transport error or a
        // rejected reply — is caught here, not propagated with `?`, so one
        // bad chunk never takes its neighbours down with it. See this
        // function's own doc comment for the full reasoning.
        let outcome: anyhow::Result<String> = match client.chat(&messages).await {
            Ok(reply) => ValidatedDigestBody::new(&reply.content)
                .map(ValidatedDigestBody::into_inner)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "digest reply was empty, whitespace-only, or only a code fence"
                    )
                }),
            Err(err) => Err(err),
        };

        match outcome {
            Ok(body) => {
                bodies.push(body);
                entry_ids.extend(chunk.iter().map(|entry| entry.id));
            }
            Err(err) => {
                any_chunk_skipped = true;
                tracing::warn!(
                    error = ?err,
                    period = period.as_str(),
                    %start,
                    "digest chunk skipped: its chat call failed or its reply was rejected (issue #137)"
                );
            }
        }
    }

    // Every chunk failed: issue #135's original guarantee holds exactly as
    // it did before this ticket — nothing usable means nothing written.
    // For a single-chunk Period (still the common case) this is the only
    // way `bodies` can end up empty, so this is a strict superset of that
    // function's pre-#137 behaviour, not a new failure mode.
    if bodies.is_empty() {
        anyhow::bail!(
            "every digest chunk failed ({} of {} chunk(s) skipped) — nothing to store",
            chunks.len(),
            chunks.len()
        );
    }

    // `source_seq_of(entries)` — the max `seq` over the *whole* Period, not
    // just the surviving Entries — is exactly right for the complete case,
    // and deliberately not consulted at all for the partial one: see this
    // function's own doc comment for why `0` is written outright rather
    // than the (also honest, but not the chosen signal) max over
    // `entry_ids` alone.
    let source_seq = if any_chunk_skipped {
        0
    } else {
        source_seq_of(entries)
    };
    Ok(GeneratedDigest {
        body: bodies.join("\n\n"),
        grounding_entry_ids: entry_ids,
        source_seq,
    })
}

/// Digest's server-side dependencies, held in `AppState` only when chat is
/// configured (`llm::LlmConfig::digest_worker_config`) — mirrors
/// `reflect::ReflectState` exactly, including why: `lib.rs`'s
/// `router_with_digests` derives `digests_enabled` from this being `Some`
/// rather than carrying a second, independent bool that could drift from
/// it (the same anti-drift reasoning `AppState::digests_enabled`'s own doc
/// comment already gives for `health::health_handler`).
///
/// `chat_client` is what `regenerate_digest_handler` (issue #132) spends
/// its one synchronous chat call on — the same client `main.rs` hands
/// `digest::run`, just also reachable from a request handler now that a
/// Digest can be asked for. `tz` is `period::server_timezone()`, read once
/// at startup and threaded through here rather than re-read per request,
/// for the same reason `run`'s own `tz` parameter is: every Period this
/// process ever computes — whether from the worker's tick or a reader's
/// button press — has to agree on the same calendar boundaries.
///
/// `context_window` (issue #136) is the same value `run`'s own parameter
/// of the same name is — `llm::LlmConfig::resolve_context_window`,
/// resolved once at startup and reused here rather than a second
/// resolution living only on this struct, so the worker's tick and a
/// reader's Regenerate press always chunk an oversized Period at the same
/// boundary. Held here rather than derived fresh per request for the same
/// "resolved once, at startup" reasoning `reflect::ReflectState::context_window`
/// already gives.
#[derive(Clone)]
pub struct DigestState {
    pub chat_client: Arc<dyn LlmClient + Send + Sync>,
    pub tz: Tz,
    pub context_window: u32,
}

/// Runs forever. `tz`, `scan_interval` and (issue #136) `context_window`
/// are parameters rather than constants or a fresh resolution read inside
/// — the same testability seam ADR 0022 established for the embedding
/// worker's `scan_interval`, load-bearing here too: `server/tests/digest.rs`
/// drives this on a ~20ms interval instead of waiting on real wall-clock
/// Periods to complete, passes whichever `Tz` a given test wants to prove
/// buckets Entries differently, and — new with #136 — can pass a
/// deliberately small `context_window` to prove the chunking split fires
/// at all, something no realistic corpus can currently reach (see
/// `DIGEST_ENTRY_BUDGET_FRACTION`'s doc comment for the actual numbers).
///
/// There is no channel: unlike embedding, nothing has a fresh hint about
/// which Period just became eligible, so every tick simply re-derives "what
/// still needs doing" from `digests` and `entries` — the state rule ADR
/// 0027 chose over a time rule (a cron firing at each Period's own
/// boundary), because a state rule catches up on the next tick after any
/// downtime instead of losing the Period the cron would have fired for.
/// Issue #201: `flags` gates the whole `for period in Period::ALL` sweep
/// below — the worker still ticks every `scan_interval` while its flag is
/// off (there is no reason to stop the timer itself), it simply skips
/// asking `digests`/`entries` anything on a tick where the flag says not
/// to. Checked once per tick, not once per Period type, since a
/// mid-sweep flip is rare enough that letting an in-flight tick finish
/// (or not start at all) either way costs nothing worth branching inside
/// the loop for.
pub async fn run(
    pool: PgPool,
    client: Arc<dyn LlmClient + Send + Sync>,
    tz: Tz,
    scan_interval: Duration,
    context_window: u32,
    flags: RuntimeFlags,
) {
    let mut attempts: HashMap<(Period, NaiveDate), u8> = HashMap::new();
    let mut interval = tokio::time::interval(scan_interval);
    // The first tick fires immediately, matching `embedding::run` — a
    // freshly started worker doesn't wait a full `scan_interval` before its
    // first pass.
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        if !flags.digest_enabled() {
            continue;
        }

        // `MAX_DIGESTS_PER_TICK` applies separately to each Period type,
        // not as one budget shared across all three — a backlog on, say,
        // the daily Period (after seeding an old anchor, see ADR 0027)
        // must not starve the weekly or monthly Period of the same tick's
        // progress. The cold-start guarantee (at most one Digest per
        // Period type with no prior anchor) holds either way, since each
        // Period type only ever has a single candidate in that case.
        for period in Period::ALL {
            fill_period(
                &pool,
                client.as_ref(),
                tz,
                period,
                MAX_DIGESTS_PER_TICK,
                &mut attempts,
                context_window,
            )
            .await;
        }
    }
}

/// Fills every writable Digest for one Period type, oldest first, up to
/// `budget` writes — the resume rule, in full:
///
/// 1. `anchor` = the most recent Digest of this Period type, if any.
/// 2. `horizon` = the newest Period of this type that has fully completed
///    as of now (`period::most_recently_completed`).
/// 3. The scan window's first eligible Period start is `anchor`'s next
///    Period if an anchor exists, or **`horizon` itself** if it doesn't.
///    That `None` clause is the whole point of the ticket (ADR 0027): with
///    no anchor, only the single most-recently-completed Period is ever
///    eligible, so a fresh install never reaches backwards through the
///    journal's full History looking for every day, week and month it has
///    ever held.
/// 4. If the first eligible start is already past the horizon, there is
///    nothing to do.
/// 5. Otherwise, find which Periods in that window actually hold Entries —
///    by pulling their raw UTC timestamps and bucketing them in Rust
///    (`period::period_start_of`), never in SQL — and write a Digest for
///    each such start, oldest first, until `budget` is spent.
async fn fill_period(
    pool: &PgPool,
    client: &(dyn LlmClient + Send + Sync),
    tz: Tz,
    period: Period,
    budget: usize,
    attempts: &mut HashMap<(Period, NaiveDate), u8>,
    context_window: u32,
) -> usize {
    if budget == 0 {
        return 0;
    }

    let horizon = period::most_recently_completed(period, tz, Utc::now());

    let anchor = match latest_digest_start(pool, period).await {
        Ok(anchor) => anchor,
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), "failed to load the latest digest anchor");
            return 0;
        }
    };

    let first = match anchor {
        Some(a) => period::next_period_start(period, a),
        None => horizon,
    };

    if first > horizon {
        // The anchor already covers everything up to the horizon — nothing
        // new has completed since the last Digest of this Period type was
        // written. (In the no-anchor case `first == horizon` always, so
        // this branch is only ever reached when an anchor exists.)
        return 0;
    }

    // The scan window spans from `first`'s own start to the *end* of
    // `horizon` — i.e. every instant any Period from `first` through
    // `horizon` (inclusive) could contain.
    let (window_start, _) = period::period_bounds(period, tz, first);
    let (_, window_end) = period::period_bounds(period, tz, horizon);

    let timestamps = match select_entry_timestamps(pool, window_start, window_end).await {
        Ok(timestamps) => timestamps,
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), "failed to load entry timestamps for the digest scan window");
            return 0;
        }
    };

    // Bucket in Rust, never in SQL — see this module's and `period.rs`'s
    // doc comments on why exactly one implementation of this maths exists.
    let mut starts: Vec<NaiveDate> = timestamps
        .into_iter()
        .map(|created_at| period::period_start_of(period, tz, created_at))
        .collect();
    starts.sort();
    starts.dedup();

    let mut written = 0usize;
    for start in starts {
        if written >= budget {
            break;
        }
        if write_digest_for(pool, client, tz, period, start, attempts, context_window).await {
            written += 1;
        }
    }
    written
}

/// Generates and inserts one Digest, or returns `false` without writing
/// anything — because it's already at `MAX_ATTEMPTS`, the Period turned out
/// to hold no Entries after all (defensive; `fill_period` only ever calls
/// this for a `start` its own scan found Entries at), the chat call
/// failed, the reply it got back was rejected by `generate_digest_body`
/// (issue #135 — empty, whitespace-only, or fence-only), issue #136's
/// chunking split the Period into several calls and *every one* of them
/// failed (issue #137 softened this: a chunk failing on its own is now
/// skipped rather than fatal — see `generate_digest_body`'s own doc
/// comment — so this function only ever sees `Err` here when nothing at
/// all survived), or the insert failed. Counts and clears `attempts`
/// itself so `fill_period` never has to know which failure mode occurred.
///
/// A row this function *does* write can still be a partial one — some
/// chunk of the Period was skipped, `grounding_entry_ids` covers only the
/// Entries that survived, and `source_seq` is `0` (issue #137,
/// `generate_digest_body`'s own doc comment has the full reasoning). That
/// row is written and counted as success here — `insert_digest` below
/// cannot tell a partial body from a complete one, and does not need to:
/// the `0` watermark already tells the reader the next time this Period is
/// read, and no retry of this Period will ever happen anyway, complete or
/// not (ADR 0039: the worker generates, it never regenerates).
async fn write_digest_for(
    pool: &PgPool,
    client: &(dyn LlmClient + Send + Sync),
    tz: Tz,
    period: Period,
    start: NaiveDate,
    attempts: &mut HashMap<(Period, NaiveDate), u8>,
    context_window: u32,
) -> bool {
    let key = (period, start);
    if attempts.get(&key).copied().unwrap_or(0) >= MAX_ATTEMPTS {
        return false;
    }

    let (from_utc, to_utc) = period::period_bounds(period, tz, start);
    let entries = match select_entries(pool, from_utc, to_utc).await {
        Ok(entries) => entries,
        Err(err) => {
            let count = attempts.entry(key).or_insert(0);
            *count += 1;
            tracing::error!(error = ?err, period = period.as_str(), %start, attempt = *count, "failed to load entries for a digest");
            return false;
        }
    };

    // Defensive: `fill_period`'s own scan only calls this for a `start` it
    // already found at least one Entry's timestamp bucketed into. This
    // should never fire, but guards against writing an empty, pointless
    // Digest if it somehow does.
    if entries.is_empty() {
        return false;
    }

    // Issue #175: Task facts alongside the Entries. A failure here must
    // not cost the Period its Digest — Entries remain this worker's
    // primary subject (ADR 0027), and unlike `select_entries` above, whose
    // failure genuinely means "nothing to write about," a failed Task
    // query only means "this Digest won't mention Tasks this time," which
    // degrades cleanly to `DigestTasks::default()` (see that type's own
    // doc comment) rather than consuming an attempt or losing a
    // perfectly-writable Digest over an unrelated table.
    let tasks = match select_digest_tasks(pool, period, start, from_utc, to_utc).await {
        Ok(tasks) => tasks,
        Err(err) => {
            tracing::warn!(error = ?err, period = period.as_str(), %start, "failed to load Task facts for a digest; continuing without them");
            DigestTasks::default()
        }
    };

    // `generate_digest_body` (issue #135, chunked per issue #136, made
    // partiality-tolerant per issue #137) is the only path from these
    // Entries to a body: it splits them into one or more chunks against
    // `context_window`'s budget, makes one chat call per chunk, and skips
    // (rather than fails on) a chunk whose call errors or whose reply is
    // empty, whitespace-only, or fence-only. This `Err` arm is now reached
    // only when *every* chunk in the Period failed — a transport failure
    // and a rejected reply are still folded together here, exactly as
    // before, but a single bad chunk among several good ones no longer
    // lands here at all; it lands in the `Ok` arm below as a partial
    // Digest instead. See `generate_digest_body`'s own doc comment for the
    // full reasoning. Total failure is treated exactly as a failed chat
    // call already was before issue #135: attempt consumed, nothing
    // written, retried on a later tick within `MAX_ATTEMPTS`.
    let generated = match generate_digest_body(
        client,
        period,
        start,
        &entries,
        &tasks,
        tz,
        context_window,
    )
    .await
    {
        Ok(result) => result,
        Err(err) => {
            let count = attempts.entry(key).or_insert(0);
            *count += 1;
            tracing::warn!(error = ?err, period = period.as_str(), %start, attempt = *count, "digest body generation failed");
            return false;
        }
    };

    match insert_digest(
        pool,
        period,
        start,
        &generated.body,
        &generated.grounding_entry_ids,
        generated.source_seq,
    )
    .await
    {
        Ok(inserted) => {
            // Succeeded (or lost a race to another writer of the exact
            // same Period — the `on conflict do nothing` in `insert_digest`
            // makes that indistinguishable from success, which is correct:
            // either way this Period now has a Digest). Either way, drop
            // any prior failure count so the map doesn't hold a stale entry
            // for a key that will never be retried again.
            attempts.remove(&key);
            inserted
        }
        Err(err) => {
            let count = attempts.entry(key).or_insert(0);
            *count += 1;
            tracing::error!(error = ?err, period = period.as_str(), %start, attempt = *count, "failed to store a digest");
            false
        }
    }
}

async fn latest_digest_start(pool: &PgPool, period: Period) -> sqlx::Result<Option<NaiveDate>> {
    sqlx::query_scalar::<_, Option<NaiveDate>>(
        "select max(period_start) from digests where period = $1",
    )
    .bind(period.as_str())
    .fetch_one(pool)
    .await
}

/// Pulls just the raw UTC timestamps in `[from_utc, to_utc)` — deliberately
/// not `select distinct date(...)` or anything else that would bucket in
/// SQL; `fill_period` buckets every one of these with `period::period_start_of`
/// after they're back in Rust.
async fn select_entry_timestamps(
    pool: &PgPool,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> sqlx::Result<Vec<DateTime<Utc>>> {
    // `deleted_at is null` (ticket 2): a deleted Entry's timestamp must not
    // count toward "does this Period have anything to write about" — a
    // Period whose only Entries were later deleted should read as empty,
    // not trigger a Digest over a tombstone.
    sqlx::query_scalar::<_, DateTime<Utc>>(
        "select created_at from entries where created_at >= $1 and created_at < $2 and deleted_at is null",
    )
    .bind(from_utc)
    .bind(to_utc)
    .fetch_all(pool)
    .await
}

/// Loads the actual Entries (id, body, timestamp) for one Period's window
/// — used only once `fill_period` has already decided this exact `start`
/// needs a Digest, so this always runs against the tight `period_bounds`
/// range rather than the wider scan window `select_entry_timestamps` reads.
async fn select_entries(
    pool: &PgPool,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> sqlx::Result<Vec<DigestEntry>> {
    // `deleted_at is null` (ticket 2), for the same reason as
    // `select_entry_timestamps` above: a tombstone's blank body must never
    // be fed to the Digest-writing chat call as Grounding.
    sqlx::query_as::<_, DigestEntry>(
        "select id, body, created_at, seq from entries \
         where created_at >= $1 and created_at < $2 and deleted_at is null \
         order by created_at asc",
    )
    .bind(from_utc)
    .bind(to_utc)
    .fetch_all(pool)
    .await
}

/// One Task fact fed into a Digest's chat call (issue #175) — the Task's
/// own text, and, for an overdue Task, the date or deadline that made it
/// so (`None` for a completed one; `render_tasks_block` below reads that
/// distinction directly rather than needing a second type). Deliberately
/// carries only what the prompt needs to say something true and specific
/// ("renew the passport, which was due 2026-08-20") — not the whole `Task`
/// row Export's own `ExportManifestTask` copies losslessly: a Digest is
/// prose written *about* a Task, never a record of it, so it has no reason
/// to carry a priority, a Label list, or an id the model would have
/// nothing to do with.
#[derive(Debug, Clone, PartialEq, Default, sqlx::FromRow)]
struct DigestTaskFact {
    content: String,
    due: Option<NaiveDate>,
}

/// What a Digest's chat call is told about Tasks, alongside the Entries it
/// already reads — `completed` (issue #175's first half: what got done) and
/// `overdue` (the second half: what didn't, and whose date or deadline had
/// already passed by the Period's own end). `Default` is what lets
/// `write_digest_for`/`run_regenerate` degrade to "no Task facts this
/// time" without failing the whole Digest when the Task queries below
/// error (see their own call sites' comments) — an empty `DigestTasks` is
/// indistinguishable, downstream, from "this Period genuinely had no Task
/// activity," which is the correct degrade: Entries remain this worker's
/// primary subject (ADR 0027), and Task coverage is additive.
#[derive(Debug, Clone, Default)]
struct DigestTasks {
    completed: Vec<DigestTaskFact>,
    overdue: Vec<DigestTaskFact>,
}

impl DigestTasks {
    fn is_empty(&self) -> bool {
        self.completed.is_empty() && self.overdue.is_empty()
    }
}

/// Both Task queries a Digest needs, run together — `select_entries`'s own
/// sibling, one level up (it composes the two queries below rather than
/// being a third query itself). `from_utc`/`to_utc` are the same UTC
/// instants `select_entries` was already called with for this Period,
/// passed in rather than re-derived, so a completed Task's own window
/// agrees with an Entry's by construction; `start` is used to compute the
/// Period's own end date (`period::period_end`) for the overdue query,
/// which reasons in local calendar dates rather than UTC instants (see
/// `select_overdue_tasks`'s own doc comment for why).
async fn select_digest_tasks(
    pool: &PgPool,
    period: Period,
    start: NaiveDate,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> sqlx::Result<DigestTasks> {
    let end = period::period_end(period, start);
    let completed = select_completed_tasks(pool, from_utc, to_utc).await?;
    let overdue = select_overdue_tasks(pool, start, end).await?;
    Ok(DigestTasks { completed, overdue })
}

/// Tasks completed inside `[from_utc, to_utc)` — the identical half-open
/// window `select_entries` reads, since `completed_at` (like `created_at`)
/// is a real UTC instant, not a floating date. `deleted_at is null`
/// mirrors `select_entries`'s own guard: a Task deleted after being
/// completed has nothing left worth telling the reader they finished.
async fn select_completed_tasks(
    pool: &PgPool,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> sqlx::Result<Vec<DigestTaskFact>> {
    sqlx::query_scalar::<_, String>(
        "select content from tasks \
         where deleted_at is null and completed_at is not null \
           and completed_at >= $1 and completed_at < $2 \
         order by completed_at asc",
    )
    .bind(from_utc)
    .bind(to_utc)
    .fetch_all(pool)
    .await
    .map(|rows| {
        rows.into_iter()
            .map(|content| DigestTaskFact { content, due: None })
            .collect()
    })
}

/// Active Tasks (not completed, not deleted) whose `date` or `deadline`
/// falls inside `[period_start, period_end]`, the Period's own inclusive
/// local calendar range — deliberately **not** "every Task overdue as of
/// today," which would repeat the same still-open Task in every Digest
/// written from the Period it first slipped in onwards, forever, the exact
/// scoreboard-that-never-clears this ticket's own "reads as prose about
/// the stretch of time" framing argues against. Scoping to the Period's
/// own window instead makes "overdue in its Period" mean "the reader's
/// plan for this stretch of time didn't hold," which is a fact about that
/// stretch specifically, told once.
///
/// `date`/`deadline` are floating text (`YYYY-MM-DD` or
/// `YYYY-MM-DDTHH:MM` for `date`, always `YYYY-MM-DD` for `deadline` —
/// `../../packages/core/src/task-types.ts`'s own doc comments), compared
/// here as local calendar dates against `period_start`/`period_end`
/// (themselves already local dates, `period::period_bounds`'s own
/// currency) — never converted through a UTC offset, the same "a floating
/// date is read exactly as stored" rule `tasks-file.ts` follows on the
/// Export side of this ticket for the identical reason: there is no
/// instant to convert, only a plan.
async fn select_overdue_tasks(
    pool: &PgPool,
    period_start: NaiveDate,
    period_end: NaiveDate,
) -> sqlx::Result<Vec<DigestTaskFact>> {
    sqlx::query_as::<_, DigestTaskFact>(
        "select content, coalesce(substring(date, 1, 10)::date, deadline::date) as due \
         from tasks \
         where deleted_at is null and completed_at is null \
           and ( \
             (date is not null and substring(date, 1, 10)::date between $1 and $2) \
             or (deadline is not null and deadline::date between $1 and $2) \
           ) \
         order by due asc, id asc",
    )
    .bind(period_start)
    .bind(period_end)
    .fetch_all(pool)
    .await
}

/// Renders `tasks` into the short block of facts appended to a Digest
/// chat call's own user message — `None` when there is nothing to say
/// (`generate_digest_body` then appends nothing at all, exactly the
/// "silence when there's nothing to add" convention the harness tools use
/// for a complete page). Deliberately terse and fact-only: this is input
/// the model reads and reworks into its own prose
/// (`digest_system_prompt`'s own instruction, extended by this ticket, to
/// weave these facts in rather than list them) — it is not itself the
/// Digest's prose, so it reads like a note, not a draft.
///
/// Both lines are written even when one half is empty — "Completed: none"
/// rather than omitting the line — so the model is told plainly that
/// nothing was finished, instead of being left to either invent a
/// completion or stay silent about a stretch that genuinely had none;
/// CONTEXT.md's "an Answer with no Grounding behind it says so plainly"
/// rule, applied here to Task coverage instead of Reflection's Grounding.
fn render_tasks_block(tasks: &DigestTasks) -> Option<String> {
    if tasks.is_empty() {
        return None;
    }
    let describe = |facts: &[DigestTaskFact]| -> String {
        if facts.is_empty() {
            return "none".to_string();
        }
        facts
            .iter()
            .map(|fact| match fact.due {
                Some(due) => format!("{} (was due {})", fact.content, due.format("%Y-%m-%d")),
                None => fact.content.clone(),
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    Some(format!(
        "Tasks from the user's to-do list, for the same stretch of time:\n\
         - Completed: {}.\n\
         - Still open, past their date or deadline: {}.",
        describe(&tasks.completed),
        describe(&tasks.overdue),
    ))
}

/// Inserts the background worker's own Digest for one Period, returning
/// whether a row was actually written. Always `revision = 1` — the worker
/// generates, it never regenerates (issue #132 / ADR 0039: only
/// `regenerate_digest_handler` ever mints revision 2 and above) — and the
/// `where not exists` guard makes that "only where no Digest exists for
/// this Period **at all**" literally, not merely "no revision 1 yet":
/// revision numbering is always contiguous from 1 (both this function and
/// `regenerate_insert` only ever write `coalesce(max(revision), 0) + 1`
/// worth of the next number), so "no revision 1" and "no Digest at all"
/// are the same fact here, but the explicit `not exists` says so directly
/// instead of leaning on that invariant silently holding.
///
/// `on conflict (period, period_start, revision) do nothing` is what makes
/// the `unique` constraint from migration `0009_digests_gain_revisions.sql`
/// a safe target for a retry or a race — between two ticks of this worker,
/// or between this worker and a concurrent `regenerate` racing to rescue
/// the same never-written Period — rather than something this code has to
/// avoid hitting on its own. Immutability is structural (the schema
/// enforces it), not a discipline the worker has to maintain by checking
/// first and hoping nothing else wrote in between.
async fn insert_digest(
    pool: &PgPool,
    period: Period,
    start: NaiveDate,
    body: &str,
    entry_ids: &[Uuid],
    source_seq: i64,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        "insert into digests (id, period, period_start, revision, body, grounding_entry_ids, source_seq) \
         select $1, $2, $3, 1, $4, $5, $6 \
         where not exists (select 1 from digests where period = $2 and period_start = $3) \
         on conflict (period, period_start, revision) do nothing",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(start)
    .bind(body)
    .bind(entry_ids)
    .bind(source_seq)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// The system prompt for the one chat call this worker ever makes.
///
/// Must begin with the exact phrase "You are the Digest writer" — this is
/// a **test contract, not a stylistic choice**: two separate test doubles
/// sniff this exact leading phrase to identify a Digest call —
/// `server/tests/digest.rs`'s fake chat client, and `apps/e2e/llm-stub.ts`'s
/// `isDigestCall` (issue #73). Both live outside this crate, so nothing
/// mechanical will catch a rewording; changing the opening means changing
/// both. This mirrors `reflect.rs`'s `extraction_system_prompt`, which
/// documents "Today's date" as the same kind of leading-phrase contract. Changing this opening without updating that test's matcher
/// would silently break the test, not the feature.
///
/// Deliberately carries no per-Period length target — CONTEXT.md and ADR
/// 0027 are explicit that the model sizes the prose to the material, and a
/// numeric target for "a day" vs. "a month" would be a guess this worker
/// has no basis to make. That reasoning still holds; issue #77 additionally
/// removed the length wording this prompt used to carry ("a short piece of
/// prose", "do not pad", "no length target to hit"), because it told the
/// model to be short and to have no length target in the same breath — a
/// self-contradiction a model resolves in favour of "short," the opposite
/// of what this worker wants. A Digest is a summary, and a summary is
/// already sized by the Entries it reads: a heavy Period reads as a heavy
/// Digest, a quiet one as a quiet Digest, with nothing more to say about
/// length than that.
fn digest_system_prompt() -> &'static str {
    "You are the Digest writer for meologue, a personal journal. You will be given everything \
     the user wrote during a named stretch of time, with each Entry labelled with the date it \
     was written. Summarise what they wrote about during that time, speaking directly to the \
     user in the second person. Use only what the Entries say — invent nothing: a Digest that \
     invents a past the user did not live is worse than one that says little. Do not include a \
     title, a preamble, headings or bullet points — just the prose itself. Write plain prose \
     with no Markdown: no asterisks, no underscores, no backticks. A Digest is meant to read as \
     one continuous piece of writing about a stretch of time, and formatting marks would make \
     it read as a document instead. You may also be given a short list of Tasks the user \
     completed or left overdue during the same stretch of time. Weave whatever is worth \
     mentioning into the same continuous prose — never as a separate list, a heading, or a \
     count of items done and not done: a Digest that reports task activity as a scoreboard has \
     stopped being a Digest. Use only the Tasks you are actually given — invent nothing there \
     either — and if none are given, or none of them are worth mentioning, say nothing about \
     tasks at all rather than inventing something to say."
}

/// The Period's own inclusive local date range, exactly as this module
/// rendered it before issue #136's chunking existed —
/// `"YYYY-MM-DD (day)"` for a Period whose start and end coincide,
/// `"YYYY-MM-DD to YYYY-MM-DD (a week/month)"` otherwise. Used by
/// `generate_digest_body` whenever a single chat call covers the whole
/// Period (today, always, since a real corpus never reaches the chunking
/// threshold — see `DIGEST_ENTRY_BUDGET_FRACTION`'s doc comment), which is
/// what keeps that overwhelmingly common case byte-identical to every
/// Digest this worker wrote before this function existed.
fn period_range_label(period: Period, start: NaiveDate) -> String {
    let end = period::period_end(period, start);
    if start == end {
        format!("{} ({})", start.format("%Y-%m-%d"), period.as_str())
    } else {
        format!(
            "{} to {} (a {})",
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d"),
            period.as_str()
        )
    }
}

/// One chunk's own inclusive local date range — issue #136's answer for
/// when a Period is split across several chat calls. `chunk` is never
/// empty (`chunk_entries` never produces an empty slice) and is already in
/// `created_at` order (`select_entries`'s `order by created_at asc`,
/// preserved end to end by the packing in `chunk_entries`), so its first
/// and last elements are that chunk's own earliest and latest Entry.
///
/// Naming *this span* rather than the whole Period's is the whole point:
/// issue #101 was filed because an Entry could be rendered under the
/// wrong local day inside a call that could see it fine; a multi-chunk
/// call using the Period's own range would repeat that failure one level
/// up — a date label true of the Period but false of what this one call
/// was actually handed, since a chunk only ever sees a fraction of the
/// Period's Entries. Deliberately not merged with `period_range_label`'s
/// `"(a week)"`/`"(day)"` suffix: a chunk's span is not itself a Period,
/// and inventing a Period-shaped word for an arbitrary slice of one would
/// claim a calendar meaning this span doesn't have.
fn chunk_range_label(chunk: &[DigestEntry], tz: Tz) -> String {
    let first = chunk
        .first()
        .expect("chunk_entries never produces an empty chunk")
        .created_at
        .with_timezone(&tz)
        .date_naive();
    let last = chunk
        .last()
        .expect("chunk_entries never produces an empty chunk")
        .created_at
        .with_timezone(&tz)
        .date_naive();
    if first == last {
        first.format("%Y-%m-%d").to_string()
    } else {
        format!("{} to {}", first.format("%Y-%m-%d"), last.format("%Y-%m-%d"))
    }
}

/// The user message naming `range` and followed by `entries` rendered as
/// `[YYYY-MM-DD] body`, blank-line separated, via `render_entry` below.
/// Shared by both shapes `generate_digest_body` needs: the single-chunk
/// case, where `range` is the whole Period's own span
/// (`period_range_label`) and `entries` is every Entry the Period holds,
/// and issue #136's multi-chunk case, where `range` and `entries` are one
/// chunk's own (`chunk_range_label`) — the same rendering either way, so a
/// reader (model or human) can't tell from the shape of the message
/// itself whether the Period behind it fit in one call or several.
///
/// `tz` is the same `Tz` `write_digest_for` already resolved `start`'s
/// Period bounds against (`period::period_bounds`) — reusing it here,
/// rather than letting this function read `MEOLOGUE_TZ` a second time on
/// its own, is what keeps "which Period an Entry was bucketed into" and
/// "what date it's labelled with when shown to the model" answers to the
/// same timezone, by construction, rather than by two call sites happening
/// to agree.
///
/// `tasks_block` (issue #175) is `render_tasks_block`'s own output,
/// `None` when this call carries no Task facts at all — appended after
/// the Entries block, with a blank line between the two, rather than
/// interleaved with it: the Entries block's own shape (`[YYYY-MM-DD]
/// body`, blank-line separated) is unrelated to a Task fact's, and
/// keeping them as two distinct paragraphs is what lets the system
/// prompt tell the model "this second part is a different kind of
/// material" without either block needing to say so itself.
fn build_messages(
    range: &str,
    entries: &[DigestEntry],
    tasks_block: Option<&str>,
    tz: Tz,
) -> Vec<ChatMessage> {
    let entries_block = entries
        .iter()
        .map(|entry| render_entry(entry, tz))
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut user_content =
        format!("Here is everything the user wrote from {range}:\n\n{entries_block}");
    if let Some(block) = tasks_block {
        user_content.push_str("\n\n");
        user_content.push_str(block);
    }

    vec![
        ChatMessage {
            role: "system".to_string(),
            content: digest_system_prompt().to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
        },
    ]
}

/// Renders one `DigestEntry` as `[local-date] body` — this worker's own
/// analogue of `harness::tools::render_entry` (issue #101), and
/// deliberately not the same function despite doing the same job for the
/// same reason: the "local" each one resolves comes from a different
/// place. A harness tool acts for an asking Device and uses the
/// `utc_offset_minutes` it supplies on every Question (ADR 0023); this
/// worker has no Device in its loop at all (ADR 0027) and instead uses
/// the Server's own configured `MEOLOGUE_TZ`, read once at startup
/// (`period::server_timezone`) as a full IANA `chrono_tz::Tz` rather than
/// a fixed offset — a `Tz` is what lets `period_bounds` (and this
/// rendering, which must agree with it) account for a DST transition
/// inside the Period being summarised, something a snapshot offset
/// cannot do. Sharing one function between the two would mean converting
/// a `Tz` down to a fixed offset at some arbitrary instant to satisfy the
/// other's signature, which quietly reintroduces the DST case a `Tz`
/// exists to handle correctly — see `harness::tools::render_entry`'s doc
/// comment for the fuller "two sources of local, do not conflate them"
/// reasoning this mirrors.
///
/// Before this fix, `build_messages` formatted `entry.created_at` (UTC)
/// directly, while `write_digest_for` had already bucketed that same
/// Entry into a Period using `tz` — the identical shape of bug issue #101
/// reports for the harness tools, just with `MEOLOGUE_TZ` standing in for
/// a Device's offset: an Entry correctly bucketed into a local day could
/// be shown to the model labelled with the UTC day before or after it.
///
/// The body itself is passed through
/// `harness::tools::indent_continuation_lines` (issue #151) so a
/// multi-line body's lines after the first are indented two spaces — the
/// one piece of this rendering that has nothing to do with which
/// "local" a Period or a Device resolves, and so is shared rather than
/// copied a third time; see that function's own doc comment.
fn render_entry(entry: &DigestEntry, tz: Tz) -> String {
    let local_date = entry.created_at.with_timezone(&tz).date_naive();
    format!(
        "[{}] {}",
        local_date.format("%Y-%m-%d"),
        crate::harness::tools::indent_continuation_lines(&entry.body)
    )
}

// ---------------------------------------------------------------------
// HTTP: GET /v1/digests/{period} and GET /v1/digests/{period}/{date}
// (issue #70)
// ---------------------------------------------------------------------

/// One `digests` row, as loaded for a response — deliberately not the same
/// struct as this module's worker-side `DigestEntry` (that's an *Entry*
/// read out of a Period's window; this is the *Digest* row itself).
/// `period` and `period_end` are left out here and computed by the handler
/// instead — `period` because the caller already knows which `Period` it
/// queried, and `period_end` because it is always a pure function of
/// `period_start` (`period::period_end`), never a second, parallel value
/// worth persisting or selecting.
///
/// `pub(crate)` (issue #95, both the struct and `select_digest_at` below)
/// for the same reason `reflect::local_date_range_to_utc` was widened to
/// `pub(crate)` for `entries_in_range.rs`: `harness::tools::read_digest`
/// needs the exact row this HTTP handler already selects, and duplicating
/// the query — or the row shape — in the tools module would be a second
/// place that knows what a `digests` row looks like, exactly what this
/// module's own doc comment says to avoid. Nothing about the query or the
/// row itself changes; only what can see it.
///
/// `revision`, `source_seq` and `created_at` (issue #132 / ADR 0039): the
/// newest revision of a Period is now what both `select_latest_digest` and
/// `select_digest_at` pick, and `build_digest_response` needs `source_seq`
/// to answer "is this stale" and `revision`/`created_at` to render the
/// provenance cue — `harness::tools::read_digest` simply ignores the three
/// it doesn't use, the same as it already ignores `period_start` where it
/// doesn't need it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct DigestRecord {
    pub(crate) period_start: NaiveDate,
    pub(crate) body: String,
    pub(crate) grounding_entry_ids: Vec<Uuid>,
    pub(crate) revision: i32,
    pub(crate) source_seq: i64,
    pub(crate) created_at: DateTime<Utc>,
}

/// The wire shape of one Digest — everything a client needs to render it
/// (its Period, its inclusive local date range, its prose, the Entries it
/// grounds in) plus the two neighbour dates described on `DigestResponse`.
/// `period` is the plain string (`Period::as_str`) rather than the `Period`
/// enum itself — `Period` carries no `Serialize`/`ToSchema` impl of its own
/// (nothing before this ticket ever put it on the wire), and adding one
/// just for this single field would be more machinery than reusing the
/// string every other layer already keys on.
#[derive(Debug, Serialize, ToSchema)]
pub struct Digest {
    pub period: String,
    pub period_start: NaiveDate,
    /// The inclusive last local date this Digest covers
    /// (`period::period_end`) — handed over pre-computed so a client can
    /// render "10-16 Aug" without reimplementing this module's calendar
    /// maths (ADR 0027's "one implementation, used everywhere" rule
    /// extends to the client side of the wire too).
    pub period_end: NaiveDate,
    pub body: String,
    pub grounding_entry_ids: Vec<Uuid>,
    /// The `period_start` of the previous Digest of this same Period that
    /// actually exists, skipping any completed-but-undigested gap — `None`
    /// means this is the oldest Digest of this Period the Server holds.
    pub prev_date: Option<NaiveDate>,
    /// The `period_start` of the next Digest of this same Period that
    /// actually exists — `None` means this is the newest.
    pub next_date: Option<NaiveDate>,
    /// Whether some Entry in this Period has moved (been added, edited, or
    /// deleted) since this exact revision was written — issue #132 / ADR
    /// 0039. Computed fresh on every read (`select_is_stale`), never
    /// stored: staleness is a fact about the *current* relationship
    /// between this revision's `source_seq` and `entries`, not something
    /// that could go stale itself. A neutral fact, not an error — CONTEXT.md's
    /// Sync status entry sets the same tone for "off is not a failure."
    pub stale: bool,
    /// Which revision this is — 1 for the background worker's own,
    /// first-generation write; 2 and up for each successive
    /// `POST /v1/digests/{period}/{date}/regenerate`. There is no revision
    /// picker (issue #132): a client only ever sees the newest, and this
    /// field plus `written_at` below is the provenance cue that
    /// distinguishes "the Server wrote this by itself" (`revision == 1`)
    /// from "you asked for this" (`revision > 1`).
    pub revision: i32,
    /// This exact revision's own `created_at` — when *this* revision was
    /// written, not when the Period itself started or ended
    /// (`period_start`/`period_end` above already cover that). A reader
    /// renders "Written {date}" for `revision == 1` or "Regenerated {date}"
    /// otherwise, from this field.
    pub written_at: DateTime<Utc>,
}

/// The body both Digest routes return. **Always 200** — a missing Digest
/// (`digest: null`) is carried in the payload, never signalled with 404.
/// This is the one load-bearing decision in issue #70: a client must be
/// able to tell four situations apart — Sync is off, the Server is
/// unreachable, the Server predates these routes entirely, and the Server
/// is fine but hasn't written a Digest yet. The third of those is already
/// how `apps/web/src/lib/reflect-transport.ts` detects a Server that
/// predates Reflection: a 404 on `/v1/reflect` (the route was never
/// registered, see `lib.rs`'s `reflect.is_some()` gate, extended here by
/// `digests_enabled`) means "this Server doesn't know about Reflection."
/// If an empty Digest also 404'd, a brand-new install — chat configured,
/// worker running, nothing written yet because no Period has completed —
/// would be told its Server is *too old*, which is simply false. So a 404
/// here is reserved for "this Server has no Digest routes at all," and
/// every request that reaches a registered route answers 200, with `digest`
/// carrying either the row or `null`.
///
/// An unparseable `{period}` or `{date}`, on the other hand, is a 400 (see
/// the handlers below) — that's a malformed request, a different failure
/// from "the Digest doesn't exist," and conflating the two would make a
/// typo in the URL look identical to an ordinary empty archive.
#[derive(Debug, Serialize, ToSchema)]
pub struct DigestResponse {
    pub digest: Option<Digest>,
}

#[utoipa::path(
    get,
    path = "/v1/digests/{period}",
    params(("period" = String, Path, description = "\"day\", \"week\", or \"month\"")),
    responses(
        (status = 200, description = "The most recent Digest of this Period, or `{\"digest\": null}` if none has been written yet", body = DigestResponse),
        (status = 400, description = "`period` is not \"day\", \"week\", or \"month\""),
    )
)]
pub async fn latest_digest_handler(
    State(pool): State<PgPool>,
    State(digest): State<Option<DigestState>>,
    Path(period): Path<String>,
) -> Result<Json<DigestResponse>, StatusCode> {
    let period = Period::parse(&period).ok_or(StatusCode::BAD_REQUEST)?;
    // Only reachable if this state's absence somehow slipped past the
    // conditional route registration in `lib.rs` — mirrors
    // `reflect::reflect_handler`'s own defensive fallback exactly. This
    // route is registered only when `DigestState` is `Some` (`lib.rs`'s
    // `router_with_digests`), so a `None` here means the registration
    // gate itself broke, not anything a client did.
    let Some(digest) = digest else {
        tracing::error!("latest_digest_handler invoked with no DigestState — route should not be registered");
        return Err(StatusCode::NOT_FOUND);
    };
    match run_latest_digest(&pool, digest.tz, period).await {
        Ok(response) => Ok(Json(response)),
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), "loading the latest digest failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// Mirrors `latest_digest_handler`, but for one specific `period_start`
/// rather than "whichever is newest." `date` is parsed as `YYYY-MM-DD`
/// (the same format `reflect.rs::parse_date_range` and `digest.rs`'s own
/// `build_messages` already render dates in) — a value that doesn't parse
/// is a 400, same reasoning as an unrecognised `period`.
#[utoipa::path(
    get,
    path = "/v1/digests/{period}/{date}",
    params(
        ("period" = String, Path, description = "\"day\", \"week\", or \"month\""),
        ("date" = String, Path, description = "The Digest's `period_start`, as YYYY-MM-DD"),
    ),
    responses(
        (status = 200, description = "The Digest at this exact date, or `{\"digest\": null}` if none exists there", body = DigestResponse),
        (status = 400, description = "`period` is unrecognised, or `date` is not a valid YYYY-MM-DD date"),
    )
)]
pub async fn digest_at_handler(
    State(pool): State<PgPool>,
    State(digest): State<Option<DigestState>>,
    Path((period, date)): Path<(String, String)>,
) -> Result<Json<DigestResponse>, StatusCode> {
    let period = Period::parse(&period).ok_or(StatusCode::BAD_REQUEST)?;
    let date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| StatusCode::BAD_REQUEST)?;
    let Some(digest) = digest else {
        tracing::error!("digest_at_handler invoked with no DigestState — route should not be registered");
        return Err(StatusCode::NOT_FOUND);
    };
    match run_digest_at(&pool, digest.tz, period, date).await {
        Ok(response) => Ok(Json(response)),
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), %date, "loading a digest by date failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn run_latest_digest(pool: &PgPool, tz: Tz, period: Period) -> anyhow::Result<DigestResponse> {
    let record = select_latest_digest(pool, period).await?;
    build_digest_response(pool, tz, period, record).await
}

async fn run_digest_at(
    pool: &PgPool,
    tz: Tz,
    period: Period,
    date: NaiveDate,
) -> anyhow::Result<DigestResponse> {
    let record = select_digest_at(pool, period, date).await?;
    build_digest_response(pool, tz, period, record).await
}

/// Turns a possibly-absent row into the wire response, filling in
/// `period_end`, both neighbour dates, and (issue #132 / ADR 0039)
/// `stale`/`revision`/`written_at` when a row was actually found. `None`
/// short-circuits before any of that runs — an absent Digest has no
/// `period_start` to look for neighbours around or a watermark to check,
/// and the response is simply `{"digest": null}` (see `DigestResponse`'s
/// doc comment for why that's a 200, never a 404).
async fn build_digest_response(
    pool: &PgPool,
    tz: Tz,
    period: Period,
    record: Option<DigestRecord>,
) -> anyhow::Result<DigestResponse> {
    let Some(record) = record else {
        return Ok(DigestResponse { digest: None });
    };

    // Neighbours are the previous/next Digest that actually *exists* for
    // this Period — not the previous/next calendar Period, which might
    // have no Digest at all (a gap the resume rule in `fill_period` hasn't
    // filled, or simply never will because that Period held no Entries).
    // Two `min`/`max` queries, scoped to this Period and relative to this
    // row's own `period_start`, are what let a client walk the archive one
    // Digest at a time and skip any gap without knowing where it is or
    // computing a date itself — see ADR 0027 and this ticket: it is also
    // exactly what removes the need for a list endpoint or pagination.
    // Both are unaffected by revisions — they compare `period_start`
    // values, which `digests` never gains a second one of for the same
    // Period without also gaining a distinct revision.
    let prev_date = select_prev_digest_date(pool, period, record.period_start).await?;
    let next_date = select_next_digest_date(pool, period, record.period_start).await?;

    // Issue #132 / ADR 0039: stale exactly when some Entry in this exact
    // Period has moved (been added, edited, or deleted) since
    // `record.source_seq` was recorded — see `select_is_stale`'s own doc
    // comment for the query and why it deliberately never filters
    // `deleted_at`.
    let (from_utc, to_utc) = period::period_bounds(period, tz, record.period_start);
    let stale = select_is_stale(pool, from_utc, to_utc, record.source_seq).await?;

    Ok(DigestResponse {
        digest: Some(Digest {
            period: period.as_str().to_string(),
            period_end: period::period_end(period, record.period_start),
            period_start: record.period_start,
            body: record.body,
            grounding_entry_ids: record.grounding_entry_ids,
            prev_date,
            next_date,
            stale,
            revision: record.revision,
            written_at: record.created_at,
        }),
    })
}

/// Whether some Entry in `[from_utc, to_utc)` has moved since
/// `source_seq` — issue #132 / ADR 0039's staleness rule, reusing
/// `entries.seq` (reassigned on every edit and delete,
/// `sync.rs`'s `on conflict do update ... seq = nextval(...)`) as the
/// watermark ADR 0028 already gives for last-touch order, rather than
/// adding an `updated_at` column ADR 0028 explicitly says isn't needed
/// anywhere.
///
/// Deliberately **not** filtered by `deleted_at is null`, unlike every
/// other query in this module that reads `entries` (`select_entries`,
/// `select_entry_timestamps`) — those exist to decide what a Digest's
/// *prose* should say, where a tombstone has nothing left to contribute;
/// this one exists to decide whether that prose is still accurate, where a
/// deletion is exactly the kind of change worth reporting. An Entry that
/// was deleted after this revision was written moved its `seq` on the way
/// out (the same `on conflict do update` reassigns `seq` on a delete, not
/// only an edit), so it trips this predicate on its own merits — nothing
/// deletion-specific has to be added here for that to hold.
async fn select_is_stale(
    pool: &PgPool,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
    source_seq: i64,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "select exists (
             select 1 from entries
             where created_at >= $1 and created_at < $2 and seq > $3
         )",
    )
    .bind(from_utc)
    .bind(to_utc)
    .bind(source_seq)
    .fetch_one(pool)
    .await
}

async fn select_latest_digest(pool: &PgPool, period: Period) -> sqlx::Result<Option<DigestRecord>> {
    // `order by period_start desc, revision desc` — the most recent
    // Digest of this Period type overall, and (issue #132 / ADR 0039)
    // whichever revision of that exact Period is newest, since more than
    // one may now exist for the same `period_start`.
    sqlx::query_as::<_, DigestRecord>(
        "select period_start, body, grounding_entry_ids, revision, source_seq, created_at
         from digests
         where period = $1
         order by period_start desc, revision desc
         limit 1",
    )
    .bind(period.as_str())
    .fetch_optional(pool)
    .await
}

pub(crate) async fn select_digest_at(
    pool: &PgPool,
    period: Period,
    date: NaiveDate,
) -> sqlx::Result<Option<DigestRecord>> {
    // `order by revision desc limit 1` (issue #132 / ADR 0039): reads take
    // the newest revision of this exact `(period, period_start)` — there
    // is no revision picker anywhere in this codebase, only ever "the
    // newest."
    sqlx::query_as::<_, DigestRecord>(
        "select period_start, body, grounding_entry_ids, revision, source_seq, created_at
         from digests
         where period = $1 and period_start = $2
         order by revision desc
         limit 1",
    )
    .bind(period.as_str())
    .bind(date)
    .fetch_optional(pool)
    .await
}

async fn select_prev_digest_date(
    pool: &PgPool,
    period: Period,
    before: NaiveDate,
) -> sqlx::Result<Option<NaiveDate>> {
    sqlx::query_scalar::<_, Option<NaiveDate>>(
        "select max(period_start) from digests where period = $1 and period_start < $2",
    )
    .bind(period.as_str())
    .bind(before)
    .fetch_one(pool)
    .await
}

async fn select_next_digest_date(
    pool: &PgPool,
    period: Period,
    after: NaiveDate,
) -> sqlx::Result<Option<NaiveDate>> {
    sqlx::query_scalar::<_, Option<NaiveDate>>(
        "select min(period_start) from digests where period = $1 and period_start > $2",
    )
    .bind(period.as_str())
    .bind(after)
    .fetch_one(pool)
    .await
}

// ---------------------------------------------------------------------
// HTTP: POST /v1/digests/{period}/{date}/regenerate (issue #132, ADR 0039)
// ---------------------------------------------------------------------
//
// The reader's Regenerate action: synchronous, on purpose — a reader
// pressed a button and is watching, so the chat call runs inline and the
// response carries the new revision directly, rather than the worker's own
// "hint, then poll" shape (there is no hint to give here; nothing is
// polling). This reuses `select_entries` and `build_messages` — the exact
// machinery `write_digest_for` already builds a Digest's chat call from —
// so the prompt this route sends is indistinguishable from the worker's
// own, including `digest_system_prompt`'s leading "You are the Digest
// writer" phrase both `server/tests/digest.rs`'s `is_digest_call` and
// `apps/e2e/llm-stub.ts`'s `isDigestCall` sniff to recognise a Digest call
// at all. Nothing about that phrase changes here, deliberately: this route
// existing is exactly the case those two test doubles have to keep
// recognising, on the regenerate path as well as the worker's tick.
//
// Always inserts at `max(revision) + 1` for the named `(period, date)` —
// or `1`, straight through `coalesce`, when nothing was ever written for
// it at all. That second case is what makes this route the rescue ADR
// 0027's Consequences names: a Period stuck past `MAX_ATTEMPTS` is
// indistinguishable from one never attempted (the attempt count is
// process-local and gone on restart, so no row exists either way), and
// this is the only path in the whole codebase that can put a first row
// there outside the worker's own tick.

#[utoipa::path(
    post,
    path = "/v1/digests/{period}/{date}/regenerate",
    params(
        ("period" = String, Path, description = "\"day\", \"week\", or \"month\""),
        ("date" = String, Path, description = "The Digest's `period_start`, as YYYY-MM-DD"),
    ),
    responses(
        (status = 200, description = "The Digest at this exact date, now holding the newly written revision (or `{\"digest\": null}` if the Period held no Entries to write from)", body = DigestResponse),
        (status = 400, description = "`period` is unrecognised, or `date` is not a valid YYYY-MM-DD date"),
        (status = 500, description = "the chat call, or the insert, failed"),
        (status = 503, description = "Digest is configured but switched off (issue #201) — \
            distinct from 404, which means this Server predates the feature entirely"),
    )
)]
pub async fn regenerate_digest_handler(
    State(pool): State<PgPool>,
    State(digest): State<Option<DigestState>>,
    State(flags): State<RuntimeFlags>,
    Path((period, date)): Path<(String, String)>,
) -> Result<Json<DigestResponse>, StatusCode> {
    let period = Period::parse(&period).ok_or(StatusCode::BAD_REQUEST)?;
    let date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| StatusCode::BAD_REQUEST)?;
    // Same defensive fallback as `latest_digest_handler`/`digest_at_handler`
    // above — this route is registered only alongside them, under the same
    // `digest.is_some()` gate in `lib.rs`.
    let Some(digest) = digest else {
        tracing::error!(
            "regenerate_digest_handler invoked with no DigestState — route should not be registered"
        );
        return Err(StatusCode::NOT_FOUND);
    };

    // Issue #201: unlike the two reads beside this route
    // (`latest_digest_handler`/`digest_at_handler`, deliberately left
    // unaffected by this toggle — reading a Digest that already exists is
    // no different from reading a past Session while Reflection is off),
    // *writing* a new one is exactly the on-demand chat call the toggle
    // exists to let an operator refuse. 503, not 404 — the route is
    // registered (Digest was configured at boot); it is simply not doing
    // this particular kind of work right now.
    if !flags.digest_enabled() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    match run_regenerate(
        &pool,
        digest.chat_client.as_ref(),
        digest.tz,
        period,
        date,
        digest.context_window,
    )
    .await
    {
        Ok(response) => Ok(Json(response)),
        Err(err) => {
            tracing::error!(error = ?err, period = period.as_str(), %date, "regenerating a digest failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// The regenerate route's whole body, split out from the handler the same
/// way `run_latest_digest`/`run_digest_at` are — a plain `anyhow::Result`
/// this file's own tests can call directly without going through axum's
/// extractors.
///
/// If the named Period holds no Entries at all (deleted since, or never
/// written), this writes nothing — mirroring `write_digest_for`'s own
/// defensive "an empty Digest is pointless" guard — and simply returns
/// whatever Digest already exists there (possibly `None`), the same
/// "always 200, never invent a row" contract every other Digest read in
/// this module already keeps.
///
/// Issue #135: if the Period does hold Entries but every chunk of
/// `generate_digest_body`'s reply is rejected (empty, whitespace-only, or
/// fence-only) or its chat call fails, this function returns `Err` — the
/// `?` below propagates it straight through `regenerate_digest_handler` as
/// a 500, and `regenerate_insert` is never called, so no revision is
/// minted. That matters more here than in the worker:
/// `select_digest_at`/`select_latest_digest` always take the newest
/// revision unconditionally (ADR 0039), so a blank revision that did get
/// inserted would shadow whatever good revision came before it, not
/// merely fail to improve on it. There is no retry loop on this route the
/// way `write_digest_for` has one across ticks — a rejected regenerate
/// simply asks the caller to press the button again.
///
/// Issue #136: `context_window` (from `DigestState`, the same
/// process-wide value `digest::run` was started with) flows straight into
/// `generate_digest_body` here exactly as it does from the worker side —
/// this route reuses `select_entries` and `generate_digest_body` in full,
/// so a Period too large for one chat call splits on the regenerate path
/// the same way it would on the worker's own tick, at the same budget.
///
/// **Issue #137, accepted risk: regenerate may write a partial revision
/// over a complete one, and this function does not guard against it.**
/// When some but not all chunks fail, `generate_digest_body` now returns
/// `Ok` with a body covering only the surviving chunks, a
/// `grounding_entry_ids` narrower than the full Period, and `source_seq =
/// 0` — and this function inserts that revision exactly as it would a
/// complete one, via the same `regenerate_insert` call below, with no
/// check of what it is replacing. Concretely: pressing Regenerate on a
/// Period that already holds a perfectly good revision 3 can mint a
/// partial revision 4 that shadows it, because reads take the newest
/// revision unconditionally (ADR 0039, restated just above). A "refuse to
/// insert a partial revision over a complete one" guard was considered and
/// rejected for this ticket — it would need to diff two revisions' own
/// completeness before every insert, machinery this route has never
/// needed for anything else, to defend against a case that already carries
/// its own remedy: the `source_seq = 0` this same partial revision is
/// born with makes it report `stale = true` on the very next read (see
/// `generate_digest_body`'s own doc comment for why that `0` is written
/// deliberately, not incidentally), which is the same cue that already
/// tells a reader to press Regenerate again for any other stale Digest.
/// The mitigation is that stale marker, not a write-time refusal — a
/// reader who presses Regenerate a second time gets another chance at a
/// complete revision, same as they would for any other cause of
/// staleness.
async fn run_regenerate(
    pool: &PgPool,
    client: &(dyn LlmClient + Send + Sync),
    tz: Tz,
    period: Period,
    date: NaiveDate,
    context_window: u32,
) -> anyhow::Result<DigestResponse> {
    let (from_utc, to_utc) = period::period_bounds(period, tz, date);
    let entries = select_entries(pool, from_utc, to_utc).await?;

    if !entries.is_empty() {
        // Issue #175: same degrade-on-failure as `write_digest_for` — see
        // that call site's own comment. Deliberately still gated on
        // `!entries.is_empty()`, unchanged from before this ticket: a
        // Period with Task activity but no Entries at all still produces
        // no Digest, on the same "Entries remain this worker's primary
        // subject" reasoning `select_digest_tasks`'s own doc comment
        // gives — widening *when* a Digest gets written at all to include
        // Task-only Periods is a bigger, separate decision this ticket
        // does not make.
        let tasks = match select_digest_tasks(pool, period, date, from_utc, to_utc).await {
            Ok(tasks) => tasks,
            Err(err) => {
                tracing::warn!(error = ?err, period = period.as_str(), %date, "failed to load Task facts for a digest regenerate; continuing without them");
                DigestTasks::default()
            }
        };

        // `generate_digest_body` (issue #135, chunked per issue #136) is
        // the same single path `write_digest_for` goes through — a
        // rejected reply (empty, whitespace-only, or fence-only), or any
        // one chunk of several failing, surfaces as an `Err` here, `?`
        // propagates it straight out of this function, and
        // `regenerate_insert` below is never reached: no revision is
        // minted, so an existing good revision is never shadowed by a
        // blank one (the exact failure this ticket was filed against).
        let generated =
            generate_digest_body(client, period, date, &entries, &tasks, tz, context_window)
                .await?;
        regenerate_insert(
            pool,
            period,
            date,
            &generated.body,
            &generated.grounding_entry_ids,
            generated.source_seq,
        )
        .await?;
    }

    let record = select_digest_at(pool, period, date).await?;
    build_digest_response(pool, tz, period, record).await
}

/// Inserts the next revision of a Digest — `coalesce(max(revision), 0) +
/// 1` for this exact `(period, period_start)`, computed inside the same
/// `insert ... select` statement rather than read back separately, so
/// there's no window between "read the current max" and "insert the next
/// one" for a second call to land in. `unique (period, period_start,
/// revision)` (`0009_digests_gain_revisions.sql`) still backs this up
/// structurally against two truly concurrent regenerate calls racing for
/// the same next number — this is a single-user journal with at most a
/// handful of Devices, not a high-concurrency system, so the loser of that
/// rare race simply surfaces its `sqlx::Error` up through `run_regenerate`
/// as an ordinary 500 rather than being silently retried; a reader who
/// hits that can just press Regenerate again.
///
/// Deliberately not `insert_digest` (the worker's own function) with an
/// extra parameter: that function's entire contract is "only revision 1,
/// only where nothing exists yet" (see its own doc comment) — the worker
/// generates, it does not regenerate, and folding this function's
/// "whatever comes next" behaviour into it would blur a distinction this
/// ticket depends on staying sharp.
async fn regenerate_insert(
    pool: &PgPool,
    period: Period,
    start: NaiveDate,
    body: &str,
    entry_ids: &[Uuid],
    source_seq: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "insert into digests (id, period, period_start, revision, body, grounding_entry_ids, source_seq) \
         select $1, $2, $3, coalesce(max(revision), 0) + 1, $4, $5, $6 \
         from digests \
         where period = $2 and period_start = $3",
    )
    .bind(Uuid::new_v4())
    .bind(period.as_str())
    .bind(start)
    .bind(body)
    .bind(entry_ids)
    .bind(source_seq)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        DigestEntry, DigestTaskFact, DigestTasks, digest_system_prompt, render_entry,
        render_tasks_block, select_completed_tasks, select_digest_tasks, select_overdue_tasks,
    };
    use crate::period::Period;
    use chrono::{DateTime, NaiveDate, TimeZone};
    use chrono_tz::Tz;
    use sqlx::PgPool;
    use uuid::Uuid;

    fn entry(body: &str) -> DigestEntry {
        DigestEntry {
            id: Uuid::nil(),
            body: body.to_string(),
            created_at: Tz::UTC
                .with_ymd_and_hms(2026, 6, 30, 12, 0, 0)
                .unwrap()
                .with_timezone(&chrono::Utc),
            seq: 1,
        }
    }

    /// Issue #151's own byte-identical requirement: a single-line body
    /// must render exactly as it did before this ticket.
    #[test]
    fn a_single_line_body_renders_unchanged() {
        assert_eq!(
            render_entry(&entry("hello world"), Tz::UTC),
            "[2026-06-30] hello world"
        );
    }

    #[test]
    fn a_multi_line_body_has_continuation_lines_indented() {
        assert_eq!(
            render_entry(&entry("line one\nline two\nline three"), Tz::UTC),
            "[2026-06-30] line one\n  line two\n  line three"
        );
    }

    #[test]
    fn an_empty_body_renders_unchanged() {
        assert_eq!(render_entry(&entry(""), Tz::UTC), "[2026-06-30] ");
    }

    #[test]
    fn a_body_of_only_newlines_indents_every_blank_continuation_line() {
        assert_eq!(
            render_entry(&entry("\n\n"), Tz::UTC),
            "[2026-06-30] \n  \n  "
        );
    }

    #[test]
    fn a_trailing_newline_indents_the_trailing_blank_line_too() {
        assert_eq!(
            render_entry(&entry("first\nsecond\n"), Tz::UTC),
            "[2026-06-30] first\n  second\n  "
        );
    }

    #[test]
    fn crlf_line_endings_keep_the_carriage_return_on_the_line_it_ends() {
        assert_eq!(
            render_entry(&entry("first\r\nsecond\r\n"), Tz::UTC),
            "[2026-06-30] first\r\n  second\r\n  "
        );
    }

    /// The scenario the issue names directly: two multi-line Entries on
    /// the same day, rendered one after another the way `build_messages`
    /// joins them, must stay distinguishable — a reader can tell exactly
    /// where the second `[YYYY-MM-DD]` prefix starts.
    #[test]
    fn two_multi_line_entries_on_the_same_day_stay_distinguishable() {
        let first = render_entry(&entry("meeting notes\n- item one\n- item two"), Tz::UTC);
        let second = render_entry(
            &entry("evening reflection\nstill thinking about it"),
            Tz::UTC,
        );
        let joined = format!("{first}\n\n{second}");
        assert_eq!(
            joined,
            "[2026-06-30] meeting notes\n  - item one\n  - item two\n\n\
             [2026-06-30] evening reflection\n  still thinking about it"
        );
        // Every line that starts a new Entry begins with the date
        // prefix; every other line is indented — so scanning for
        // `[2026-06-30]` at column 0 finds exactly two Entries, not one
        // run-together block.
        let entry_starts = joined
            .lines()
            .filter(|line| line.starts_with("[2026-06-30]"))
            .count();
        assert_eq!(entry_starts, 2);
    }

    // Issue #140: the Digest reader now renders the same inline formatting
    // as everywhere else, so this prompt's old claim that "the Digest is
    // rendered as plain text" became false. This test pins the two halves
    // of that repair that must both still hold: the leading phrase both
    // `server/tests/digest.rs`'s `is_digest_call` and
    // `apps/e2e/llm-stub.ts`'s `isDigestCall` sniff to recognise a Digest
    // call at all (the prompt's own doc comment names this a test
    // contract, not a stylistic choice — nothing mechanical catches a
    // rewording of it besides these two matchers), and the instruction
    // that the model itself still emit no Markdown, which did not change
    // just because the reader now knows how to render it if it did.
    #[test]
    fn digest_system_prompt_still_opens_with_the_sniffed_phrase_and_forbids_markdown() {
        let prompt = digest_system_prompt();
        assert!(
            prompt.starts_with("You are the Digest writer"),
            "changing this opening breaks server/tests/digest.rs's is_digest_call and \
             apps/e2e/llm-stub.ts's isDigestCall, neither of which lives in this crate"
        );
        assert!(prompt.contains("no Markdown"));
        assert!(prompt.contains("no asterisks"));
    }

    // -------------------------------------------------------------------
    // Issue #175: a Digest covers the Tasks completed and overdue in its
    // Period, and is told plainly not to turn that coverage into a
    // scoreboard.
    // -------------------------------------------------------------------

    #[test]
    fn the_system_prompt_forbids_a_task_scoreboard_and_invented_tasks() {
        let prompt = digest_system_prompt();
        assert!(prompt.contains("scoreboard"));
        assert!(
            prompt.contains("Use only the Tasks you are actually given — invent nothing there"),
            "the prompt must extend the same invent-nothing discipline it already gives \
             Entries to Task coverage, not add a second, weaker rule: {prompt}"
        );
    }

    fn fact(content: &str) -> DigestTaskFact {
        DigestTaskFact {
            content: content.to_string(),
            due: None,
        }
    }

    fn overdue_fact(content: &str, due: (i32, u32, u32)) -> DigestTaskFact {
        DigestTaskFact {
            content: content.to_string(),
            due: Some(NaiveDate::from_ymd_opt(due.0, due.1, due.2).unwrap()),
        }
    }

    #[test]
    fn no_task_activity_at_all_renders_nothing_to_append() {
        assert_eq!(render_tasks_block(&DigestTasks::default()), None);
    }

    #[test]
    fn a_completed_task_with_nothing_overdue_says_so_honestly_rather_than_omitting_the_line() {
        let tasks = DigestTasks {
            completed: vec![fact("buy milk")],
            overdue: vec![],
        };
        let block = render_tasks_block(&tasks).expect("some Task activity");
        assert!(block.contains("Completed: buy milk."));
        assert!(
            block.contains("Still open, past their date or deadline: none."),
            "an empty half must say so explicitly, the same 'no Grounding says so plainly' \
             rule CONTEXT.md gives Reflection: {block}"
        );
    }

    #[test]
    fn an_overdue_task_names_the_date_or_deadline_that_passed() {
        let tasks = DigestTasks {
            completed: vec![],
            overdue: vec![overdue_fact("renew passport", (2026, 8, 20))],
        };
        let block = render_tasks_block(&tasks).expect("some Task activity");
        assert!(block.contains("Completed: none."));
        assert!(block.contains("renew passport (was due 2026-08-20)"));
    }

    #[test]
    fn several_tasks_on_one_side_are_joined_rather_than_only_the_first_kept() {
        let tasks = DigestTasks {
            completed: vec![fact("buy milk"), fact("call plumber")],
            overdue: vec![],
        };
        let block = render_tasks_block(&tasks).expect("some Task activity");
        assert!(block.contains("Completed: buy milk; call plumber."));
    }

    async fn insert_task(
        pool: &PgPool,
        id: Uuid,
        content: &str,
        completed_at: Option<DateTime<chrono::Utc>>,
        date: Option<&str>,
        deadline: Option<&str>,
    ) {
        sqlx::query(
            "insert into tasks (id, device_id, content, completed_at, order_key, day_order, created_at, date, deadline) \
             values ($1, $2, $3, $4, 'a', 'a', now(), $5, $6)",
        )
        .bind(id)
        .bind(Uuid::new_v4())
        .bind(content)
        .bind(completed_at)
        .bind(date)
        .bind(deadline)
        .execute(pool)
        .await
        .unwrap();
    }

    fn at(y: i32, m: u32, d: u32) -> DateTime<chrono::Utc> {
        Tz::UTC
            .with_ymd_and_hms(y, m, d, 12, 0, 0)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[sqlx::test]
    async fn select_completed_tasks_reads_only_what_was_completed_inside_the_window(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "inside", Some(at(2026, 3, 10)), None, None).await;
        insert_task(&pool, Uuid::new_v4(), "before", Some(at(2026, 2, 28)), None, None).await;
        insert_task(&pool, Uuid::new_v4(), "still open", None, None, None).await;

        let facts = select_completed_tasks(&pool, at(2026, 3, 1), at(2026, 4, 1))
            .await
            .unwrap();

        assert_eq!(facts, vec![fact("inside")]);
    }

    #[sqlx::test]
    async fn select_completed_tasks_excludes_a_deleted_task(pool: PgPool) {
        let id = Uuid::new_v4();
        insert_task(&pool, id, "deleted", Some(at(2026, 3, 10)), None, None).await;
        sqlx::query("update tasks set deleted_at = now() where id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        let facts = select_completed_tasks(&pool, at(2026, 3, 1), at(2026, 4, 1))
            .await
            .unwrap();

        assert!(facts.is_empty());
    }

    #[sqlx::test]
    async fn select_overdue_tasks_matches_on_date_or_deadline_falling_in_the_period(pool: PgPool) {
        insert_task(
            &pool,
            Uuid::new_v4(),
            "by date",
            None,
            Some("2026-03-15"),
            None,
        )
        .await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "by deadline",
            None,
            None,
            Some("2026-03-20"),
        )
        .await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "outside the period",
            None,
            Some("2026-04-01"),
            None,
        )
        .await;

        let start = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        let facts = select_overdue_tasks(&pool, start, end).await.unwrap();

        assert_eq!(
            facts,
            vec![
                overdue_fact("by date", (2026, 3, 15)),
                overdue_fact("by deadline", (2026, 3, 20)),
            ]
        );
    }

    /// A `date` carrying a time (`YYYY-MM-DDTHH:MM`, task-types.ts's own
    /// floating-time shape) must still compare correctly — this is
    /// `substring(date, 1, 10)::date` doing its job, not a coincidence of
    /// the fixture only ever using date-only strings elsewhere in this
    /// suite.
    #[sqlx::test]
    async fn select_overdue_tasks_reads_the_date_part_of_a_timed_date(pool: PgPool) {
        insert_task(
            &pool,
            Uuid::new_v4(),
            "timed",
            None,
            Some("2026-03-15T09:30"),
            None,
        )
        .await;

        let start = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        let facts = select_overdue_tasks(&pool, start, end).await.unwrap();

        assert_eq!(facts, vec![overdue_fact("timed", (2026, 3, 15))]);
    }

    #[sqlx::test]
    async fn select_overdue_tasks_excludes_a_completed_task_even_if_its_date_falls_in_the_period(
        pool: PgPool,
    ) {
        insert_task(
            &pool,
            Uuid::new_v4(),
            "done anyway",
            Some(at(2026, 3, 12)),
            Some("2026-03-15"),
            None,
        )
        .await;

        let start = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        let facts = select_overdue_tasks(&pool, start, end).await.unwrap();

        assert!(facts.is_empty());
    }

    /// Issue #175's own scoping decision, stated in `select_overdue_tasks`'s
    /// doc comment: a Task that was already overdue in an earlier Period
    /// and still hasn't been done does not appear again here — only a date
    /// or deadline actually falling inside *this* window counts, so the
    /// same Task is never repeated across every later Digest until it's
    /// finally completed.
    #[sqlx::test]
    async fn select_overdue_tasks_does_not_repeat_a_task_overdue_since_an_earlier_period(
        pool: PgPool,
    ) {
        insert_task(
            &pool,
            Uuid::new_v4(),
            "overdue since January",
            None,
            Some("2026-01-05"),
            None,
        )
        .await;

        let march_start = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let march_end = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        let facts = select_overdue_tasks(&pool, march_start, march_end)
            .await
            .unwrap();

        assert!(facts.is_empty());
    }

    #[sqlx::test]
    async fn select_digest_tasks_composes_both_queries_over_the_periods_own_bounds(pool: PgPool) {
        insert_task(&pool, Uuid::new_v4(), "finished it", Some(at(2026, 3, 10)), None, None).await;
        insert_task(
            &pool,
            Uuid::new_v4(),
            "still owed",
            None,
            Some("2026-03-20"),
            None,
        )
        .await;

        let from_utc = at(2026, 3, 1);
        let to_utc = at(2026, 4, 1);
        let tasks = select_digest_tasks(
            &pool,
            Period::Month,
            NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
            from_utc,
            to_utc,
        )
        .await
        .unwrap();

        assert_eq!(tasks.completed, vec![fact("finished it")]);
        assert_eq!(tasks.overdue, vec![overdue_fact("still owed", (2026, 3, 20))]);
    }
}
