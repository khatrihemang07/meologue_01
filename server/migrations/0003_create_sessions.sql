-- The durable container the Server holds for one Conversation (CONTEXT.md's
-- Session entry, docs/adr/0025). A row here is only ever written alongside
-- its first Turn, never on its own — see server/src/sessions.rs::record_turn
-- — so a Session can never exist holding an empty Conversation.
create table sessions (
  id          uuid        primary key,
  title       text        not null,             -- the first Question, truncated on a word boundary
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now() -- bumped whenever a Turn is appended
);

-- One Question/Answer pair inside a Session's Conversation (CONTEXT.md's
-- Conversation entry). Immutable once written, like an Entry — a Turn is
-- never edited, only appended.
create table session_turns (
  id                   uuid        primary key,
  session_id           uuid        not null references sessions(id) on delete cascade,
  seq                  bigserial   not null unique,   -- server order; mirrors entries.seq
  question             text        not null,
  answer               text        not null,
  grounding_entry_ids  uuid[]      not null,           -- the Entries the Answer was built from
  grounded             boolean     not null,           -- whether that Grounding actually answered the Question
  fallback_used        boolean     not null,           -- whether the disclosed fallback ran instead
  created_at           timestamptz not null default now()
);

-- The only access pattern a Session's Conversation needs: every Turn for
-- one Session, oldest first.
create index session_turns_session_id_seq on session_turns (session_id, seq);
