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

### Search

Narrowing History to the Entries whose text matches what you typed. Search reads Entry text, not
Entry times, and it narrows History in place rather than producing a separate collection.

### Send

The user's action of capturing a new Entry: writing text and committing it to their History.
Send is what the user does; the Entry is what results.

### Composer

The view where the user writes an Entry before Sending it. Composer names the view, not the
action performed in it — that's Send. Composer holds none of the user's captured Entries itself;
once Send commits what's written there, the result lives in History, not in Composer.

### Sync

The ongoing process by which Devices exchange Entries with each other, so that an Entry
captured on one Device eventually appears in the History on every other Device belonging to the
same user.

### Sync status

Whether this Device's Sync is off, working, or failing. Off is the default and reads as a
neutral state, not an error — it just means Sync is opt-in and no Server URL is set. Working and
failing describe an ongoing attempt against a configured Server.

### Export

A zip a Device produces on request, holding a plain-text file per day plus a lossless
`manifest.json`, so a user can read, back up, or move their History outside the app. An Export
always covers the whole History, never a Search — it is a backup, and a backup that quietly
omits things is worse than none.

### Cursor

A Device's record of how far it has Synced. A Cursor only ever advances — it marks the point up
to which a Device has already received every Entry there is to receive, so that Syncing again
only needs to ask for what came after.

### Server

The thing a Device Syncs through. Every Device exchanges Entries with the Server rather than with
other Devices directly.

### Reflection

Asking a question of your own History and getting an answer drawn from it. Reflection names the
view, the way Composer and History do — not the act of asking, which is a Question. Reflection
only ever reads Entries; it never creates one.

### Question

One thing the user asks during Reflection. A Question is not an Entry: it is never added to
History, never Synced, and it is not the user capturing a thought — it is the user interrogating
the thoughts they already captured.

### Answer

What Reflection gives back in response to a Question, drawn from the Grounding it found. An
Answer is not an Entry either — it is not the user's own words, and it never enters History.

### Conversation

The running sequence of Questions and Answers on one Device. Each Question is read in the light
of the Conversation before it, so a follow-up can lean on what was already asked without
repeating it. A Conversation belongs to the Device it happened on and does not Sync.

### Grounding

The Entries Reflection found relevant to a Question and used as the basis for its Answer.
Grounding always comes from the user's own History. An Answer with no Grounding behind it says
so plainly rather than filling the gap from somewhere else — a Reflection that invents a past
the user did not live is worse than one that admits it found nothing.

## Terms we avoid

### "message"

A message implies an addressee — someone or something it is sent *to*. An Entry has no
recipient; it is captured for the user's own History, not sent to anyone. Don't use "message"
for an Entry, even informally.

This holds inside Reflection too, where the pull is strongest: a Conversation is made of
Questions and Answers, never of messages. Every chat interface in the world calls them messages,
which is exactly why it is worth refusing here — a Question has no addressee either.

### "note"

A note implies something that can be edited, retitled, or organized into a document. An Entry
is immutable, untitled plain text — closer to a single fleeting thought than a document. Don't
use "note" for an Entry.

Unlike these two, Send and History are safe: they name the *action* and the *view*, not the
Entry itself, so they don't smuggle in the wrong properties.
