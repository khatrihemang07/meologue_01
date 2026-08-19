create extension if not exists vector;

-- 640 dimensions matches the configured embedding model (Ollama, harrier-270m,
-- verified L2-normalised). `embedding_model` is stored alongside every vector
-- (never inferred from config) so a future model swap is detectable per row
-- rather than assumed uniform across the table — see ADR 0022.
alter table entries
  add column embedding       vector(640),
  add column embedding_model text;

-- The durable work queue for the embedding worker (ADR 0022): "needs an
-- embedding" is exactly "embedding is null", so this partial index is the
-- queue's only index, not a hint alongside a separate table. No ANN/HNSW
-- index is added here — at this table's size (tens to low thousands of
-- Entries) an exact scan over `<=>` is fast enough, and building an
-- approximate index now would be optimizing for scale nobody has yet (the
-- same call ADR-0014 made for entries_fts over FTS5's prefix index).
create index entries_unembedded on entries (id) where embedding is null;
