# 0082: Todoist is the specification per platform

## Status

Accepted. Ratified by the owner 2026-09-14; written down here 2026-09-15, which is the gap this
ADR closes rather than a decision it makes.

Extends [0072](0072-upnote-is-the-specification-per-input-modality.md), which decided the identical
question for the Composer's reference application and is the precedent this one follows. Builds on
[0077](0077-parity-is-proved-live-not-against-a-dated-capture.md) — a row is driven live, in one
session, against the running application — and [0078](0078-the-observed-reference-corpus-lives-in-its-own-repo.md),
which is where the evidence lives. Neither is moved by this ADR.

Supersedes nothing. It does not touch the status vocabulary
(`todoist-captured` / `built` / `matched` / `divergent` / `blocked`), nor the three axes
`matched` requires — only the question of *which Todoist* a row is measured against, and what a
verdict on one platform entitles you to say about the other.

## Context

Parity against **Todoist web** has been a long programme with its own ledger — 127 rows at the time
this question was asked. Every one of them was desktop-only, and not by choice: `adb devices` came
back empty in every prior round, so there was no Android reading to take. Parity against **Todoist
Android** did not exist at all until the 2026-09-14/15 round, when a device finally attached.

It took about an hour of driving for the premise underneath those 127 rows to fail. Two facts, each
sufficient on its own:

**The two Todoists disagree with each other.** Not in rendering detail — in structure and in
behaviour:

- Quick Add is a FAB-triggered bottom sheet carrying Project/Date/Priority/Label attribute chips on
  Android, and a footer-with-Cancel dialog on web.
- The Date picker is a full-width bottom sheet on Android and an anchored popover on web.
- Undo after completing a Task holds for **~3.5 s** on Android (`ADONE-02`). meologue holds it for
  10 s, a number taken from Todoist web, where it is correct.
- Todoist Android's bottom bar carries **four** destinations with Search, Filters & Labels,
  Reporting and Projects consolidated behind a `Browse` hub; the web's navigation does not work that
  way at all.

**meologue on the device renders its narrow layout.** 426 x 949 CSS px, `devicePixelRatio` 2.8125 —
below the 900 px breakpoint, so the phone gets a different component tree from the one every browser
row measured. The sidebar that reaches Search on the desktop does not render at all. No browser row
was ever measured against this shell; several describe a shell the phone never builds.

So a question with no answer in the existing record: when meologue's phone build and Todoist's phone
app disagree, is that a defect? The browser ledger cannot say. Its reference is a product that
renders something else, on a shell meologue does not build at that width.

**Left undecided, a row where the two Todoists differ stands open forever.** It cannot be `matched`,
because meologue does not do what *some* Todoist does; it cannot honestly be `divergent`, because
that status carries "and whose decision" and nobody has made one. `ADONE-02` is the worked example
the owner was asked with, and it is a good one precisely because neither answer is obviously right:
10 s is more forgiving and 3.5 s is what a reader arriving from Todoist Android has in their hands.
A ledger full of rows in that condition is a list of complaints, not a specification.

ADR 0072 had already met this exact shape and answered it. UpNote's macOS and Android builds disagree
with each other on nested list markers and on multi-line paste, and 0072's answer was not to
reconcile them into one spuriously precise "UpNote's behaviour" but to specify **per input modality**
and carry a `platform` field on the rows that need one. The difference here is only which axis the
split runs along.

## Decision

**Todoist is the specification, but only on the platform it was captured on. meologue's Android
build follows Todoist Android; the desktop build keeps following Todoist web.**

Four things follow, and all four are load-bearing:

**The Android ledger is a separate file, not a column.**
`meologue-reference/todoist/parity-ledger-android.md` stands beside `parity-ledger.md` rather than
adding a column to it. A shared status column could not be read unambiguously once the two
references disagree — `matched` against which one? The separation is what makes the status vocabulary
survive unchanged.

**A row never inherits a verdict across platforms, in either direction.** A behaviour settled on the
browser is explicitly *not* settled on Android, and the reverse. The intended and initially
surprising consequence: **a browser row and an Android row may both read `matched` while describing
different behaviour.** That is the decision working, not a contradiction in the record — and it is
the sentence most likely to be read as a bug by someone arriving later, which is why it is stated
here rather than left to be inferred.

**Shared code establishes behaviour, but as a different kind of claim.** The detail view is not
platform-branched. `apps/web/vite.config.ts:145-178` resolves exactly six aliases per target —
`wake-signals`, `back-button`, `sqlite-driver`, `save-file`, `load-file` and
`register-service-worker` — and every one of them is a platform shim, not a UI component. No Todo
component is branched by target at all, so Android runs the identical component and *could not*
have differed. That is a real way
to establish a row, and it is cheaper and more reliable than driving. It is also a **source fact**,
not a reading, and the row must say which it is: "established by reading the code" and "read on the
device" are different claims with different failure modes. `AROW-14` is written this way
deliberately. The failure this guards against already happened twice: `ADET-07` claimed meologue
merges Comments and Activity into one feed when the source shows two sibling sections, and it
reached both a ledger row and a public issue within the hour.

**Severity is not behaviour, and splits on its own axis.** The per-platform ruling splits *behaviour*.
Harm can differ between platforms where behaviour does not: `AROW-14`'s redundant Project label is
the same code and the same output at every width, and materially worse at 426 px where horizontal
room is scarce. A single shared row may therefore carry two severities and one behaviour, and that
is not an inconsistency to be tidied away.

One clarification the Android round forced, recorded here because it is a consequence of taking a
second reference seriously: **`divergent — meologue is better here` is its own status, not a flavour
of `divergent`.** `APRI-06` is the case — Todoist Android marks the selected priority visually only,
with every card's accessibility `selected` reading `false`, where meologue exposes `aria-pressed`.
That is an accessibility gap rather than a design. Parity is the goal; copying an accessibility gap
is not, and a ledger that cannot tell "we chose differently" from "we chose better" is one confident
ticket away from someone closing the gap in the wrong direction.

## Alternatives considered

- **One ledger with a `platform` column, as ADR 0072's fixture does.** This is the closest
  alternative and it is what the precedent literally did, so it deserves more than a line. Rejected
  because 0072's fixture rows and these ledger rows are different objects. A fixture row carries a
  machine-checked `expected` value, so a `platform` field on it *discriminates* — the harness runs
  the right row on the right target. A ledger row carries a human-read status, and `matched` in a
  shared column answers "matched what?" with silence. The 127 existing rows are the deciding detail:
  every one of them was written when Android did not exist as a reference, so a shared column would
  have had to be read as "web unless annotated" — a default that is invisible at the point of
  reading and wrong for the rows that most need care.

- **Pick one Todoist — say the web — as canonical for both meologue builds.** Rejected. It would
  hold meologue's phone to a reference that renders a shell meologue does not build at 426 px, which
  is how the desktop popover ended up as a 250 px card in the corner of a phone screen (issue #282).
  The alternative direction — Android canonical for both — fails symmetrically.

- **Converge meologue's two builds first, then have one reference.** Rejected as answering a
  different question. The divergence being recorded is Todoist's, not meologue's; a single meologue
  shell would still have to choose which Todoist to follow at which width, which is this decision
  again with more code in front of it.

- **Record the split in prose only, without a second ledger.** Rejected. That is exactly what the
  four ADRs before 0072 did with "matches UpNote" — a claim made once, in prose, at the moment a
  decision was written down, never re-checkable. 0072's own Context is the argument against
  repeating it.

## Consequences

**The cost is paid twice, per row.** Establishing a behaviour now means driving two reference
applications on two platforms, with two rigs that share nothing: meologue's Android build is a
Capacitor WebView read over CDP, where `getComputedStyle` and `getBoundingClientRect` transfer
unchanged from the browser rounds — but Todoist Android is native, read by `uiautomator dump` plus
pixel measurement, and reports no font size anywhere. Type is therefore compared by measuring the
*ink* of the same characters on both sides, which is ADR 0077's "measured on different typed strings"
failure waiting in a new costume. The Android ledger's `What matched requires` section carries that
addition.

**Two ledgers drift independently, and a reader will assume they don't.** The most likely future
error is someone reading a `matched` on one and acting on it for the other — closing a gap in the
wrong direction, or re-opening a settled one. Nothing mechanical prevents this. The defence is the
ledger header saying so in its first paragraph, and this ADR.

**Identifying *which* meologue is being measured gets harder, not easier.** `versionName` is
hand-bumped per release, so every APK built from unreleased work reads the same `0.7.0` — two
sessions' builds are indistinguishable by version string, and a worktree's `dist/` names that
worktree's last local build, not what the device runs. A row is therefore stamped with the bundle
hash read out of the **running** WebView. This is not incidental bookkeeping: a peer read the Sandbox
at `0.5.0` around 22:00 and this session read `0.7.0` at 23:09, both accurately, with an install
sitting between them.

**This ADR does not fix the thing that actually makes rows go stale.** Every other axis in this
corpus reconciles to something — a Todoist observation to its capture date and artifact, a build to
its bundle hash, a driven row to the session that drove it. The **meologue column reconciles to
nothing**: it is a claim about code that no process connects back to that code. Four rows went stale
in a single night, one of them describing behaviour that had changed *before the ticket asking about
it was filed*. Splitting the ledger by platform doubles the surface that problem has to act on.
Issue #305 proposes the check — grep each row's cited meologue source, flag rows whose citation no
longer resolves or whose file has changed since the row's date. It would not catch semantic drift,
and it would have caught three of those four.

**Some questions are now owner decisions rather than agent work, and are named as such.** Where the
two Todoists disagree, per-platform specification says meologue's two builds may legitimately differ
from each other — which is a product judgement, not a parity reading. Issue #286 (`ADONE-02`'s undo
duration, 10 s here against ~3.5 s there), #297 (Project nesting) and #299 (Upcoming's structure,
where the reference now disagrees) are open on exactly that basis, and are left for the owner rather
than resolved by whoever drives next. `ANAV-01` — whether meologue's phone adopts a `Browse` hub and
drops from six destinations to four — is the largest of these and has no issue of its own yet; it
sits inside #307's "fork worth deciding", whose default is deliberately the minimal one.
