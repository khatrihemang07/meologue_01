# 0068: A pull does not overwrite an unpushed local change

## Status

Accepted. **Narrows one write path ADR 0028 left unguarded**, without reopening its conflict rule.
Takes up the invitation ADR 0065 left behind in its own Consequences: "whoever next revisits Sync's
conflict rule should know this column is already there and already correct on both sides of the
wire."

## Context

`EntryStore.upsert` writes every column from the row it is handed, whatever the local row currently
says. Sync used it for both arms of a response: the acknowledged rows (ADR 0059) and the
Cursor-read rows. For the acknowledged arm that is exactly right — this Device asked for that
write. For the Cursor-read arm it loses data.

A pull can arrive while a local change is still waiting to be pushed. `upsert` overwrites the body
*and* stamps the Server's `seq`, so the row also stops looking pending. `pending()` is `seq IS
NULL`, so nothing re-pushes it. The local change is gone with no error, no conflict, and nothing
anywhere that records it ever existed.

Three things make this more than theoretical.

**Store-open rewrites sit exactly in the window.** ADR 0053's Task backfill and ADR 0067's
soft-break pass both rewrite Entry bodies the moment the store opens, which is also when the
session's first Sync runs. The rewrite lands after `pending()` was read and before the response is
applied — so the push that went out did not carry it, and the pull that comes back erases it.

**Restore makes the window as wide as it can be.** `resetCursorsAndEpochs` (ADR 0064) deliberately
sets every Cursor back to 0 so a restored Device reconciles against the Server honestly rather than
inheriting the Backup's Device's Sync position. That reset is load-bearing and this ADR does not
touch it — but its consequence is that the very next pull is the entire History at once, the
largest possible surface for this to happen on. Merge has the same window, narrower, because it
preserves `seq`/`synced_at` for rows it did not touch.

**It was observed, not reasoned about.** Three e2e runs at load ~4 failed this way while #214 was
being built, and stayed failing with the timeout budget raised to 45s, which is what ruled out a
slow machine and pointed at `upsert()`.

The underlying mistake is treating "a row arrived over the wire" as one operation. An
acknowledgement and a pull are two different questions — *did the write I asked for land?* versus
*what else has happened?* — and only one of them is entitled to overwrite whatever it finds.

## Decision

**Sync's pull gets its own write path, `EntryStore.applyPulled`.** `upsert()` keeps its wholesale
semantics unchanged and keeps its existing callers: a local capture, and Sync's acknowledgement
arm. The Cursor-read arm moves to `applyPulled`.

**An incoming row is applied unless the local row is pending and strictly newer.** Three clauses:

- *Pending* is `seq IS NULL` — the same "the Server has not acknowledged this yet" signal `edit()`,
  `remove()` and `pending()` already share. A row the Server has acknowledged has nothing local
  left to lose and is overwritten exactly as before.
- *Strictly newer* compares `updated_at`, **normalised to milliseconds on both sides, because the
  two sides do not write it in the same shape.** This client stamps it with
  `new Date().toISOString()`, which always emits exactly three fractional digits. The Server
  serialises `DateTime<Utc>` through chrono's default, which emits as many digits as it needs —
  six in practice, and none at all when the nanoseconds are zero. A byte-wise comparison of two
  such strings is not chronological order, and it fails in *both* directions: `'0' < 'Z'` makes
  the Server's `...02.500000Z` compare smaller than a local `...02.500Z` at the same instant, and
  `'Z' > '.'` makes an older `...02Z` compare greater than a newer `...02.500Z`. The second of
  those is this ADR's own bug, arriving through the guard instead of around it. Both sides go
  through `strftime('%Y-%m-%dT%H:%M:%f', …)` first. It was caught in review, against real rows: a
  Device's database holds 137 Server-written 6-digit timestamps beside 4 locally-written 3-digit
  ones.
- **A tie applies rather than refuses.** The incoming row has been through the Server and this
  Device's has not, so on a genuine tie the Server's copy is the better default; and normalising
  to milliseconds turns every sub-millisecond difference into a tie, where applying is the
  direction that cannot strand a row. This is *not* what rescues this Device's own row coming back
  with a `seq` on it — `sync-engine.ts` applies `acknowledged_entries` before the Cursor-read arm,
  so such a row already has a `seq` and is taken by the first clause. That belongs to the
  acknowledgement path.
- *Unless the incoming row is a tombstone.* Deletion is terminal in both directions (ADR 0064), so
  a tombstone lands over a newer local edit — the mirror of `edit()`'s own `WHERE deleted_at IS
  NULL` guard refusing to resurrect one.

**It is a `setWhere` on the same single upsert statement, not a read-then-decide.** Reading the row
first and choosing in TypeScript would put an `await` between the read and the write — precisely
the interleaving this exists to close. ADR 0007's one-statement property survives for the reason it
was worth having.

**The FTS index is re-derived from the row that survived**, via the existing
`reindexFromCurrentState`, not from the row that was handed over. Indexing the incoming body would
make Search the one place a refused edit still appeared to have landed. `edit()` and `remove()`
already choose this over indexing what the caller assumed it wrote, for the same reason.

**ADR 0028's conflict rule is untouched.** Last-writer-wins by Server arrival still decides every
conflict the Server ever sees. A change that has not been pushed has not entered that ordering at
all; refusing to discard it is what lets it get there. A genuinely newer row from another Device
still wins, exactly as before.

## Alternatives considered

- **Guard inside `upsert()` itself, covering both arms.** Rejected, and this is the one worth
  recording. ADR 0065 documents a tolerated divergence: an edit that lands on identical content
  leaves the Server holding an *older* `updated_at` than the Device, because the Server's `is
  distinct from` guard never fired. An `updated_at` guard on the acknowledgement arm would refuse
  that acknowledgement forever, the row would never clear pending, and it would re-push on every
  tick — trading silent data loss for a silent infinite loop.
- **Fix it in Restore, by not resetting the Cursors.** Rejected. The reset is deliberate and its
  removal reintroduces a different bug — a restored Device inheriting a Sync position that was
  never its own. It would also leave Merge exposed, which has the same window without the reset.
- **Compare content instead of `updated_at`.** Rejected: it cannot tell "unchanged" from "changed
  and changed back", and it says nothing about which side is newer.
- **Conflict copies.** Already rejected by name in ADR 0028; nothing here reopens it.
- **A dedicated pending-edit token column.** Would be exact, and clock-free. Rejected as
  disproportionate: it is a schema migration plus a Cursor reset (ADR 0057) to improve on a field
  ADR 0065 already put on the wire for exactly this class of question.

## Consequences

**Merge compares the same field the same wrong way, and this ADR does not fix it.** `merge.ts`'s
case 6 does a plain string `>` on `updated_at` and states the assumption in a comment — "Both are
ISO 8601 strings of identical shape ... so a plain string comparison orders them correctly." The
rows above show they are not of identical shape. It is pre-existing, it is the same root cause,
and it is filed as issue #217 rather than folded in here. **`updated_at` should not be compared as a raw string
anywhere in this codebase**; that is the general lesson, and this ADR only closes the one call
site it owns.

**Clock skew can still lose an edit, and that is inherited, not introduced.** A Device with a fast
clock wins a collision. ADR 0065 accepted this knowingly when it made `updated_at` the
discriminator, bounded by deletion being terminal — a skewed clock can win an edit but cannot
resurrect a deleted row. The same bound applies here.

**The acknowledgement arm keeps a narrower version of the same race**, filed as issue #216 rather
than fixed. Push edit v1; the user makes edit v2 before the response lands; the acknowledgement for
v1 overwrites v2 and clears its pending mark. It needs a different mechanism — comparing the
acknowledged row against *what this Device actually pushed*, which only the engine knows — and
folding that in here would have buried a second Sync change inside the fix for the first.

**Only Entries are covered.** Tasks, Projects, Sections, Labels, Comments and Events keep the
unguarded `upsert()` on both arms. Entry is where the exposure was observed and where the
store-open rewrites actually write; extending the rule is a mechanical follow-up (issue #218), not a redesign,
and doing it without a demonstrated failure would be six speculative changes to Sync at once.

**`upsert()` is now the narrower door, and its name no longer says so.** It is Sync's
acknowledgement path and local capture; the pull has its own. The doc comments on both say which is
which, because the names alone do not.
