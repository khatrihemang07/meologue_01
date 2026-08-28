-- Issue #91: a Session's Conversation stops being one row per Question/Answer
-- pair and becomes an append-only tree of entries — the shape a harness
-- needs, where the model speaks, calls a tool, reads a result, and speaks
-- again, none of which fits "one pair." This is the expand half of an
-- expand-and-contract (server/src/sessions.rs's module comment, and this
-- migration's own header on `session_turns` from 0003): `session_turns`
-- stays, `record_turn` starts writing both shapes, and nothing here is
-- removed. Issue #99 is the contract half.
--
-- Ported from `earendil-works/pi`'s `packages/agent/src/harness/session/`,
-- where each Session is its own file and entry ids are stable across a
-- fork because nothing else needs to agree on them. Here every Session
-- shares one table, so `session_entries`' primary key is the *pair*
-- `(session_id, id)` — that's what lets a forked entry keep the same `id`
-- it had in the Session it was forked from while still living in a second
-- row, in a second Session, in the same table.
--
-- Every statement below is written to be safely re-runnable (`if not
-- exists`, a guarded `pg_constraint` check) even though a real Postgres
-- only ever applies this file once — sqlx's migration tracking table
-- guarantees that on its own. The point of the idempotence is
-- `server/tests/sessions.rs`, which proves the backfill below transforms
-- real `session_turns` rows correctly by literally re-executing this
-- file's text (`sqlx::raw_sql` over `include_str!`) against a database
-- that already has this migration applied and now also has seeded
-- "pre-#91" turns in it — the same SQL a real upgrade runs, not a
-- reimplementation of it that could drift from what actually ships.

-- One node in a Session's tree (CONTEXT.md's Session and Conversation
-- entries; "Entry" there means something else — a captured piece of
-- History — so this migration and `sessions.rs` say "entry" only for this
-- table's rows, never "Entry"). `parent_id` is the entry this one was
-- appended after; a root entry (the first thing ever said in a Session)
-- has `parent_id is null`. Reading a Conversation means walking from a
-- leaf back to a root through `parent_id` and reversing — `sessions.rs`'s
-- `walk_to_root` — never a `select ... order by seq`, because `seq` alone
-- can't tell a live lane from an abandoned fork once forking exists.
--
-- `type` is one of `message | model_change | compaction | branch_summary |
-- custom`, matching pi's own entry kinds minus the ones this ticket has no
-- use for yet. The type-specific shape lives in `payload` rather than in
-- more columns, because a `session_entries` row that had to carry a column
-- for every entry kind's own fields would grow a new nullable column every
-- time a new kind is added — jsonb keeps that growth off the schema. A
-- `message` payload always carries `role: "user" | "assistant" |
-- "tool_result"` plus that role's own fields.
--
-- The self-referential foreign key is `deferrable initially deferred`
-- because the backfill below inserts an entire Session's chain of entries
-- in ordinary seq order within one statement — the first entry a later row
-- points at as its `parent_id` may not exist yet at the instant Postgres
-- would otherwise check an immediate constraint. Deferring the check to
-- commit costs nothing for the ordinary one-entry-at-a-time append
-- `record_turn` does (its parent already exists, committed by an earlier
-- transaction) and is what makes the multi-row backfill possible at all
-- without a second, careful insertion order.
create table if not exists session_entries (
  session_id  uuid        not null references sessions(id) on delete cascade,
  id          uuid        not null,
  parent_id   uuid,
  seq         bigint      not null,
  type        text        not null check (type in ('message', 'model_change', 'compaction', 'branch_summary', 'custom')),
  payload     jsonb       not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, id),
  foreign key (session_id, parent_id) references session_entries (session_id, id) deferrable initially deferred,
  unique (session_id, seq)
);

-- The only access pattern a tree read needs: every entry for one Session,
-- so `sessions.rs::load_entries` can pull the whole thing in one query and
-- walk `parent_id` in memory rather than one round trip per hop.
create index if not exists session_entries_session_id_idx on session_entries (session_id);

-- The Server's own operation log (issue #91's "alongside the tree, a
-- separate operation log records what the Server was *doing*"): which run
-- started, which tool began, which result landed. Not a tree — no
-- `parent_id` — because a log entry doesn't have a "before it", it has a
-- time it happened, which `seq` (shared with `session_entries`, see
-- `sessions.next_seq` below) already orders. `kind` is one of
-- `operation_started | operation_finished | step_attempt | tool_started |
-- abort_requested | usage`.
--
-- This ticket writes and reads this table as an audit trail only. The
-- property that makes it useful for more than that later — a future
-- ticket's resume path, not this one's job to build — is that a record's
-- `id` is minted *before* the work it describes starts, so after a crash
-- the question "did this tool's result ever land?" is answered by checking
-- whether a `session_entries` row with that same id exists (a `tool_result`
-- message entry, written only once the result actually arrived) rather
-- than by any state this table itself would need to track.
create table if not exists session_records (
  session_id  uuid        not null references sessions(id) on delete cascade,
  id          uuid        not null,
  seq         bigint      not null,
  kind        text        not null check (kind in ('operation_started', 'operation_finished', 'step_attempt', 'tool_started', 'abort_requested', 'usage')),
  payload     jsonb       not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, id),
  unique (session_id, seq)
);

create index if not exists session_records_session_id_idx on session_records (session_id);

-- `main_leaf_id` is the single implicit lane this ticket supports —
-- deliberately not pi's named lanes, which this port has no client for yet.
-- It is the entry `record_turn` (and, later, the harness) appends after;
-- `null` means "nothing has been said in this Session yet," which can only
-- be true for the instant between `insert into sessions` and the first
-- `insert into session_entries` inside the same transaction — `sessions.rs`
-- never commits a Session in that state (mirroring 0003's original "a
-- Session can never exist holding an empty Conversation").
--
-- `next_seq` is the next value `sessions.rs::allocate_seq` will hand out,
-- shared by `session_entries` and `session_records` alike — issue #91 is
-- explicit that the two logs share *one* strictly consecutive per-Session
-- ordering, because a harness reducer that replays "what happened, in
-- order" needs a single timeline across both, not two timelines it has to
-- interleave itself by `created_at` (which, unlike `seq`, is never
-- guaranteed to strictly increase — two writes in the same millisecond are
-- possible, a gap in `seq` isn't). Allocated with `update ... set next_seq
-- = next_seq + 1 ... returning next_seq - 1`, so the row lock Postgres
-- already takes for that update is what serializes concurrent appends to
-- the same Session — no separate advisory lock needed.
alter table sessions add column if not exists main_leaf_id uuid;
alter table sessions add column if not exists next_seq bigint not null default 1;

-- Guarded rather than a bare `add constraint`, because Postgres has no
-- `add constraint if not exists` for a foreign key (unlike `add column`
-- above) — see this file's own header for why this migration is written to
-- tolerate being re-run at all. The pair `(id, main_leaf_id)` referencing
-- `session_entries(session_id, id)` is what makes an inconsistent leaf —
-- one pointing at another Session's entry — a constraint violation instead
-- of a bug some future query has to trust never happens.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_main_leaf_id_fkey'
  ) then
    alter table sessions
      add constraint sessions_main_leaf_id_fkey
      foreign key (id, main_leaf_id) references session_entries (session_id, id);
  end if;
end
$$;

-- The backfill: every existing `session_turns` row becomes two chained
-- `message` entries — `user` then `assistant` — so a Session that predates
-- this migration reads exactly the same through the tree as it did through
-- `session_turns` directly (issue #91: "each stored pair becomes two
-- entries, chained, so old Conversations open and read correctly and
-- simply have no tool steps in them, because they never had any").
--
-- `turn_entry_ids` is materialized once so the two ids each Turn needs
-- (one for the `user` entry, one for the `assistant` entry) are generated
-- exactly once and reused by every statement below that needs them —
-- referencing `gen_random_uuid()` directly from more than one statement
-- would mint a different id each time it's evaluated. `rn` numbers each
-- Session's Turns in the order they were actually asked (`session_turns
-- .seq`, 0003's own server-assigned order), which both gives each entry
-- its new `seq` (`(rn-1)*2 + 1` for the question, `+2` for the answer) and
-- lets `lag()` find the previous Turn's `assistant` entry to chain this
-- Turn's `user` entry onto — the same "previous entry in this Session" a
-- live `record_turn` reads from `sessions.main_leaf_id` before appending.
create temporary table turn_entry_ids as
select
  t.session_id,
  t.question,
  t.answer,
  t.grounding_entry_ids,
  t.grounded,
  t.fallback_used,
  t.created_at,
  row_number() over (partition by t.session_id order by t.seq asc) as rn,
  gen_random_uuid() as user_entry_id,
  gen_random_uuid() as assistant_entry_id
from session_turns t;

insert into session_entries (session_id, id, parent_id, seq, type, payload, created_at)
select
  session_id,
  user_entry_id,
  lag(assistant_entry_id) over (partition by session_id order by rn),
  (rn - 1) * 2 + 1,
  'message',
  jsonb_build_object('role', 'user', 'text', question),
  created_at
from turn_entry_ids;

-- The `assistant` entry's payload carries the same Grounding fields
-- `session_turns` always has — `grounding_entry_ids`, `grounded`,
-- `fallback_used` — so `sessions.rs::entries_to_turns` can rebuild an
-- identical `SessionTurnRow` from the tree alone, with nothing left behind
-- in `session_turns` that the tree doesn't also carry.
insert into session_entries (session_id, id, parent_id, seq, type, payload, created_at)
select
  session_id,
  assistant_entry_id,
  user_entry_id,
  (rn - 1) * 2 + 2,
  'message',
  jsonb_build_object(
    'role', 'assistant',
    'text', answer,
    'grounding_entry_ids', to_jsonb(grounding_entry_ids),
    'grounded', grounded,
    'fallback_used', fallback_used
  ),
  created_at
from turn_entry_ids;

-- Every migrated Session's `main_leaf_id` becomes its last Turn's
-- `assistant` entry (`rn desc` picks it per Session) and `next_seq`
-- continues right after the last seq this backfill assigned it — a Session
-- with existing Turns that then receives a new Question through
-- `record_turn` must append onto this chain, not start a second one from
-- `parent_id is null`.
update sessions s
set main_leaf_id = last_turn.assistant_entry_id,
    next_seq = last_turn.rn * 2 + 1
from (
  select distinct on (session_id) session_id, assistant_entry_id, rn
  from turn_entry_ids
  order by session_id, rn desc
) as last_turn
where s.id = last_turn.session_id;

drop table turn_entry_ids;
