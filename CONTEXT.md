# Meologue — glossary

Meologue is a personal, local-first log: a place to capture short pieces of text as they occur
to you, on whichever device you have in hand, and have them show up on your other devices too.

This glossary defines the vocabulary of that domain. It is a glossary and nothing else — no
implementation detail, no spec. When code, tickets, or discussion need a name for one of these
concepts, use the term below rather than a synonym.

## Terms

### Entry

A single piece of plain text captured by the user. An Entry is immutable once created — it can
never be edited or retitled after the fact. It is identified by an id minted on the Device that
created it, so an Entry's identity does not depend on ever reaching another Device or a server.

### Device

A single instance of the application running somewhere the user captures Entries — a phone, a
laptop, a browser tab. Each Device mints its own Entry ids and keeps its own local copy of the
Entries it knows about.

### History

The full, ordered collection of a user's Entries, as seen from a given Device. Two Devices may
show slightly different Histories at any given moment if one hasn't finished Syncing, but they
converge once Syncing completes.

### Send

The user's action of capturing a new Entry: writing text and committing it to their History.
Send is what the user does; the Entry is what results.

### Sync

The ongoing process by which Devices exchange Entries with each other, so that an Entry
captured on one Device eventually appears in the History on every other Device belonging to the
same user.

### Cursor

A Device's record of how far it has Synced. A Cursor only ever advances — it marks the point up
to which a Device has already received every Entry there is to receive, so that Syncing again
only needs to ask for what came after.

### Server

The thing a Device Syncs through. Every Device exchanges Entries with the Server rather than with
other Devices directly.

## Terms we avoid

### "message"

A message implies an addressee — someone or something it is sent *to*. An Entry has no
recipient; it is captured for the user's own History, not sent to anyone. Don't use "message"
for an Entry, even informally.

### "note"

A note implies something that can be edited, retitled, or organized into a document. An Entry
is immutable, untitled plain text — closer to a single fleeting thought than a document. Don't
use "note" for an Entry.

Unlike these two, Send and History are safe: they name the *action* and the *view*, not the
Entry itself, so they don't smuggle in the wrong properties.
