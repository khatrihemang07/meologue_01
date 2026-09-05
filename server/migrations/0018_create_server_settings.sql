-- Issue #200: a Server holds settings of its own, layered over the
-- environment (ADR 0059, ADR 0062). One row for this Server's whole
-- lifetime — `id` is pinned to 1 by the check constraint below, so a second
-- `insert` can never create a second row; every write is an upsert against
-- the same id instead.
--
-- Every column is nullable, and NULL carries one meaning everywhere in this
-- table: "nothing stored here, fall back to the environment" — never "off".
-- That is a deliberate departure from ADR 0011/0021's "empty means off"
-- convention, and it is why the three feature-toggle columns below are
-- booleans rather than folded into the string columns somehow: `NULL`,
-- `true` and `false` are three real, distinct states for a toggle, and a
-- column type that cannot hold a fourth is cheaper than a check constraint
-- that has to refuse one.
create table server_settings (
    id                 integer primary key default 1 check (id = 1),

    -- The six chat/embed variables `llm::LlmConfig::from_env` already reads,
    -- mirrored here as the overlay that wins when set. See `settings::resolve`.
    chat_base_url      text,
    chat_model         text,
    chat_api_key       text,
    embed_base_url     text,
    embed_model        text,
    embed_api_key      text,

    -- Mirrors `MEOLOGUE_TZ` (`period::parse_timezone`) the same way.
    tz                 text,

    -- Issue #201's tri-state feature toggles, added here (not in a later
    -- migration) because the single-row shape is this ticket's decision —
    -- the follow-up ticket only gives these columns behaviour. NULL means
    -- "unset": defer to whatever the resolved chat/embed configuration
    -- would otherwise make available. `true`/`false` force the feature on
    -- or off regardless of what is configured.
    reflect_enabled    boolean,
    digest_enabled     boolean,
    embeddings_enabled boolean
);

-- The exact predicate the embedding worker's scan already uses
-- (`embedding::select_unembedded`: "embedding is null and deleted_at is
-- null") — added here rather than widening migration 0002's
-- `entries_unembedded` (which only covers "embedding is null") so that both
-- that scan and `GET /v1/config`'s "Entries not yet embedded" count can be
-- served by one index whose condition matches their query exactly, not one
-- that merely implies it.
create index entries_unembedded_active on entries (id)
    where embedding is null and deleted_at is null;
