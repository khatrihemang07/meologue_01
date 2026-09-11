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
 * **Scope — only what has a real door.** `docs/reference/todoist/keyboard.md`
 * transcribes 80 shortcuts from Todoist's own overlay, unverified by
 * driving (that file's own header comment). This table carries a small
 * fraction of those 80 — only the ones with a target that already exists in
 * this app (issue #228's own brief: "do not invent bindings for surfaces
 * that do not exist yet"). Concretely, left out and why:
 *   - Every `O then …` binding (Productivity/notifications/user menu/
 *     settings/themes) — none of those five destinations exist in this app
 *     at all.
 *   - `G then H`, `G then A`, `G then /`, `G then L` (home, reporting, a
 *     section picker, a label picker) — no such destination or picker
 *     exists; `G then L` and label management generally are #229's, not
 *     this ticket's, per the brief.
 *   - `V` ("Move to…") — the one door onto it, `TaskCommandMenu`'s own
 *     "Move to…" submenu, is a Radix `DropdownMenu.Sub` with no controlled
 *     "open pre-expanded on this submenu" API; wiring `V` would mean either
 *     opening the same generic menu `.` already opens (indistinguishable
 *     from `.`, despite the specific label) or a real submenu-open
 *     refactor this ticket's scope doesn't reach. Left unimplemented rather
 *     than shipping a guess.
 *   - `E` (complete), `X` (multi-select), `Enter` (open task view), `M`
 *     (toggle sidebar), Quick Add's own token grammar (`#`, `@`, `P1`-`P4`,
 *     `!`, `{`) — either no real multi-select/sidebar-toggle surface exists
 *     to target, or (Quick Add's tokens) these are typed *text* the
 *     composer's own parser already recognises (`parseQuickAdd`), not
 *     single-keystroke chords this table has any business intercepting.
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
 * **Sequences.** `G then I/T/U/P/V` are the only two-key chords wired,
 * encoded as `"g i"` etc. (space-separated, lowercase) — `use-todo-
 * keymap.ts`'s own pending-prefix state machine treats any `keys` entry
 * containing a space as a sequence rather than a chord.
 */

/** Grouping only — matches `keyboard.md`'s own section headings, so a
 * reader can find a wired binding by looking for the same heading. Not
 * every section that document has appears here (see the header comment
 * above for the ones this table has nothing to put under). */
export type TodoKeySection = "General" | "Navigate" | "Edit task";

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
  // `T`/`D`/`Y` below all open the one sheet that actually has a Date, a
  // Deadline and a Priority control (`task-schedule-sheet.tsx`'s own header
  // comment: "The one place Date, Deadline and Priority are all
  // settable") — Todoist's own overlay lists three separate pickers, this
  // app has one surface that is all three, so all three keys open it.
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
];

export function bindingById(id: string): TodoKeyBinding | undefined {
  return TODO_KEY_BINDINGS.find((binding) => binding.id === id);
}

/**
 * The field guard — lifted verbatim from `task-quick-find.tsx`'s own
 * pre-#228 inline check (that file's own former header comment named the
 * exact same three conditions), exported so there is one answer rather
 * than two. The Quick Add field is a ProseMirror `contenteditable` div, not
 * an `<input>`/`<textarea>` (`task-title-editor.tsx`), which is why
 * `isContentEditable` — not a tag check — is what actually catches it.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  return Boolean(
    target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
  );
}

/** The custom event `use-todo-keymap.ts` dispatches for `command-menu` — `task-row.tsx` listens for it to open *its own* `TaskCommandMenu` when its `data-task-id` matches, rather than every row keeping a keydown handler of its own. */
export const OPEN_COMMAND_MENU_EVENT = "todo:open-command-menu";

export interface OpenCommandMenuDetail {
  taskId: string;
}

/** The Task a keyboard action should act on — whichever row's own focusable element (`data-task-id`, `task-row.tsx`) currently holds focus, or `null` if none does. Read fresh at fire-time rather than tracked in state: the DOM's own focus is already the single source of truth every row's tab order already relies on (`keyboard.md` §2's own tab-order findings). */
export function focusedTaskId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  return active.closest("[data-task-id]")?.getAttribute("data-task-id") ?? null;
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
