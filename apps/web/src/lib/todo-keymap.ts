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
  {
    id: "quick-add",
    section: "General",
    label: "Add task",
    when: "always",
    keys: ["q"],
  },
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
  {
    id: "copy-link",
    section: "Edit task",
    label: "Copy link to task",
    when: "task-focused",
    keys: ["mod+shift+c"],
  },
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
  {
    id: "go-labels",
    section: "Navigate",
    label: "Open label…",
    when: "always",
    keys: ["g l"],
  },
  {
    id: "go-reporting",
    section: "Navigate",
    label: "Go to reporting",
    when: "always",
    keys: ["g a"],
  },
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

export const FOCUS_ADD_TASK_EVENT = "todo:focus-add-task";

export function focusedTaskId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  return active.closest("[data-task-id]")?.getAttribute("data-task-id") ?? null;
}

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
