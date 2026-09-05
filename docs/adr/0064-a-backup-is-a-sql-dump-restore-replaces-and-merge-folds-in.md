# 0064: A Backup is a SQL dump; Restore replaces, Merge folds in

## Status

Accepted. **Supersedes ADR 0008's** consequence that Device settings must not travel with a data
restore — they now do, with one carve-out. Sits beside ADR 0016's Export rather than replacing it.

## Context

Meologue could get data out and had never been able to get it back in. ADR 0016 deferred import
explicitly, and no issue was ever opened for it.

Worse, the Export had drifted. `exportEntriesToZip(entries, tasks, projects, …)` covered Entries,
Tasks and Projects-as-headings. **Labels, Sections, Comments, Events and Filters** all had stores,
tables and `CONTEXT.md` entries, and appeared in no export at all — seven stores hung off
`OpenedSqliteStore` and the export knew about three. A user who lost a Device would have discovered
that at the worst possible moment.

## Decision

**A Backup is a separate artifact from an Export, and both stay.** An Export answers "can I read
this"; a Backup answers "is my data safe". ADR 0016 rejected a JSON-only export because those are
different questions — that reasoning still holds, so the answer is two artifacts, each good at one
thing, rather than one mediocre at both.

**A Backup is a zip of `database.sql`, `settings.json` and `meta.json`.** The SQL is a real dump —
`unzip && sqlite3 new.db < database.sql` reproduces the log, which is the "open door" this format
was chosen for. Tables are discovered from `sqlite_master` rather than named, so a column or table
a later migration adds is carried without this code being told; the FTS5 virtual tables and their
shadow tables are excluded, because they are derived and a dumped shadow table reimports as a
corrupt index. Tombstones travel.

**Import validates structure and trusts data.** `database.sql` is never handed to `execute()`.
It is parsed, checked against the schema this build knows, and re-inserted through parameterized
statements. Version skew is best-effort: a table or column this build does not know is skipped and
reported, not a reason to refuse the whole file.

**Restore replaces; Merge folds in.** Two verbs, because they differ in the one thing a reader
actually wants to know — what happens to rows the incoming file does not mention.

Restore keeps this Device's `device_id` (adopting the Backup's would make two physical Devices push
under one identity), resets every Cursor and row-shape epoch to 0 (a restored Cursor describes the
*source* Device's position and would make this Device skip rows it has never seen), preserves each
row's `seq`/`synced_at` from the file (blanking them would re-push the entire database, reassign
every row's `seq`, and force every other Device to re-download its whole history), rebuilds the
FTS5 indexes eagerly before reporting done, and skips rows already byte-identical.

Merge keeps what the Device already has. Greater `updated_at` (ADR 0065) wins, equal does nothing,
identical content is skipped whatever the timestamps say, and only rows it actually inserted or
overwrote are marked pending. **Deletion is terminal in both directions** — an incoming tombstone
overwrites a live row ahead of any timestamp comparison, and an existing tombstone can never be
undone by an incoming row. That second half is what bounds the deliberate absence of a clock-skew
guard: a fast-clocked Device can win an edit, but it cannot resurrect something you deleted.

**Settings travel with a Restore, overturning ADR 0008 — except the Server URL.** A Device restored
without its theme, accent, text size and hidden destinations is not the Device that was backed up.
The Server URL is the exception because ADR 0011 makes an unreachable one mean "Sync is off",
*silently*: restoring a laptop's Backup onto a phone would point it at a host it cannot route to
and nothing would say so. It is shown and accepted-or-kept, never applied blind. Merge applies no
settings at all — merging two Devices' themes is meaningless.

**The Server gets its own backup and restore**, over `pg_dump`/`pg_restore` against the connection
string it already holds — not `docker exec`, which would hardcode "Postgres is in that container"
and break for a Sandbox, a rename, or a managed database, and would need the Docker socket. It
carries Sessions, Digests and embeddings that no Device holds. `entries.embedding_model` already
existed per row, so the model travels with the row and a restore reports how many rows disagree
with the configured model, offering rebuild or leave.

**Both Server endpoints are unauthenticated**, per ADR 0003's network-level trust. This was decided
knowingly after review: `POST /v1/restore` is a network-reachable wipe-and-replace whose only
perimeter is the network itself (ADR 0017). Recorded here as a decision, not an oversight.

## Alternatives considered

- **One Import with two modes instead of Restore and Merge.** Rejected: the difference is exactly
  what a reader needs to know before acting, and one word would hide it.
- **Raw `.db` file instead of a SQL dump.** Exact and cheap, but `SqliteDriver` cannot reach it —
  web's database is an OPFS file behind a worker, macOS's behind the Tauri SQL plugin, Android's
  behind Capacitor. Three new platform implementations, plus closing and reopening the database
  around a restore, to lose the open door.
- **Refuse a Backup whose schema this build doesn't know.** Rejected: it makes a six-month-old
  Backup worthless, which is most of the point of having one.
- **Merge by Sync's `seq`.** Rejected: `seq` is Server-assigned, and ADR 0011 makes Sync opt-in, so
  every row is `NULL` on both sides for the server-less user — precisely the person for whom Merge
  has to work.
- **A per-row conflict review screen.** Rejected: for a Device that has never synced, every colliding
  row lands there. That is not a review, it is a wall.

## Consequences

The Settings route's gzip budget was the binding constraint, not correctness. Importing the backup
machinery eagerly put it 61% over ceiling; the fix is a lazy `import()` inside the click handlers.
A second, less obvious cost surfaced the same way — statically importing the confirm dialog pulled
Radix's `Dialog` primitive into Settings for the first time (~11,800 gzip bytes), so that is lazy
too. Anyone adding to this section should expect the budget to be what pushes back first.

`BEGIN`/`COMMIT`/`ROLLBACK` around Restore is a real guarantee on a single-connection driver and
**not** on macOS: `@tauri-apps/plugin-sql` pools connections with no transaction API, so `BEGIN`
and the next statement may not reach the same connection (the same reason `migrate()` makes each
statement idempotent instead). Issue #204 answers the resulting gap the way this ADR already
anticipated above, not by chasing a transaction the driver cannot give: **Restore now takes and
durably saves a safety Backup of the Device's own current contents before it writes anything at
all**, and refuses to write anything — returns a failure, `BEGIN` never called — if that safety
Backup can't be produced. This mitigates the gap; it does not close it. macOS's pooled driver is
exactly as non-transactional after issue #204 as before it — an apply interrupted partway there can
still leave rows from the old database and the new one side by side. What changes is that this is
no longer unrecoverable: a faithful copy of the pre-Restore database now always exists, durably
saved, before that partial state could ever be written, and a Restore that then fails names the
safety Backup's own file name in the error it surfaces, so "your data is safe, here's where" is
never left implicit. Narrowing macOS's transaction gap itself — the `migrate()`-style,
per-statement-idempotent rewrite this ADR's own Context section already judged too large for
Restore's scope — remains open.

`pg_dump`/`pg_restore` on the host is now a prerequisite for the Server's own backup, documented in
the server README. There is no server Dockerfile — the Rust server runs on the host — so this is a
real install step, and a missing binary reports what to install rather than failing opaquely.
