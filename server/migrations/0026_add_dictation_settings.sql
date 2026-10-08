-- Issue #455 / ADR 0091: dictation is handled at the Server, which proxies
-- to the OpenWhispr gateway. Same NULL semantics as every other column in
-- `server_settings` (migration 0018): NULL means "nothing stored, fall back
-- to the environment" (`MEOLOGUE_DICTATION_URL`, `MEOLOGUE_DICTATION_TOKEN`),
-- never "off". `dictation_enabled` is a tri-state toggle like the three
-- from migration 0018: NULL defers to "is a token resolved".
alter table server_settings
    add column dictation_base_url text,
    add column dictation_token    text,
    add column dictation_enabled  boolean;
