# 0002: The sync Cursor is a server-assigned sequence, serialised by an advisory lock

## Status

Accepted

## Context

A Device's Cursor marks how far it has Synced, so that Syncing again only needs to ask for
Entries after that point. For this to be safe, "after that point" has to mean the same thing to
every Device: once a Device has advanced its Cursor past a given point, no Entry can later
appear that belongs before it. Entries arrive from multiple Devices, possibly concurrently, so
the ordering the Cursor relies on has to be assigned centrally rather than derived from
per-Device clocks.

If ordering is assigned at write time but rows only become visible to readers at commit,
concurrent writes can commit out of the order their sequence numbers were assigned in. A Device
polling in that window can advance its Cursor past a sequence number whose row hasn't committed
yet — and never see that Entry, because the next poll only asks for what comes after the
Cursor. For a personal log, that's a silently and permanently lost Entry.

## Decision

The Cursor is a sequence number assigned by the server, not by any Device. Concurrent inserts
are serialised with an advisory lock around the sequence assignment and commit, so that commit
order is always equal to sequence order — a Cursor value is only ever handed out once every
Entry at or before it has actually committed.

## Alternatives considered

- **Order Entries by the capturing Device's local clock (`created_at`).** Rejected: device
  clocks aren't synchronised or monotonic across restarts, and a clock-based Cursor can't
  guarantee "everything up to this point has arrived" the way a centrally assigned sequence can.
  (Device clock time is still kept, but only to drive display order within History — not as the
  sync mechanism.)
- **Assign sequence numbers without serialising commit order, and accept occasional gaps.**
  Rejected: a gap is exactly the failure mode that loses an Entry for a polling Device — the
  cost of getting this wrong is permanent data loss for something the user thought they'd saved.
- **Have each Device generate a globally unique, orderable id (e.g. by embedding a device id and
  timestamp) instead of a server-assigned sequence.** Rejected: this still doesn't give a
  Device polling for "everything after X" a hard guarantee that nothing earlier is still in
  flight — it trades the central ordering authority for a harder-to-reason-about invariant.

## Consequences

Sequence assignment is a serialisation point for writes; every Device's understanding of "what
has Synced" is defined relative to it. The advisory lock is small and easy to remove by someone
who doesn't understand why it's there — it is not deleted without re-deriving this reasoning.
