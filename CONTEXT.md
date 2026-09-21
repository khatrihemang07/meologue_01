# Meologue — glossary

Meologue is a personal, local-first log: a place to capture short pieces of text as they occur
to you, on whichever device you have in hand, and have them show up on your other devices too.

This glossary defines the vocabulary of that domain. It is a glossary and nothing else — no
implementation detail, no spec. When code, tickets, or discussion need a name for one of these
concepts, use the term below rather than a synonym.

## Terms

### Entry

A single piece of text captured by the user. Its body is Markdown: reading it picks out light
emphasis, lists and checkboxes, and References to a day or to another Entry. An Entry stays
untitled — it has no heading and no name, and nothing about capturing one asks the user to file it
anywhere — but it may carry structure inside itself. A thought is often a list of things, and
refusing lists did not keep Entries short, it only made them worse.

A checkbox line in an Entry's body may also hold a task reference: it points at a Task rather
than standing alone. What appears there — the wording, and whether it reads as done — is a cache
written from the Task, never a fact the Entry holds in its own right. The Task owns its text and
its completion; ticking the checkbox is something a reader does to the Task, and the Entry's own
characters simply follow along afterward.

What the user typed is what is stored, until the user edits it. Editing rewrites the body from the
document the Composer was showing, and that normalizes formatting — one way of writing emphasis
can come back as another. The characters change; what the Entry says does not. An Entry that is
never edited keeps the exact characters it was captured with, with one deliberate, bounded
exception: the backfill that turned every checkbox already in History into a Task (ADR 0053) once
rewrote a checkbox line into a task reference the first time this app modelled a checkbox as a Task
at all. It runs at most once per Entry, never as an ordinary consequence of Syncing or of opening
the app on an Entry it has already reached.

Writing written before a Block break and a Soft break were told apart is not rewritten to catch up.
It is read the way its author meant it instead, permanently — a restored Backup can reintroduce that
older writing at any time, so understanding it is not a phase this app passes through.

It is identified by an id minted on the Device that created it, so an Entry's identity does not
depend on ever reaching another Device or a server. Its body can change after the fact, and an
Entry can be removed from History altogether. What never changes is its identity and when it was
captured: editing an Entry does not move it in History, no matter how long ago it was captured or
how recently it was last edited.

### Block break

The end of one block of an Entry's body and the start of the next — what pressing Enter leaves
behind. It reads as one new line, no more: a block sits directly against its neighbour and
contributes no gap of its own, so a person who pressed Enter once sees one new line and not a blank
one. Pressing Enter twice is how a blank line gets asked for.

### Soft break

A new line *within* one block, which leaves that block whole — what pressing Shift+Enter leaves
behind. The distinction from a Block break is not cosmetic: a list item broken by a Soft break is
still one item, where a Block break there would have started the next one. This is the difference a
person is reaching for when they want a second line of the same thought rather than a second
thought.

A deliberately blank line does not currently survive being Sent and read back. That is a known gap,
not a decision.

### Device

A single instance of the application running somewhere the user captures Entries — a phone, a
laptop, a browser tab. Each Device mints its own Entry ids and keeps its own local copy of the
Entries it knows about.

### History

The full, ordered collection of a user's Entries, as seen from a given Device. Two Devices may
show slightly different Histories at any given moment if one hasn't finished Syncing, but they
converge once Syncing completes.

Each day in History opens with that day's Day block, listing whatever Tasks are dated
then. The block is rendered alongside the day's Entries, not held as part of History
itself — it reflects Tasks that live elsewhere, and moving one from day to day moves it between
blocks without touching any Entry that mentions it.

### Search

Narrowing a collection to the items whose text matches what you typed. One concept, three
instances — Entries in the Composer, Sessions whose Conversation matches in Reflection, and Tasks
in Todo — each its own instance over its own collection, not one Search extended to reach a
second. Search reads text, not time, and each instance narrows its own collection in place rather
than producing a separate one. Narrowing one collection never reaches into another: Todo's Search
finds a Task by its title, its Description, or a Comment made against it, and nothing it finds
ever comes from an Entry or a Session, the same boundary that keeps the Composer's own Search from
ever reaching into Todo.

### Reference

Something written inside an Entry that points at a day, or at another Entry. A Reference is text
the user wrote rather than a property of the Entry: it lives in the body, and an Entry that Refers
to something is in every other respect an ordinary Entry.

Referring is not belonging. An Entry that Refers to yesterday was still captured today, and stays
exactly where it was captured in History — nothing about a Reference moves an Entry, backdates it,
or changes what a Period contains.

A day can also be asked what Refers to it, so a thought captured late is reachable from the day it
was about as well as from the day it was written. A Reference that points at nothing this Device
can find — a day holding no Entries, an Entry that was removed or has not Synced here yet — is
simply the words the user typed, and leads nowhere.

### Send

The user's action of capturing a new Entry: writing text and committing it to their History.
Send is what the user does; the Entry is what results.

### Destination

One of the app's top-level views, reachable directly by its own URL and listed as a row on the
root screen: Composer, Reflection, Digest, Todo, Time, and Settings (ADR 0036, ADR 0049, ADR 0090). Settings is a
Destination like the others even though it configures the app rather than showing Entries.

Back leaves a Destination and returns to the root screen (ADR 0079). Moving between a
Destination's own views, or between the dates one of them covers, is not leaving it — so it is
not something Back undoes. Back is for screens, not for state within one.

### Time

The Server-backed Destination for reviewing what was recorded during a day. Time does not create
or change an Entry, and visiting it does not stop a Device's ordinary Sync; it reads Activity
intervals the Server owns. A Server that supports Time may have no enabled Time source yet, which
is an empty state rather than a missing Destination.

A Time **day** is a calendar date as the Server's own timezone reckons it, not as each Device's
does (ADR 0092). Two Devices in different zones asking for the same date see the same day.

### Activity interval

One immutable stretch of activity observed by a Time source, with a start and end, a source, a
label, and optional detail. An Activity interval is evidence from a recorder, not a Task, Entry,
or assertion the user wrote.

### Time source

A configured recorder the Server imports Activity intervals from. A Time source belongs to the
Server, not to a Device: adding, archiving, or refreshing one changes the one shared account of
recorded activity rather than a Device's local History.

### Composer

The view where the user writes an Entry before Sending it, and where they read the ones they
have already captured. Composer names the view, not the action performed in it — that's Send.
It renders History beneath its input rather than holding Entries of its own: what Send commits
lives in History, and the Composer view is one way of looking at it.

### Sync

The ongoing process by which Devices exchange Entries with each other, so that an Entry
captured, changed, or removed on one Device is eventually reflected in the History on every
other Device belonging to the same user.

### Sync status

Whether this Device's Sync is off, working, or failing. Off is the default and reads as a
neutral state, not an error — it just means Sync is opt-in and no Server URL is set. Working and
failing describe an ongoing attempt against a configured Server.

### Export

A zip a Device produces on request, holding a plain-text file per day plus a lossless
`manifest.json`, so a user can read or move their History outside the app. An Export always
covers the whole History, never a Search — an artifact that quietly omits things is worse than
none. It is the *readable* one of the two things a Device can produce; the lossless one a Device
can read back is a Backup.

### Backup

Everything a Device holds, written out as SQL so it can be read back. Where an Export answers
"can I read this", a Backup answers "is my data safe": it covers every kind of row a Device
stores rather than the ones that happen to be readable as prose, it keeps rows the user has
deleted, and unlike an Export it is something the app itself can consume again — through a
Restore or a Merge.

A Backup is a whole Device, not a selection. It carries that Device's settings alongside its
rows, because a Device restored without them is not the Device that was backed up.

### Restore

Replacing everything a Device holds with a Backup's contents. The Device becomes the Backup:
rows it had and the Backup does not are gone. It keeps its own identity — a Restore does not
make this Device claim to be the one the Backup came from — and it asks before it acts, because
this is the one operation in the app that destroys History on purpose.

Before it replaces anything, Restore takes a safety Backup of the Device's own current contents
and refuses to proceed at all if that safety Backup can't be saved. That's what makes a Restore
interrupted partway recoverable: the safety Backup is a Backup like any other, restorable the
same way, and returns the Device to exactly how it was the moment before.

### Merge

Folding a Backup's rows into a Device without discarding what the Device already holds. Where a
Restore replaces, a Merge adds and updates: a row only the Backup has arrives, a row only the
Device has stays, and where both hold the same row the one changed more recently wins. A row
whose content is identical on both sides is left exactly as it is.

A Merge carries rows and nothing else. Settings belong to a Device, not to its History, so a
Merge never touches them — that is a Restore's business.

Before it folds anything in, Merge takes a safety Backup of the Device's own current contents
too, the same way Restore does, and for the same reason: where both sides hold a row, the one
changed more recently overwrites the other, so a Merge interrupted partway can leave the Device
holding some rows the incoming Backup overwrote and some it didn't, with no record of which. It
can't lose a row that only ever existed locally — Merge never deletes — so this is a smaller risk
than the one Restore's safety Backup guards against, but the same safety Backup makes it
recoverable all the same.

### Cursor

A Device's record of how far it has Synced, one per stream (Entries, Tasks, Projects, Sections,
Labels, Comments, Events). A Cursor only ever advances — it marks the point up to which a Device
has already received every row of that stream there is to receive, so that Syncing again only
needs to ask for what came after — with one deliberate, narrow exception: a Device that adds a
field to a stream's row shape resets that stream's own Cursor to 0 once, so the next Sync re-walks
rows it already held and picks up the field it was missing (ADR 0057). This is not a Device
forgetting what it already has — every row still arrives, the Cursor is simply told to ask for it
again — and it happens at most once per stream per field added, never as an ordinary consequence
of Syncing.

### Server

The thing a Device Syncs through. Every Device exchanges Entries with the Server rather than with
other Devices directly.

### Capability

Whether the Server can actually serve a given feature right now — configured *and* switched on,
not merely present as a route it happens to expose. A Server can accept a request at the same
address it always has and still lack a Capability a Device asks about: the route exists, but
nothing behind it is switched on, the gap a bare "reachable" cannot name on its own. A Device only
ever reads a Capability; it has no way to switch one on for the Server, because a Capability
describes a fact about how the Server is configured, not a preference any Device holds about it.

### Server setting

Configuration the Server holds for itself, reachable from whichever Device opens it — the
counterpart to a Device setting, which ADR 0008 puts outside the Entry store precisely because it
is a fact about one installation and never leaves it. A Server setting is the opposite shape: one
Server holds it once, on behalf of every Device that Syncs through it, so a Device that changes one
is changing it for every other Device too, not only for itself. Where a Device setting applies the
instant it's chosen and cannot fail, a Server setting round-trips through a request that can.

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

### Turn

One Question, together with the Answer it produced. Turn is the unit a Conversation is counted
in: "the last 10 Turns" — the size of the window a later Question can lean on — means ten
Question/Answer pairs, not something smaller. Reaching one Answer can take Reflection several
Steps of its own work along the way, and none of that shows up as more than the one Turn it ends
in: a Turn is what the user sees, a Question followed by its Answer, however much or little work
sat between them.

### Step

One iteration of Reflection's own work while it answers a Question: the model produces one reply,
and if that reply asks to use a tool, the tool's result is read before the model replies again. A
Question can take several Steps — the model may look, decide it hasn't seen enough, and look
again — before it has what it needs to write the Answer. A Step is not a second unit sitting next
to Question and Answer; it is the machinery Reflection uses to get from one to the other, and
nothing about how many Steps a Question takes changes what the user sees, which stays a single
Turn regardless.

### Conversation

The running sequence of Questions and Answers inside one Session. Each Question is read in the
light of the Conversation before it, so a follow-up can lean on what was already asked without
repeating it. Because the Server holds the Session, a Conversation is reachable from every
Device, not only the one it started on.

### Session

The durable container the Server holds for one Conversation: it has an id, a title taken from
its first Question, and the time it started. A Session is what the user lists, opens, and
deletes; the Conversation is the Questions and Answers inside it — one Session holds one
Conversation. The Server holds Sessions, so every Device reaches the same ones.

### Grounding

The Entries Reflection found relevant to a Question and used as the basis for its Answer.
Grounding always comes from the user's own History. An Answer with no Grounding behind it says
so plainly rather than filling the gap from somewhere else — a Reflection that invents a past
the user did not live is worse than one that admits it found nothing.

### Digest

Prose the Server writes about a stretch of time, usually without being asked — nobody asked; the
Server simply wrote — though it can also be asked for directly, by regenerating it. It is not an Answer,
because even a Digest written on request has no Question behind it. It is not an Entry either:
not the user's own words, never added to History, never Synced. Each revision of a Digest is
immutable once written — nothing is ever rewritten, only INSERTed as a new revision — so an Entry
that Syncs in late for a Period already Digested is simply not in that revision. But a revision can
be superseded: editing, adding, or deleting an Entry in an already-Digested Period marks it stale,
and asking the Server to regenerate writes a fresh revision from the Period's current Entries
rather than rewriting the one before it, which stays exactly as it was. A reader only ever sees the
newest revision, with a cue for whether the Server wrote it on its own or someone asked for it.
"Last day" and "last week" mean the most recent Digest that exists, not the Period immediately
before now: if there is a daily Digest for Monday and none for Tuesday, then on Wednesday the last
daily Digest is still Monday's. A Digest is Grounded in exactly the Entries it was written from —
normally every Entry in the Period, and observably fewer when part of a Period had to be left out.

A Digest also covers the Tasks completed and the Tasks that slipped in its Period. This is the one
place a Digest stops being purely about what the user wrote, and it reads as prose about the
stretch of time rather than as a scoreboard. Grounding still names Entries alone: a Task is not
something the user wrote, so it is not something a Digest can cite as the words it drew on.

### Period

The stretch of time a Digest covers: a day, a week, or a month. Period is what makes the Digest
one concept at three settings rather than three separate concepts — a daily, a weekly, and a
monthly Digest all work the same way, differing only in the Period each one covers.

### Task

A Task is a second root noun beside Entry — the first local, Synced, non-Entry thing meologue
holds. It has its own identity and its own lifecycle: it is not a property of anything else, and
nothing else is authoritative over what it says.

Every checkbox written in an Entry is a Task; there is no separate act of promoting one. A Task
created in Todo, by contrast, creates no Entry — History stays the collection of things the user
actually wrote, not everything the user is tracking. The Task owns its text: whichever surface a
Task started life on, there is exactly one copy of what it says and one copy of whether it is
done.

A Task also owns a Description and the Comments made against it — see their own entries below.
Both belong to Todo alone: neither enters History, and History's own rule above ("what the user
actually wrote") is why not.

### Todo

The fifth Destination (ADR 0036, ADR 0049): the view where the user manages Tasks — creating
them, dating them, organizing them into Projects and Sections, and marking them done. Todo shows
a Task regardless of whether it began there or as a checkbox inside an Entry.

### Project

A named container a Task can live in. Projects nest, so a Project can hold other Projects as well
as Tasks.

### Section

A flat division inside a Project, for grouping the Tasks within it. A Task sits in at most one
Section.

### Sub-task

A Task whose parent is another Task. A sub-task is a full Task in every other respect — it can
carry its own Date, Priority and Labels, and can have sub-tasks of its own. Completing a parent
completes its sub-tasks along with it; completing every sub-task does not complete the parent,
because the parent may still name work its sub-tasks don't cover.

### Description

A Task's own words about itself, beyond its name — Markdown, read the same way an Entry's body
is. A Task need not carry one; unlike an Entry's body, which exists the moment the Entry does, a
Description starts absent and is added, or not, afterward.

### Comment

A note added against a Task after the fact, with its own identity and its own time — a Task can
hold many. A Comment is not an Entry: it is never added to History, never covered by Export or
Digest grounding, and belongs to Todo alone, the same way a Task's Description does.

### Event

A record of something that happened to a Task, a Project, a Section or a Comment — that it was
added, completed, renamed, rescheduled, moved, or removed. An Event is written once, at the moment
the thing it describes happens, and is never rewritten afterward: it is a record of what was done,
not a value that can later be corrected or take back what it said. It is stamped with when the act
actually happened, on whichever Device the user was using at the time, not with whenever that
Device next reached a Server — a Task finished on a train, before the Device reconnects, reads as
finished when it was finished, not when the connection came back. Reordering a Task, collapsing a
Section, and simply opening a Task to look at it are not acts an Event records.

A Task shows its own Events; a Project shows its own; and one view reads across everything the
user has done. There is no separate place completed work lives — it is reached by narrowing
whichever of those three views to Events that record a completion, the same view, seen through a
narrower lens.

### Label

A name the user attaches to a Task, freely, across Projects — a way of grouping Tasks that cuts
across where they live rather than following it.

### Filter

A saved query over Tasks.

### Priority

One of four levels a Task can carry, p1 the most urgent. Priority is a tie-break inside a day, not
a global rank: it decides which of two Tasks due the same day comes first, not whether an urgent
Task due next week outranks an ordinary one due today.

### Date

When the user plans to do a Task. Optional — a Task need not carry one. A Date may carry a time as
well as a day, and that time is floating: 9am means 9am wherever the Device reading it happens to
be, not 9am in some fixed timezone.

### Recurrence

A Task that comes back. What the user typed to describe the pattern is what is stored, unchanged;
the next Date is re-derived from that text each time the Task is completed, and once more when the
recurrence is first given to it, rather than computed once and fixed as a schedule. A Task given a
recurrence is due on the first Date that actually matches the pattern, including the day it was
given the recurrence, if that day itself matches (issue #191) — completing it is what moves it
strictly past that Date, never the Date's own computation.

### Inbox

Where a Task with no Project lives. Inbox is not a container the way a Project is — it names the
absence of one, not a place a Task is filed.

### Favourite

A Project the user has marked to keep close at hand. Favouriting changes nothing about where a
Project lives or what it holds — a favourited Project is still exactly where it was, nested where it
was nested — it only says the user reaches for it often enough to want it offered before the rest.
It is a property of the Project itself rather than of any view, so it is the same mark wherever that
Project appears.

### Upcoming

The view over Tasks forward from today, grouped by the day each falls on. Upcoming groups by Date
alone, and adds nothing of its own: a Task appears in it because of when it is planned, never
because of where it lives or what it says. A Task with no Date appears nowhere in it — there is no
day to put it under.

### Overdue

A Task whose Date is a day before today and that is not yet done. Overdue is a state, not a place:
a Task stops being Overdue the moment it is done or given a Date of today or later.

### Reschedule

Moving every Overdue Task at once, with one pick, in the same way a single Task's Date is set. A
picked day moves each Task and leaves its own time and Recurrence as they were; a picked time or
Recurrence is given to every one of them.
_Avoid_: bulk date, postpone

### Occurrence

One instance of a recurring Task, recorded as finished. An Occurrence is a record of work already
done, not a Task in its own right: it cannot be reopened and cannot be rescheduled, unlike the
recurring Task itself, which carries on to its next Date.

### Day block

The list of Tasks dated on a given day, shown at the start of that day in History. A
Day block is a rendering, not a record: nothing about it is stored, so re-dating a Task moves it
from one Day block to another while whatever Reference to it sits in an Entry stays exactly where
it was written. A Day block is invisible to Export, to Digest grounding, and to embeddings — none
of them read it, because there is nothing there to read beyond a Task that already exists
somewhere else.

## Terms we avoid

### "message"

A message implies an addressee — someone or something it is sent *to*. An Entry has no
recipient; it is captured for the user's own History, not sent to anyone. Don't use "message"
for an Entry, even informally.

This holds inside Reflection too, where the pull is strongest: a Conversation is made of
Questions and Answers, never of messages. Every chat interface in the world calls them messages,
which is exactly why it is worth refusing here — a Question has no addressee either.

**Exception: the transcript Reflection sends to and reads back from the model.** Underneath a
Question and its Answer, Reflection's harness builds and replays a transcript addressed to the
model itself — a prior reply played back so the model sees its own history, a tool's result
handed back for it to read next. Unlike a Question or an Answer, each of those genuinely has an
addressee: it is built to be read by the model on a specific call, not captured for the user's
own History and not the user asking or Reflection answering. That is exactly the property this
entry's prohibition turns on — no addressee, don't call it a message — so where the property
actually holds, the word is allowed: `harness::types::Message`, `MessagePayload` and the stored
`message` entry type name a transcript frame addressed to the model, not a Question, an Answer,
or an Entry. The exception stops at that layer. It does not reach upward: a Question is still not
a message, an Answer is still not a message, and an Entry is still not a message, for the same
reasons given above.

Unlike that one, Send and History are safe: they name the *action* and the *view*, not the
Entry itself, so they don't smuggle in the wrong properties.

### "Project" — kept, with a note

"Project" is a heavy word for what this app holds: a personal list of Tasks, not a deliverable
with a deadline, a budget, and other people depending on it. The honest objection is that
meologue has no projects in the sense the word usually carries — nothing here is staffed, planned
across a calendar, or judged done against a scope someone signed off on. A plainer word would
describe the thing more honestly, the way this glossary asks every other term to.

It is kept anyway, on a different ground than the rest of this glossary is chosen on. Every other
term earns its place by describing this domain correctly. "Project" earns its place by being a
settled naming choice: it is the word every task-management app already taught its users, for a
folder of Tasks gathered under one name, with no calendar or staffing implied by using it here. In
that specific situation, the word a person already carries into the app is worth more than a word
this domain would coin from scratch — because the cost of a slightly wrong word is a note like
this one, paid once, while the cost of a coined word is re-teaching a habit the user did not
choose to unlearn, paid every time they open the feature. So "Project" stays "Project," not
because it is the right word for a personal list, but because it is the settled word that costs
the least to keep.

### "composer" — not for Quick Add, Todoist's or meologue's

"Composer" names one thing in this app: the Destination where the user writes an Entry (see
above). The surface that creates a Task is a different thing entirely, and it is called
"Quick Add". Referring to it as "the composer" cost a full round of confusion in a real session,
once a note about Todoist reused meologue's own term for a Todoist surface that shares none of its
properties. That half of this entry earned itself and stands: "Composer" only for meologue's
Destination, never for any surface that creates a Task.

"Quick Add" now names meologue's own add-task surface as well as Todoist's. This entry used to
reserve it for Todoist alone, as "Todoist's own, not a coinage here", while leaving meologue's
surface unnamed — and the code called it Quick Add throughout regardless. That reservation made
sense while the two were merely similar. It stopped making sense once meologue's surface became a
deliberate clone of Todoist's, reproducing its grammar, layout and behaviour: two surfaces built to
be indistinguishable are best served by one name, and a different name would imply a difference
that is being deliberately removed. So the relaxation applies to Quick Add and not to Composer
because the reasons point opposite ways — Composer and Todoist's dialog share none of their
properties, meologue's Quick Add and Todoist's share all of them. Where a sentence could mean
either product's Quick Add, name the product.
