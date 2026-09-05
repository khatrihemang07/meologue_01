# 0062: An instance names itself, independently of whether it is locked

## Status

Accepted. Extends [0029](0029-testing-runs-in-a-sandbox-instance-that-shares-only-the-working-tree.md),
which already gives Production and Sandbox separate ports, databases, bundle directories and
(natively) package identifiers, but nothing that says which one a running *process* actually is —
that fact lived only in which script happened to launch it. Also extends
[0059](0059-server-settings-are-a-stored-overlay-on-the-environment-and-the-ui-wins.md), which
introduces `MEOLOGUE_CONFIG_LOCK` alongside the `MEOLOGUE_MODE` this ADR names — see Decision below
for why the two are recorded in separate ADRs despite arriving in the same ticket and often being
set by the same script.

## Context

ADR 0029 makes Production and Sandbox structurally separate — different Postgres containers, ports,
bundle directories, and (on native shells) different application identifiers — precisely so nothing
running one instance can reach or be mistaken for the other. What it does not give a *process* is
any way to say, of itself, which one it is. `server/src/main.rs`'s startup banner prints the port
and the bind address; it says nothing about whether this is the instance holding real Entries or
the one a test suite just wiped and reseeded. A developer reading two terminal windows, or a UI
that will eventually surface a Server's own identity, has had to infer this from the port number
alone.

[0059](0059-server-settings-are-a-stored-overlay-on-the-environment-and-the-ui-wins.md) introduces
a second, unrelated environment variable in the same ticket, `MEOLOGUE_CONFIG_LOCK`, which makes a
Server ignore its stored settings and read only the environment. The two variables are easy to
conflate, because `scripts/sandbox-server.sh` and `scripts/e2e-server.sh` are exactly the scripts
most likely to set both — a Sandbox is often also the instance whose stored config a test run wants
pinned down. That co-occurrence is what makes it worth writing down, explicitly, that naming an
instance and refusing its stored configuration are two unrelated facts that merely happen to be
decided by the same scripts.

## Decision

**`MEOLOGUE_MODE` (`production` | `sandbox`, defaulting to `production`) lets a Server say which
instance it is.** `settings::instance_mode()` reads it once at startup, mirroring
`period::server_timezone()`'s own "read once, thread through" shape; `settings::parse_mode` is the
pure parsing half, unit-tested directly. An unrecognised value warns and falls back to
`production`, matching how `period::parse_timezone` treats an unparseable `MEOLOGUE_TZ` — a
misconfigured value should degrade a banner and a UI label, never refuse to start the process that
would otherwise be perfectly usable.

**`MEOLOGUE_MODE` decides nothing about precedence.** `settings::resolve` never reads it, and never
will: whether a stored value wins over an environment one (ADR 0059) and which instance a process
identifies as are orthogonal questions with independent answers. A Sandbox is not somehow "more
overridable" than Production, and Production is not somehow more authoritative than a Sandbox —
naming an instance grants it no privilege over its own configuration, the same way a person
introducing themselves by name is not thereby granted any authority by the introduction. This is
worth stating explicitly because a plausible-sounding but wrong design exists right next to the
right one: "the Sandbox instance always defers to environment, since it's disposable anyway" would
quietly reintroduce a coupling this ADR is written specifically to rule out.

**`MEOLOGUE_MODE` is reported today in the startup banner, and later in a UI banner or log
prefix — nothing more, yet.** `main.rs` prints `Instance: production` or `Instance: sandbox`
alongside its existing bind-address warnings; `GET /v1/config`'s `mode` field is the same value,
readable by a Device. Nothing about this ticket routes behaviour differently for one mode versus
the other anywhere in the Rust server — `mode` exists purely to be displayed, today and for the
foreseeable future.

**`MEOLOGUE_MODE` and `MEOLOGUE_CONFIG_LOCK` are two independent variables, not one combined
"test mode" switch, even though the scripts that set them often set both together.**
`scripts/sandbox-server.sh` sets only `MEOLOGUE_MODE=sandbox` — a Sandbox that a developer is
actively configuring through its own UI should absolutely keep its stored settings, so it must not
be locked. `scripts/e2e-server.sh`/`scripts/e2e-server-b.sh` set only `MEOLOGUE_CONFIG_LOCK=1` —
the e2e suite's Servers have no reason to advertise themselves as anything but the `production`
default, since nothing reads their `mode` at all. A future script that wants a locked Production
instance, or an unlocked one named Sandbox for some other purpose, can set exactly one of the two
without the other coming along for the ride. Collapsing them into a single variable would make that
combination inexpressible for no benefit — the two facts have never actually needed to move
together, they have only ever been set by neighbouring scripts.

## Alternatives considered

- **Infer the instance from `PORT` or `DATABASE_URL` instead of a dedicated variable.** Rejected:
  both are already overridable independently (a developer can run the Sandbox binary on a
  nonstandard port while debugging a port conflict, say), so either would sometimes report the
  wrong answer for a Server that is, in every other structural sense per ADR 0029, genuinely the
  Sandbox. A dedicated variable says what it means regardless of how the rest of the process happens
  to be configured that run.
- **One combined `MEOLOGUE_TEST_MODE` (or similar) that both names the instance and locks its
  configuration.** Rejected — see Decision's final paragraph. The two facts have independent
  reasons to be true or false, and every script that currently needs one but not the other
  (`sandbox-server.sh` needs naming, not locking; the e2e scripts need locking, and don't care about
  naming) would have to fight a combined flag to get only the half it wants.
- **Refuse to start on an unrecognised `MEOLOGUE_MODE` value.** Rejected, matching
  `period::parse_timezone`'s own precedent: a Server that would otherwise run perfectly well should
  not be taken down over a value that only ever affects a banner and a UI label.

## Consequences

`scripts/sandbox-server.sh` and `scripts/lib/run-instance.sh` (the shared runner
`scripts/run-sandbox.sh` sources) both export `MEOLOGUE_MODE` — the latter as `"$INSTANCE"`, the
variable every `scripts/run-*.sh` caller already sets for its own preflight and banner text, rather
than a second hardcoded `"sandbox"` string that could drift from the first.
`scripts/run-production.sh` sets neither: the default (`production`) is already correct for it, and
a variable only needs setting where the default would be wrong.

A future reader adding a third instance kind (there is no concrete plan for one, but ADR 0029's own
two-instance table is the kind of thing that could grow a row) would extend `InstanceMode` and
`parse_mode` here, and would need to re-examine every place `main.rs`/`settings::resolve` print or
report `mode` — but, per this ADR's central point, would not need to touch `settings::resolve`
itself at all, because that function has never read this value.
