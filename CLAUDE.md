## Agent skills

### Issue tracker

Issues live in GitHub Issues for khatrihemang07/meologue_01 (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### README screenshot

`README.md` embeds `docs/screenshot.png`, a live capture of the app. Whenever a change alters
what the app looks like on screen, retake it: build/run the app (production-style single
process, see README's "Run it"), use the `ego-browser` skill to load it and capture a tight
screenshot (crop to content, not a mostly-empty full page), overwrite `docs/screenshot.png`,
and commit it alongside the change. The dev Postgres accumulates leftover e2e test entries
between runs — clear the `entries` table and the browser's local storage/IndexedDB before
capturing, so the screenshot shows a clean example entry rather than test debris.
