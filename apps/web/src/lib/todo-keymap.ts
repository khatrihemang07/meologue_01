/**
 * Todo's keyboard layer (issue #228) — one declarative table every binding,
 * every rendered hint (`task-command-menu.tsx`'s own "Edit ⌘E" legend) and
 * the `?` shortcuts overlay (`todo-keyboard-shortcuts-overlay.tsx`) all read
 * off, so a hint cannot exist unless its binding does. That is the whole
 * fix for the defect this ticket closes: `task-command-menu.tsx` used to
 * hand-write `⌘E`/`T`/`Y`/`D`/`V`/`⌘⌫` as a "purely a legend" string next to
 * each item, wired to nothing. Nothing here is hand-written twice — a
 * binding's `keys` are the single source both the runtime matcher
 * (`use-todo-keymap.ts`) and every display string (`formatKeyHint` below)
 * derive from.
 *
 * **Scope — only what has a real door.** `meologue-reference/todoist/keyboard.md`
 * transcribes 80 shortcuts from Todoist's own overlay, unverified by
 * driving (that file's own header comment). This table carries a fraction
 * of those 80 — only the ones with a target that already exists in this
 * app (issue #228's own brief: "do not invent bindings for surfaces that
 * do not exist yet").
 *
 * **KBD-01/KBD-06 (parity ledger): this list used to not exist at all.**
 * An earlier version of this comment claimed to name "each key left out
 * and why" and did not — several absences (undo, the row-nav keys, `E`)
 * had no acknowledgement anywhere in the file, which is exactly how
 * CMT-05's missing undo binding went unnoticed for as long as it did. `Z`/
 * `⌘Z`, `ArrowUp/Down`/`j`/`k` are bound now (below); `E`/`C`/`⇧⌘C`/`A`/
 * `O then S` turned out to be real, missed (b)s too — bound below rather
 * than left excluded a second time.
 *
 * **A second round of the identical mistake, caught by the coordinator's
 * own re-audit rather than this file's own diligence:** the first pass of
 * this exclusion list reasoned two rows from their *name* rather than
 * checking the app — "`G then A` (reporting) — no reporting/insights
 * feature exists" and "`O then T` (themes) — no theme picker exists,
 * checked `settings-page.tsx`" — and both were wrong. `/todo/activity`
 * (`App.tsx`) is a real route that `todo-sidebar.tsx` itself labels
 * "Reporting" (NAV-01, parity ledger); the theme picker lives in
 * `appearance-section.tsx`, a component `settings-page.tsx` mounts rather
 * than contains inline, which a single-file grep missed. A third,
 * `G then L` (open label…), turned out to have the identical shape as
 * `go-projects`'s own already-accepted resolution ("open X…" → the list
 * view) and was excluded on a stale #229 deferral rather than checked
 * against the routes that now exist. All three are bound below
 * (`go-reporting`, `go-themes`, `go-labels`) rather than re-excluded a
 * third time. The full re-audit that followed also corrected `⌃]`/`⌃[`
 * (Sub-task, below) from "no feature" to "a *different*, already-working
 * binding" — see that paragraph.
 *
 * What remains excluded, and why, is every one of the 80 keyboard.md rows
 * not already covered above, listed exhaustively by keyboard.md's own
 * section, each verified against the app itself (a grep for the feature,
 * not an inference from the row's name) so this list can be checked row
 * for row rather than trusted on its word:
 *
 * *General* — `Enter` ("Open task view"): **not bound, deliberately, not
 * merely missed.** This app's row title and Edit buttons already call
 * `onOpenDetail` on click, so Enter already opens the Task wherever focus
 * naturally lands on either of those two controls; but unlike Todoist,
 * whose row is a single focusable target, this app's row decomposes into
 * several independently-focusable native controls (checkbox, Date,
 * Comment, More), each with its own existing Enter/click behaviour. A
 * document-level Enter binding firing unconditionally would `preventDefault()`
 * and override every one of those — Date's popover, Comment's identical
 * open-detail, More's menu — replacing each control's own native Enter
 * with "open the Task" regardless. That is a regression against this
 * app's own current keyboard behaviour, not a parity fix, so it stays
 * unbound. `X` (select), `⌘A` (select all), `,` under Edit task (multi-select
 * toolbar) — grepped for `multiSelect`/`multi-select`/`selectedTask`
 * across the whole app: no match outside this file's own comments and one
 * unrelated field name in a Todoist-side test fixture; no multi-select or
 * selection concept exists in this app at all.
 * `←`/`→` (move focus left/right) — no adjacent-column/board layout exists
 * for focus to move into. `Esc` (dismiss/cancel) — already true everywhere,
 * for free: every dialog/popover/menu this app renders is a Radix
 * primitive, and Radix wires Escape-to-close into all of them already
 * (KBD-02, parity ledger, verified live on the `?` overlay itself); adding
 * a binding here would be redundant with, not additive to, existing
 * behaviour. `M` (open/close sidebar) — re-checked directly (grepped for
 * `sidebarOpen`/`toggleSidebar`/`isSidebarOpen` and any collapse state on
 * `pane-divider.tsx`/`shell.tsx`): no collapsible sidebar or pane exists
 * anywhere in this app, not just under Todo. `⌘⌥0` (collapse/expand view)
 * — no board/calendar view exists for this to collapse, and the action's
 * own meaning is Todoist-view-specific.
 *
 * *Quick Add* — `⇧Q` (dictate with Ramble) — Todoist's own voice-dictation
 * product, no equivalent. `#`/`/`/`@`/`P1`-`P4`/`!`/`{` (pick project, pick
 * section, add label, set priority, add reminder, set deadline) — typed
 * *text* inside the composer that `parseQuickAdd` already tokenises, not
 * single-keystroke chords this document-level table has any business
 * intercepting; whether a given token then actually persists is that
 * parser's own completeness question (`quick-add-task.ts`'s
 * `UNSUPPORTED_TOKEN_KINDS` — project/section/reminder/description are
 * recognised but not yet stored; label and priority already are), separate
 * from whether it belongs in this table at all — it doesn't, either way.
 * `+` (add assignee) — grepped for `assignee` across the whole app: no
 * match outside this file's own comments; no assignee feature exists.
 * `↓`/`⇧↓` (add description /
 * open more actions, both from inside the Quick Add composer) — no such
 * inline reveal or menu exists in `add-task-form.tsx`, which this ticket's
 * file list doesn't reach this round.
 *
 * *Navigate* — `G then H`/bare `H` (home) — checked directly: root `/`
 * renders `ChatListPage` (`App.tsx`), a different Destination entirely
 * (this app's chat/journal home, not a Todo overview), so there is no
 * "home" inside Todo for this to reach. `G then /` (section picker) —
 * `project-view.tsx` has an inline "add section" form but no picker or
 * search surface for jumping to an existing one, checked directly, not
 * assumed from the row's name. `O then P` (Productivity/Karma), `O then
 * N` (notifications), `O then U` (user menu) — grepped for `karma`,
 * `productivity`, `notification`, `user menu`, `Account`, `Profile`
 * across the whole app: no match outside this file's own comments: none
 * of those three destinations exist. `G then A` (reporting), `G then L`
 * (open label…) and `O then T` (themes) used to be listed here too and
 * were wrong — see this file's own header comment on the coordinator's
 * re-audit; all three are bound below instead.
 *
 * *Edit task* — `⇧R` (assign to…) — same `assignee` grep as Quick Add's
 * `+` above; no assignee feature. `L` (change
 * labels) — same limitation as `V` below: `TaskCommandMenu`'s "Labels"
 * item is a Radix `DropdownMenu.Sub` with no controlled "open
 * pre-expanded" API. `V` ("Move to…") — the one door onto it is that same
 * kind of `DropdownMenu.Sub`; wiring `V` would mean either opening the
 * same generic menu `.` already opens (indistinguishable from `.`, despite
 * the specific label) or a real submenu-open refactor this ticket's scope
 * doesn't reach. Left unimplemented rather than shipping a guess, same as
 * before. `⌘↓`/`⌘↑` (move to and edit the task below/above) — "move" and
 * "edit" both exist separately (`reorderTask`, `onOpenTaskDetail`), but
 * "swap with the adjacent row in the current list, then open it" is list-
 * ordering orchestration that lives in `task-list.tsx`/`todo-page.tsx`
 * (which sibling, which section, index math) — files this ticket doesn't
 * touch — not a single existing function this hook can just call. `. or
 * ⇧.` ("More actions") — `.` is bound; the `⇧.` variant (`event.key`
 * reports `">"` on a US layout under Shift+Period) is the identical
 * action already reachable on the bare key, so leaving it unwired isn't a
 * missing binding, just an unwired synonym for one that already exists.
 *
 * *Add task* — `⇧A` ("add new task to the top of the list") — this app's
 * Add field only ever appends at the end of whichever list is showing
 * (`todo-page.tsx`'s own doc comment: it renders after the list, not
 * above it — issue #252); there is no "top of list" placement for `⇧A`
 * to target. `Enter`/`⇧Enter`/`⌃Enter`
 * (save-and-continue variants) — owned by `task-title-editor.tsx`'s own
 * ProseMirror keymap, a different module entirely, not this table's
 * concern; `⇧Enter` specifically is QA-19 (parity ledger, tracked
 * separately in issue #258) and is not to be touched here. `⌃Enter`
 * ("save and create another above") additionally has no "insert above"
 * ordering in this app's Add composer, which only ever appends.
 *
 * *Sub-task* — `⇧E` (expand/collapse task) — checked directly (grepped
 * `task-row.tsx`/`task-row-content.tsx`/`task-tree.tsx` for "expand"/
 * "collapse"): sub-tasks always render, with no collapsible state to grep
 * for, so there is genuinely nothing for this to target. `⌃]`/`⌃[`
 * (indent/outdent) are **not** a missing feature, corrected here by the
 * coordinator's own re-audit — this app already indents/outdents a Task
 * via `Alt+ArrowRight`/`Alt+ArrowLeft`, wired directly on the row
 * (`task-row.tsx`'s `onIndent`/`onOutdent` props, `task-tree.tsx`'s
 * `handleIndent`/`handleOutdent`) — just a different pair of keys than
 * Todoist's, and a row-local `onKeyDown` rather than this document-level
 * table's. Adding `⌃]`/`⌃[` here would need a new event bus into
 * `task-tree.tsx` (outside this ticket's file list this round) for an
 * action that already has a working, if differently-keyed, shortcut —
 * left unbound rather than risk a second, conflicting path to the
 * identical mutation.
 *
 * *Projects* — all 11 rows (add project, add section, share project,
 * change layout & view, the four sort orders, "more actions", comments,
 * insights) are chrome for `project-view.tsx`/`projects-view.tsx` — a
 * different view's own state (sort mode, share dialog, layout), reachable
 * through no existing door from this document-level table, and outside
 * this ticket's file list regardless. Grepped for `share`/`ShareProject`,
 * `insight`/`analytics`, `sortBy`/`sortMode`/`SortOrder` and `board`
 * across the whole app: no match — sharing, alternate layouts, sort modes
 * and insights/analytics have no feature at all yet in this app;
 * assignee-based sorting doubly doesn't, on top of that. `addProject`/
 * `addSection` themselves do exist on the store (`project-view.tsx`'s own
 * always-visible "add section" form calls the latter directly), but
 * reaching either from a keystroke needs a marker/event this document-
 * level table has no door onto without editing those off-limits files.
 *
 * *Calendar and Upcoming views* — all 5 rows (back to today, next/previous
 * week or month, scroll up/down in week view) assume a calendar/week grid.
 * This app's Upcoming (`upcoming-view.tsx`) is a flat, date-grouped list,
 * not a calendar — there is no grid for any of these five to act on.
 *
 * **`allowInField`.** issue #228's own brief: Todoist fires `P1`-`P4` and
 * `Y` even while the caret sits inside its Quick Add composer, so a blanket
 * "ignore every key while typing" guard is wrong. This app's own Add field
 * (`add-task-form.tsx`) has no in-composer priority footer for a bare `Y`
 * to target, so that particular exception doesn't apply *here* — nothing
 * below sets `allowInField` for `set-priority`. The one binding that
 * legitimately needs it is `quick-find-global` (⌘K/Ctrl+K): every other
 * search-style app treats Cmd+K as reaching through whatever text you're
 * in, and this app's own pre-#228 implementation
 * (`task-quick-find.tsx`, now superseded) already special-cased exactly
 * that — `isCommandK` bypassed the typing guard while `/`/`f` did not. This
 * table keeps that one exception, explicit rather than buried in an `if`.
 *
 * **Sequences.** `G then I/T/U/P/V/L/A` and `O then S/T` are the two-key
 * chords wired, encoded as `"g i"`/`"o s"` etc. (space-separated,
 * lowercase) — `use-todo-keymap.ts`'s own pending-prefix state machine
 * treats any `keys` entry containing a space as a sequence rather than a
 * chord. `"o s"`/`"o t"` (settings/themes) are the two `O then …` rows
 * that turned out to have real destinations — see the Navigate exclusions
 * above for why the other three (`O then P/N/U`) don't.
 */

/** Grouping only — matches `keyboard.md`'s own section headings, so a
 * reader can find a wired binding by looking for the same heading. Not
 * every section that document has appears here (see the header comment
 * above for the ones this table has nothing to put under). */
export type TodoKeySection = "General" | "Navigate" | "Edit task" | "Add task";

/**
 * Whether a binding needs a specific Task singled out to act on, or applies
 * regardless. Purely descriptive here — the actual gate is `use-todo-
 * keymap.ts`'s own `focusedTaskId()` returning `null` and the handler doing
 * nothing, not a precondition on whether the key is even listened for (a
 * `t` keypress with no Task focused should do nothing silently, not report
 * "no binding" the way an unmatched key does — those are different kinds of
 * "no-op").
 */
export type TodoKeyWhen = "always" | "task-focused";

export interface TodoKeyBinding {
  id: string;
  section: TodoKeySection;
  /** Exactly the overlay's own wording (`keyboard.md`) where a wired row has one, so this table stays traceable back to the transcription it's built from. */
  label: string;
  when: TodoKeyWhen;
  /**
   * Normalised chords/sequences this binding fires on. A chord is
   * `["mod"|"shift" ...]+key` (`"mod+e"`, `"shift+t"`, `"t"`, `"?"`); a
   * sequence is two space-separated bare keys (`"g i"`). `mod` means
   * Cmd on macOS or Ctrl elsewhere — `use-todo-keymap.ts` treats
   * `metaKey || ctrlKey` as satisfying it, matching the pre-#228 Quick
   * Find implementation this table now supersedes.
   */
  keys: string[];
  /** Fires even while the keydown target is a text field (see the module header comment). Defaults to `false`. */
  allowInField?: boolean;
}

export const TODO_KEY_BINDINGS: readonly TodoKeyBinding[] = [
  // Superseded task-quick-find.tsx's own document listener (issue #183) —
  // split into two rows sharing one `label` (grouped back together for
  // display by `groupedBindingsBySection` below) purely so `allowInField`
  // can differ per key rather than per binding: `/`/`f` respect the typing
  // guard, `⌘K` does not.
  { id: "quick-find", section: "General", label: "Quick find", when: "always", keys: ["/", "f"] },
  {
    id: "quick-find-global",
    section: "General",
    label: "Quick find",
    when: "always",
    keys: ["mod+k"],
    allowInField: true,
  },
  {
    id: "show-shortcuts",
    section: "General",
    label: "Show keyboard shortcuts",
    when: "always",
    keys: ["?"],
  },
  // Issue #260 — NAV-07/KBD-01, parity ledger. `keyboard.md`'s own Quick
  // Add section transcribes `Q` as "Add task", and its accessibility
  // section (§3) DROVE this one live — "opened with `Q` for inspection
  // only, then closed with Escape" — confirming the dialog it opens is
  // the real `role="dialog"` `aria-label="Quick Add"` surface, not merely
  // a transcribed claim. `allowInField` left at its default `false`: `q`
  // is an ordinary letter, and every text field in this app (a rename, the
  // add composer itself, a Description) needs to keep typing it.
  {
    id: "quick-add",
    section: "General",
    label: "Add task",
    when: "always",
    keys: ["q"],
  },
  // CMT-05 (parity ledger), measured live: `meologue-reference/todoist/
  // keyboard.md:74` transcribes the overlay's own General row as "Z or ⌘Z |
  // Undo" — bare `z` undoes there too, not just ⌘Z — so this follows the
  // table's existing "one binding, several keys" idiom (`quick-find`'s
  // `["/", "f"]`, `focus-next-row`'s `["arrowdown", "j"]`) rather than
  // splitting into two rows. `label` is `keyboard.md`'s own wording, kept
  // traceable back to the transcription.
  //
  // `when: "always"` and `allowInField` left at its default `false` —
  // deliberately, unlike `quick-find-global`'s `mod+k` exception above.
  // Todoist fires Z/⌘Z reaching through text too, but this app's own
  // `isTypingTarget` guard (below) is what keeps ⌘Z as native text-undo
  // inside a title rename, the Add-task composer or the detail view's
  // description field — the highest-risk part of this binding. There is
  // exactly one door onto this action (`todo-page.tsx`'s pending-undo ref,
  // set for the most recent completion's toast and cleared when it is used
  // or the toast closes), so `use-todo-keymap.ts`'s `fire()` does no
  // task-lookup for this id the way `task-focused` bindings do — a stale
  // or absent pending undo is `todo-page.tsx`'s own no-op to make, not a
  // `null` this hook has to check for itself.
  {
    id: "undo-complete",
    section: "General",
    label: "Undo",
    when: "always",
    keys: ["z", "mod+z"],
  },
  // Supersedes task-row.tsx's own per-row `.`-key `onKeyDown` (issue #178)
  // — centralising it here is a real simplification, not just bureaucracy:
  // the per-row handler needed `stopPropagation()` solely to stop a `.`
  // press on a nested sub-task from also popping its *parent* row's menu
  // (issue #192's own nesting). A single document-level listener resolving
  // "which Task" from `document.activeElement` is never ambiguous between
  // ancestor and descendant rows, so that guard simply has nothing left to
  // do.
  {
    id: "command-menu",
    section: "Edit task",
    label: "More actions",
    when: "task-focused",
    keys: ["."],
  },
  {
    id: "edit-task",
    section: "Edit task",
    label: "Edit task",
    when: "task-focused",
    keys: ["mod+e"],
  },
  // KBD-01/KBD-06 (parity ledger) — a missed (b), not a documented
  // exclusion: `handleCompleteTask` (`todo-page.tsx`) already exists (it's
  // what the row's own checkbox click calls), so there was a real door
  // onto "complete the focused Task" the whole time. `label` is
  // `keyboard.md`'s own wording verbatim.
  {
    id: "complete-task",
    section: "Edit task",
    label: "Complete focused task",
    when: "task-focused",
    keys: ["e"],
  },
  // Same finding as `complete-task` above. This app has no comment-only
  // quick action — commenting happens inside the Task detail view, which
  // is exactly where the row's own existing "Comment" hover button already
  // sends a click (`task-row-content.tsx`'s Comment button calls the
  // identical `onOpenDetail` the title and Edit buttons do) — so this
  // binding reuses `onOpenTaskDetail`, the same option `edit-task` above
  // already calls, rather than adding a second one for the same
  // destination.
  {
    id: "comment-task",
    section: "Edit task",
    label: "Comment on task",
    when: "task-focused",
    keys: ["c"],
  },
  // `T`/`D`/`Y` below all target Todoist's own three separate pickers —
  // `D`/`Y` (Deadline/Priority) still open the one shared
  // `TaskScheduleSheet` that holds both (`task-schedule-sheet.tsx`'s own
  // header comment). `T` (Date) no longer does: issue #253 moved Date onto
  // its own anchored `TaskSchedulePopover`, reached via `OPEN_SCHEDULE_
  // EVENT` below rather than `use-todo-keymap.ts`'s `onOpenSchedule`
  // (`OPEN_SCHEDULE_EVENT`'s own doc comment has the fuller fan-in
  // reasoning).
  {
    id: "set-date",
    section: "Edit task",
    label: "Set date…",
    when: "task-focused",
    keys: ["t"],
  },
  {
    id: "remove-date",
    section: "Edit task",
    label: "Remove date",
    when: "task-focused",
    keys: ["shift+t"],
  },
  {
    id: "set-deadline",
    section: "Edit task",
    label: "Set deadline…",
    when: "task-focused",
    keys: ["d"],
  },
  {
    id: "remove-deadline",
    section: "Edit task",
    label: "Remove deadline",
    when: "task-focused",
    keys: ["shift+d"],
  },
  {
    id: "set-priority",
    section: "Edit task",
    label: "Set priority…",
    when: "task-focused",
    keys: ["y"],
  },
  {
    id: "delete-task",
    section: "Edit task",
    label: "Delete task",
    when: "task-focused",
    keys: ["mod+backspace", "shift+delete"],
  },
  // KBD-01/KBD-06 — another missed (b): `copyTaskLink` (`todo-page.tsx`)
  // already exists (it's what the row's own "More actions" → "Copy link
  // to task" item calls), just never had a key. `keyboard.md`'s own
  // wording for this row.
  {
    id: "copy-link",
    section: "Edit task",
    label: "Copy link to task",
    when: "task-focused",
    keys: ["mod+shift+c"],
  },
  // KBD-03/KBD-04 (parity ledger), measured live against Todoist
  // (`meologue-reference/todoist/live-audit-dom/flow6-KBD-03-todoist.json`,
  // `flow6-KBD-04-todoist.json`): both ArrowDown/ArrowUp AND j/k move
  // focus row-to-row, wrapping at both ends and walking through the
  // "Add task" affordance and completed rows, not just the incomplete
  // list. `when: "always"` (not "task-focused") is deliberate — unlike
  // every other Navigate/Edit-task row here, which does nothing without
  // a Task already focused, the very first ArrowDown/`j` from `BODY`
  // (nothing focused yet) has to land on the first row rather than no-op,
  // matching the audit's own first step. `label` is transcribed verbatim
  // from `keyboard.md`'s General section ("Move focus up: ↑ or K" / "Move
  // focus down: ↓ or J") even though this table files the pair under
  // "Navigate" rather than "General" — a deliberate, once-off exception
  // to this module's own "grouping matches keyboard.md's headings"
  // convention (this file's own header comment), because these two
  // *are* row-to-row navigation, not a General action like Quick Find or
  // the shortcuts overlay.
  //
  // `keys` are spelled lowercase (`"arrowdown"`, not `"ArrowDown"`)
  // despite `event.key` itself reporting `"ArrowDown"` — `chordFor` below
  // lower-cases unconditionally before building the chord string, so a
  // capitalised entry here would simply never match. Every other named
  // key already wired in this table (`"backspace"`, `"delete"`) follows
  // the identical convention.
  {
    id: "focus-next-row",
    section: "Navigate",
    label: "Move focus down",
    when: "always",
    keys: ["arrowdown", "j"],
  },
  {
    id: "focus-previous-row",
    section: "Navigate",
    label: "Move focus up",
    when: "always",
    keys: ["arrowup", "k"],
  },
  {
    id: "open-in-project",
    section: "Navigate",
    label: "Open task in its project",
    when: "task-focused",
    keys: ["shift+g"],
  },
  { id: "go-inbox", section: "Navigate", label: "Go to Inbox", when: "always", keys: ["g i"] },
  { id: "go-today", section: "Navigate", label: "Go to Today", when: "always", keys: ["g t"] },
  {
    id: "go-upcoming",
    section: "Navigate",
    label: "Go to Upcoming",
    when: "always",
    keys: ["g u"],
  },
  {
    id: "go-projects",
    section: "Navigate",
    label: "Open project…",
    when: "always",
    keys: ["g p"],
  },
  {
    id: "go-filters",
    section: "Navigate",
    label: "Go to Filters & Labels",
    when: "always",
    keys: ["g v"],
  },
  // Corrected after the coordinator's own re-audit: `/todo/labels`
  // (`App.tsx`) is a real route — a second (b) this table missed for the
  // identical reason as `go-projects` above, and resolved the identical
  // way. `keyboard.md`'s own wording, "Open label…", implies a picker for
  // one specific label the way "Open project…" implies a picker for one
  // specific project; `go-projects` above already resolves that same
  // wording onto the *list* view (`/todo/projects`) rather than a picker,
  // since no picker component exists — this follows that established
  // precedent rather than inventing a different rule for Labels.
  {
    id: "go-labels",
    section: "Navigate",
    label: "Open label…",
    when: "always",
    keys: ["g l"],
  },
  // Corrected after the coordinator's own re-audit: this row was wrongly
  // excluded as "no reporting/insights feature exists," reasoned from the
  // row's own name rather than checked. `/todo/activity` (`App.tsx`) is a
  // real route, and `todo-sidebar.tsx` labels that exact destination
  // "Reporting" (NAV-01, parity ledger, matched live against Todoist) —
  // `todo-nav-destinations.ts`'s own header comment states the wording
  // explicitly. `label` here keeps `keyboard.md`'s own transcribed
  // wording ("Go to reporting"), the same convention every other `go-*`
  // row in this table follows, rather than switching to the sidebar's own
  // "Reporting".
  {
    id: "go-reporting",
    section: "Navigate",
    label: "Go to reporting",
    when: "always",
    keys: ["g a"],
  },
  // KBD-01/KBD-06 — the one `O then …` row with a real destination: unlike
  // Productivity/notifications/user menu (this module's own header
  // comment has the reasoning for those three), `/settings` (`App.tsx`) is
  // a route this app actually has. Sequenced the same way as the `G
  // then …` rows above — `"o s"`, space-separated, lowercase — which is
  // also what registers `"o"` as a second sequence prefix in
  // `SEQUENCE_PREFIXES` below, computed from the table rather than
  // hand-listed.
  { id: "go-settings", section: "Navigate", label: "Open settings", when: "always", keys: ["o s"] },
  // Corrected after the coordinator's own re-audit: this row was wrongly
  // excluded as "no theme picker exists," found by grepping only
  // `settings-page.tsx` itself rather than the component tree it renders —
  // the theme picker lives in `components/settings/appearance-section.tsx`
  // (`THEME_OPTIONS`, a "Theme" `SettingsSection`), which that page mounts.
  // There is no *separate* themes route or tab, though — the picker is
  // one section on the same `/settings` screen `go-settings` above already
  // opens — so this deliberately shares that destination rather than
  // inventing a `?tab=appearance` deep link nothing on the page reads.
  // Both rows are listed honestly in the overlay: same key hint shape,
  // same destination, different Todoist-side labels.
  { id: "go-themes", section: "Navigate", label: "Open themes", when: "always", keys: ["o t"] },
  // KBD-01/KBD-06 — Todoist's own "Add task" section names the row-level
  // Add affordance rather than the global Quick Add dialog (`quick-add`,
  // `Q`, above). This app's Add field only ever appends at the list's end
  // (no "top of list" placement exists for `⇧A` to target — this module's
  // own header comment), so this binding jumps straight to that one spot
  // rather than choosing between two. `focusAddTaskField()` below reuses
  // `rowNavTargets()`'s own selector for the field rather than a second,
  // hand-duplicated one.
  {
    id: "focus-add-task",
    section: "Add task",
    label: "Add new task to the bottom of the list",
    when: "always",
    keys: ["a"],
  },
];

export function bindingById(id: string): TodoKeyBinding | undefined {
  return TODO_KEY_BINDINGS.find((binding) => binding.id === id);
}

/**
 * `<input>` types that take no typed text, so focus sitting on one is not
 * "the reader is typing" — a denylist rather than an allowlist of text
 * types, so an unfamiliar or future text-ish type still counts as typing
 * and keeps its keystrokes. `time` is deliberately absent: its own arrows
 * change the hour and minute, so it IS capturing the keyboard.
 */
const NON_TYPING_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "image",
  "color",
  "range",
]);

/**
 * The field guard — lifted from `task-quick-find.tsx`'s own pre-#228 inline
 * check, exported so there is one answer rather than two. The Quick Add
 * field is a ProseMirror `contenteditable` div, not an `<input>`/
 * `<textarea>` (`task-title-editor.tsx`), which is why `isContentEditable`
 * — not a tag check — is what actually catches it.
 *
 * **A bare `tagName === "INPUT"` was too broad, and it broke CMT-05's undo
 * on the one path a reader actually takes.** Completing a Task by clicking
 * its checkbox leaves focus *on that checkbox*, which is an `<input>` — so
 * the old rule reported "typing", every binding was suppressed, and
 * `Ctrl/Cmd+Z` (or `z`) silently did nothing. Click the checkbox, press
 * undo, get no undo. Found in the re-drive by completing a Task the way a
 * person would rather than by focusing something else first; the suite
 * could not see it because jsdom never leaves focus where a real click
 * does, and the row's own tests drive the checkbox through `fireEvent`
 * rather than a real pointer.
 *
 * So the question this answers is "is the reader typing text into this?",
 * not "is this an input?" — which also un-suppresses every *other* binding
 * while a checkbox holds focus, the same latent problem one row deep.
 * There are no `radio` or `range` inputs in this surface to have relied on
 * their own arrow handling (checked, not assumed); the types actually in
 * use here are `text`, `checkbox`, `time` and `search`.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (target.tagName === "TEXTAREA") {
    return true;
  }
  if (target.tagName === "INPUT") {
    // A missing `type` defaults to `text`, so an absent attribute is typing.
    const type = (target.getAttribute("type") ?? "text").toLowerCase();
    return !NON_TYPING_INPUT_TYPES.has(type);
  }
  return false;
}

/** The custom event `use-todo-keymap.ts` dispatches for `command-menu` — `task-row.tsx` listens for it to open *its own* `TaskCommandMenu` when its `data-task-id` matches, rather than every row keeping a keydown handler of its own. */
export const OPEN_COMMAND_MENU_EVENT = "todo:open-command-menu";

export interface OpenCommandMenuDetail {
  taskId: string;
}

/**
 * Issue #253's identical fan-in, one door over: `use-todo-keymap.ts`
 * dispatches this for the `set-date` binding (`T`) instead of calling
 * `onOpenSchedule` directly, and `task-row.tsx` listens for it the same way
 * it already listens for `OPEN_COMMAND_MENU_EVENT` above — open *this row's
 * own* `TaskSchedulePopover` instance when `data-task-id` matches. The row's
 * hover Date button and the More-actions "Date…" item reach the identical
 * per-row instance directly (they already sit inside the same component
 * tree, the same reason `command-menu`'s own trigger button and its
 * right-click handler need no event either) — only the keyboard binding,
 * which has no component reference to reach through, needs a document-level
 * event at all.
 */
export const OPEN_SCHEDULE_EVENT = "todo:open-schedule";

export interface OpenScheduleEventDetail {
  taskId: string;
}

/**
 * The identical fan-in one door over again (this module's own doc comment
 * on `OPEN_SCHEDULE_EVENT`), for the `quick-add` binding (`Q`) above.
 * `use-todo-keymap.ts` dispatches this with no detail — there is no Task
 * to name, unlike the two events above — and `todo-page.tsx` listens for
 * it to open its own `QuickAddDialog`. `todo-sidebar.tsx`'s "Add task"
 * button dispatches the identical event directly, without going through
 * the keymap at all: that component sits outside `EntryStoreLayout`'s
 * Outlet (its own header comment) and has no `handleAdd`/store access to
 * open the dialog itself, so a plain document event is the only door
 * reaching across that boundary either trigger can use.
 */
export const OPEN_QUICK_ADD_EVENT = "todo:open-quick-add";

/**
 * The identical fan-in one door over again (this module's own doc comment
 * on `OPEN_SCHEDULE_EVENT` above), for the `focus-add-task` binding (`A`,
 * KBD-01/KBD-06) below. `focusAddTaskField()` dispatches this only when
 * its own selector-based fast path finds no live textbox/input already
 * mounted — i.e. only while `add-task-form.tsx`'s composer is still the
 * collapsed resting row. `add-task-form.tsx` listens for it to reveal
 * itself (`setOpen(true)`), the same "no external door" reason
 * `OPEN_SCHEDULE_EVENT`'s own doc comment gives: that component's `open`
 * is private `useState`, so a document-level event is the only door this
 * module — which has no reference to that component — can reach through.
 * No detail, like `OPEN_QUICK_ADD_EVENT` just above: there is no Task to
 * name.
 */
export const FOCUS_ADD_TASK_EVENT = "todo:focus-add-task";

/** The Task a keyboard action should act on — whichever row's own focusable element (`data-task-id`, `task-row.tsx`) currently holds focus, or `null` if none does. Read fresh at fire-time rather than tracked in state: the DOM's own focus is already the single source of truth every row's tab order already relies on (`keyboard.md` §2's own tab-order findings). */
export function focusedTaskId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  return active.closest("[data-task-id]")?.getAttribute("data-task-id") ?? null;
}

/**
 * Every stop in the `focus-next-row`/`focus-previous-row` cycle
 * (KBD-03/04, parity ledger), in DOM order — read live off the tree, not
 * a hand-maintained list, so a row type this table doesn't know about yet
 * can't silently fall out of navigation (this ticket's own report: that
 * exact defect already happened once, a destination added to one nav but
 * not the other). Two producers mark themselves:
 *   - `task-row-content.tsx`'s title button — `[data-row-nav-target]`
 *     directly, one per row, matching Todoist's own measured landing
 *     element (`flow6-KBD-03-todoist.json`'s `isTaskRowBody`). ROW-14
 *     (parity-ledger.md) is what makes this cover a completed row too:
 *     that Task now renders through this identical title button rather
 *     than a separate component with its own stand-in Restore button —
 *     the shape this comment used to describe, back when a completed row
 *     had no focusable title of its own to carry the marker.
 *   - `add-task-form.tsx`'s `[data-add-task-field]` wrapper — not marked
 *     directly on the focusable element itself, because that element is
 *     `TaskTitleEditor` (task-title-editor.tsx), the identical shared
 *     component a Task's own inline rename and the detail view's editor
 *     also mount; marking it there would make every in-place rename a
 *     cycle stop too. This function resolves the wrapper's own one live
 *     focusable descendant instead — the ProseMirror `role="textbox"`
 *     div once Todo's store has opened, or nothing at all while the
 *     disabled placeholder `Input` is showing (`:not([disabled])`
 *     excludes it, so the affordance simply isn't a stop yet).
 *
 * A single `querySelectorAll` call across both selectors returns every
 * match in one tree-order list — exactly `TaskList`'s own rows (active
 * and completed, interleaved inline by `orderKey` since ROW-14) followed
 * by `AddTaskForm` (`todo-page.tsx`; issue #252 moved it to render after
 * the list, not above it), the two-producer union above being what keeps
 * that traversal accurate without this function hand-maintaining a third
 * list of its own.
 */
function rowNavTargets(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-row-nav-target], [data-add-task-field] [role="textbox"], [data-add-task-field] input:not([disabled])',
    ),
  );
}

/**
 * True once `target` sits inside an open Radix Dialog/AlertDialog/
 * Popover/DropdownMenu — every overlay this app renders (`Sheet`,
 * `Dialog` and `Popover` default to `role="dialog"`; `AlertDialog` sets
 * `role="alertdialog"` by hand, ui/alert-dialog.tsx's own header comment;
 * `DropdownMenu` defaults to `role="menu"`). `focus-next-row`/
 * `focus-previous-row` are `when: "always"` so a bare ArrowDown/ArrowUp
 * with nothing focused still lands on the first row — but "always" would
 * just as readily fire while a reader is arrowing through
 * `TaskSchedulePopover`'s own day-picker grid or `TaskCommandMenu`'s own
 * items, stealing focus out from under an open overlay the instant either
 * uses an arrow key for its own purpose. Neither is a text field, so
 * `isTypingTarget` alone doesn't catch this — this is the dialog/popover
 * gap this ticket's own brief asked to be found and handled rather than
 * silently left open.
 */
export function isInsideOverlay(target: EventTarget | null): boolean {
  return Boolean(
    target instanceof HTMLElement &&
      target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null,
  );
}

/**
 * True when an ArrowUp/ArrowDown pressed inside the "Add task" composer
 * should leave it and continue the cycle instead of moving the caret.
 *
 * The composer is a stop in `rowNavTargets()` above, but unlike every
 * other stop it is a real editor (`TaskTitleEditor`, a contenteditable),
 * so `isTypingTarget` correctly suppresses these two bindings there to
 * preserve native caret movement. Correct in isolation, and combined with
 * the composer being *in* the cycle it produced a focus trap: arrows could
 * enter the field from either side and never leave it, in either
 * direction — verified on screen, and invisible to the suite, because one
 * test asserting "arrows in a text field don't move row focus" and another
 * asserting "the cycle includes the Add-task field" both passed while
 * together describing the trap.
 *
 * Todoist has no equivalent problem: its own "Add task" affordance is a
 * plain button, so arrows were never needed there for a caret. The rule
 * that gives this app the same traversal without the trap is the one text
 * editors in a list conventionally use — leave only from the edge the key
 * points at, so a reader mid-text keeps native movement and a reader at
 * the boundary (including the ordinary empty composer) walks on.
 *
 * `j`/`k` are deliberately NOT accepted here even though they share these
 * bindings' `keys`: they are ordinary characters, and typing `jack` into
 * the composer must stay possible. `use-todo-keymap.ts`'s own caller gates
 * this on the arrow chords for that reason.
 */
export function canLeaveAddTaskField(
  target: EventTarget | null,
  direction: "next" | "previous",
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const field = target.closest("[data-add-task-field]");
  if (field === null) {
    return false;
  }
  const edge = direction === "next" ? "end" : "start";

  // A plain `<input>` stop (`rowNavTargets`'s own third selector) reports
  // its caret directly, with no Selection involved.
  if (target instanceof HTMLInputElement) {
    const caret = target.selectionStart;
    if (caret === null || caret !== target.selectionEnd) {
      return false;
    }
    return edge === "start" ? caret === 0 : caret === target.value.length;
  }

  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  // A highlighted span is not a caret at an edge — an arrow there should
  // collapse the selection natively rather than leave the field.
  if (!range.collapsed) {
    return false;
  }

  // Whether any text sits between the caret and the edge the key points
  // at, measured against the editable root's own contents rather than a
  // string-length guess — so multi-line content still arrows between its
  // own lines, and only the document boundary lets focus out.
  const probe = range.cloneRange();
  probe.selectNodeContents(target.isContentEditable ? target : field);
  if (edge === "start") {
    probe.setEnd(range.startContainer, range.startOffset);
  } else {
    probe.setStart(range.endContainer, range.endOffset);
  }
  return probe.toString().length === 0;
}

/**
 * Moves focus one stop along `rowNavTargets()`'s own live order — computed
 * fresh on every call, never cached, for the identical reason
 * `focusedTaskId()` above reads `document.activeElement` fresh rather
 * than tracking a second "selected" concept: a Task arriving mid-session
 * from another device must not leave a stale cycle behind.
 *
 * With nothing focused (`document.activeElement` isn't one of the
 * targets — including the ordinary case of it being `<body>`), the first
 * press in either direction lands on the first stop rather than doing
 * nothing (KBD-03's own first step, from a neutral click). Otherwise it
 * wraps at both ends, verified against Todoist's own measured traversal
 * (`flow6-KBD-04-todoist.json`: `wrapped: true`).
 *
 * A completed row's own stop now sits inline, in the same `<ul>` as an
 * active row's (ROW-14, parity-ledger.md) — `task-row.tsx`'s own `<li>`,
 * not a disclosure. The `<details>`-opening guard just below (`target.
 * closest("details:not([open])")`) is a leftover from when a completed
 * row lived behind exactly one collapsed `<summary>Completed (n)</summary>`
 * (this function had to open it before a real browser's `.focus()` — unlike
 * jsdom's looser default handling — would land inside it at all, since the
 * HTML spec makes a closed `<details>`'s non-`summary` content genuinely
 * unfocusable). Nothing in this app renders a row-nav target inside a
 * `<details>` any more, so the guard is inert today; left in place rather
 * than pulled, since this comment's own job is to describe the code
 * accurately, not to prune it.
 */
export function focusAdjacentRow(direction: "next" | "previous"): void {
  const targets = rowNavTargets();
  if (targets.length === 0) {
    return;
  }
  const active = document.activeElement;
  const currentIndex = active instanceof HTMLElement ? targets.indexOf(active) : -1;
  const nextIndex =
    currentIndex === -1
      ? 0
      : direction === "next"
        ? (currentIndex + 1) % targets.length
        : (currentIndex - 1 + targets.length) % targets.length;
  const target = targets[nextIndex] as HTMLElement;
  const collapsedDisclosure = target.closest("details:not([open])");
  if (collapsedDisclosure instanceof HTMLDetailsElement) {
    collapsedDisclosure.open = true;
  }
  target.focus();
}

/**
 * `focus-add-task` (`A`, KBD-01/KBD-06) — puts focus in the "Add task"
 * composer, revealing it first if it is currently the collapsed resting
 * row.
 *
 * Two paths, because the composer only has a live focusable descendant
 * (`[role="textbox"]`, or an enabled `<input>`) once it is already open:
 *
 *   - **Already open**: the identical `[data-add-task-field]
 *     [role="textbox"], [data-add-task-field] input:not([disabled])`
 *     selector `rowNavTargets()` folds into its own three-selector query
 *     finds a live match, and this focuses it directly — no event round
 *     trip, and critically no call into `add-task-form.tsx`'s own reveal
 *     path, which would otherwise treat an already-open composer as a
 *     fresh one and clear whatever the reader had already typed (this
 *     ticket's own acceptance: `A` on an open composer must focus it
 *     WITHOUT collapsing or clearing it).
 *   - **Collapsed**: the selector matches nothing, because the resting
 *     row is a bare `<button>` (`add-task-form.tsx`'s collapsed branch),
 *     not a textbox or input — this used to make `field?.focus()` a
 *     silent no-op (issue #260's Defect 2: pressing `A` did nothing once
 *     the composer became collapsed-by-default, and nothing in the suite
 *     caught it, because every existing `A`-key test hand-built a
 *     `[data-add-task-field][role="textbox"]` the real collapsed
 *     component never renders). `add-task-form.tsx` owns `open` as
 *     private `useState` with no external door onto it, so this
 *     dispatches `FOCUS_ADD_TASK_EVENT` instead — the identical
 *     document-level fan-in `OPEN_SCHEDULE_EVENT`/`OPEN_COMMAND_MENU_EVENT`
 *     above use to reach into a component this module holds no reference
 *     to.
 *
 * This function no longer assumes its selector "stays in sync" with
 * whatever `add-task-form.tsx` renders — a previous version of this
 * comment made exactly that claim, and it is exactly the assumption
 * Defect 2 broke. The fast path above only ever fires when that
 * assumption happens to hold (the composer is already open); the event
 * path is what covers the case where it doesn't, without needing the two
 * files to agree on a shared selector at all.
 */
export function focusAddTaskField(): void {
  const field = document.querySelector<HTMLElement>(
    '[data-add-task-field] [role="textbox"], [data-add-task-field] input:not([disabled])',
  );
  if (field !== null) {
    field.focus();
    return;
  }
  document.dispatchEvent(new CustomEvent(FOCUS_ADD_TASK_EVENT));
}

// Symbols where Shift is already baked into `event.key` (Shift+/ reports
// key `"?"`, never `"/"` plus a separate shift flag) — `use-todo-
// keymap.ts`'s own chord builder must not also prepend `shift+` for these,
// or `?` would build as `"shift+?"` and never match this table's `"?"` row.
const BAKED_SHIFT_KEYS = new Set([
  "?",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "{",
  "}",
  "|",
  ":",
  '"',
  "<",
  ">",
  "~",
]);

/** Builds the normalised chord string for a `KeyboardEvent`, matching this module's own `keys` grammar — the one place both `use-todo-keymap.ts` (matching) and any test exercising it build this string, so the two can never drift apart. */
export function chordFor(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): string {
  // Lower-cased unconditionally. This carried a ternary whose two branches
  // were byte-identical — presumably a half-finished thought about treating
  // single characters differently from named keys like "Escape". They do not
  // need different treatment: `toLowerCase()` leaves a named key alone as
  // far as chord matching is concerned, because every chord in the table
  // spells those keys in lower case too.
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  const shift = event.shiftKey && !BAKED_SHIFT_KEYS.has(event.key);
  return `${mod ? "mod+" : ""}${shift ? "shift+" : ""}${key}`;
}

const MODIFIER_DISPLAY: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
};

const KEY_DISPLAY: Record<string, string> = {
  backspace: "⌫",
  delete: "Delete",
};

function formatToken(token: string): string {
  return KEY_DISPLAY[token] ?? (token.length === 1 ? token.toUpperCase() : token);
}

function formatChord(chord: string): string {
  if (chord.includes(" ")) {
    return chord
      .split(" ")
      .map((token) => formatToken(token))
      .join(" then ");
  }
  const parts = chord.split("+");
  const key = parts[parts.length - 1] as string;
  const modifiers = parts.slice(0, -1);
  return modifiers.map((mod) => MODIFIER_DISPLAY[mod] ?? mod).join("") + formatToken(key);
}

/** Every rendered hint — the `?` overlay's own key column and `task-command-menu.tsx`'s legend — derives from this, never a hand-written string (issue #228's own brief: "Do not hand-write hint strings anywhere"). */
export function formatKeyHint(keys: string[]): string {
  return keys.map(formatChord).join(" or ");
}

/** `task-command-menu.tsx`'s own lookup: the hint for one binding id, or `null` if nothing wires that id — a menu item whose binding was deliberately left unimplemented (`V`/"Move to…", this module's own header comment) renders no hint at all, rather than a false one. */
export function hintForId(id: string): string | null {
  const binding = bindingById(id);
  return binding === undefined ? null : formatKeyHint(binding.keys);
}

export interface GroupedTodoKeyBinding {
  section: TodoKeySection;
  label: string;
  keys: string[];
}

/** `todo-keyboard-shortcuts-overlay.tsx`'s own source of rows — merges `quick-find`/`quick-find-global` (and any future split binding sharing a section+label) back into one display row, grouped by section in the order sections first appear in `TODO_KEY_BINDINGS`. */
export function groupedBindingsBySection(): {
  section: TodoKeySection;
  rows: GroupedTodoKeyBinding[];
}[] {
  const sections: TodoKeySection[] = [];
  const rowsBySection = new Map<TodoKeySection, Map<string, GroupedTodoKeyBinding>>();

  for (const binding of TODO_KEY_BINDINGS) {
    if (!rowsBySection.has(binding.section)) {
      sections.push(binding.section);
      rowsBySection.set(binding.section, new Map());
    }
    const rows = rowsBySection.get(binding.section) as Map<string, GroupedTodoKeyBinding>;
    const existing = rows.get(binding.label);
    if (existing === undefined) {
      rows.set(binding.label, {
        section: binding.section,
        label: binding.label,
        keys: [...binding.keys],
      });
    } else {
      existing.keys.push(...binding.keys);
    }
  }

  return sections.map((section) => ({
    section,
    rows: [...(rowsBySection.get(section) as Map<string, GroupedTodoKeyBinding>).values()],
  }));
}
