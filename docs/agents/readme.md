# README

How to write and maintain this repo's root `README.md`.

## Audience

Two readers, both of whom already have the repo open: **the author six months from now**, and **an agent
orienting before it changes something**. Neither is a stranger being recruited.

That audience decides what belongs. General README guides optimise for a stranger deciding whether to
adopt the project, so they prescribe community furniture — chat badges, contributor galleries, star
history, adoption pitches, a code of conduct. Those cost maintenance and earn nothing here. Spend the
space on orientation instead: what this is, how to run it, why it is shaped this way.

## Structure

In this order. A reader who stops after the first screen should already know what meologue is and what
it looks like.

1. **Name, then one plain sentence** — what it is and who it is for, in the glossary's vocabulary.
2. **Hero visual, above the fold.** A screenshot goes before any prose about features. This is a
   three-platform app, so the hero shows all three.
3. **Run it** — prerequisites and the shortest path to a running app, inside the first screen or two.
   Per-platform sections follow: web, then Android, then macOS.
4. **Layout** — the directory map, one line each.
5. **How sync works** — the mechanism a reader needs before touching the sync code.
6. **Reading further** — pointers to `CONTEXT.md` and `docs/adr/`.
7. **Not built yet** — the honest scope boundary. Keep this current; it is what stops a reader assuming
   a missing feature is a bug, and it is the section most likely to go stale.

Target 800–1,500 words. Past that, move detail into `docs/` or a package-level README and link to it —
`server/README.md` already carries the server's own detail.

## Screenshots

- Live in `docs/`, named by platform: `screenshot-web.png`, `screenshot-android.png`,
  `screenshot-macos.png`.
- Present the three together in a table so they read as one system.
- Every screenshot needs alt text — it is the only thing a reader gets when the image fails to load.
- Capture with real synced data: send a handful of natural-looking Entries first, since History is
  newest-first and recent Entries land at the top. Development leftovers with UUIDs in the body make
  the app look like a debug log.
- Capture commands are `adb exec-out screencap -p` for Android and `screencapture -x` for macOS. Both
  work on the dev machine without extra tooling.
- Retake them when the UI changes shape. A screenshot showing a layout the app no longer has is worse
  than no screenshot, because it is believed.

## Keeping it true

The README's failure mode is **drift**: instructions that were accurate when written and quietly stopped
being so. Two habits hold it off.

**Run every command you write, in a shell, before committing it.** This is not theoretical — the Checks
section shipped `cargo test --manifest-path server/Cargo.toml` for two versions without the
`DATABASE_URL` export it needs, so the documented command failed for anyone who tried it.

**Let the environment own what the environment knows.** Script names live in `package.json`; the port
and static directory live in the server's own configuration. Restating those in prose creates a second
copy that goes stale on its own schedule. Write down instead what a reader cannot discover by looking:
why a choice was made, which prerequisite is easy to miss, which two files must change together.
