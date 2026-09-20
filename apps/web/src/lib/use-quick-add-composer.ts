import type { QuickAddOptions } from "@meologue/core";
import { parseQuickAdd } from "@meologue/core";
import { useRef, useState } from "react";
import { localDayKey } from "@/lib/local-day-key";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import { type QuickAddTaskFields, taskFieldsFromQuickAdd } from "@/lib/quick-add-task";
import { useSettingsStore } from "@/lib/settings";
import { quickAddRecognitionPlugin } from "@/lib/todo-quick-add-recognition";

export interface UseQuickAddComposerOptions {
  onAdd: (fields: QuickAddTaskFields) => void;
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
  /**
   * Fires once a commit actually added something — after `onAdd`, after
   * the field is cleared. Not fired for a blank/token-only line (the
   * identical "nothing to add" case `onAdd` itself is skipped for) — a
   * caller collapsing an inline row or closing a dialog on this callback
   * would otherwise do so on an Enter that added nothing.
   */
  onCommitted?: () => void;
}

export interface QuickAddComposer {
  value: string;
  setValue: (value: string) => void;
  /** Bump this to remount `LazyTaskTitleEditor` (`key={resetKey}`) — `task-title-editor.tsx` seeds its document once, at mount, and never resyncs from a later `value` prop (that file's own doc comment), so clearing after a commit means a fresh instance, not an imperative clear. */
  resetKey: number;
  /** `LazyTaskTitleEditor`'s own `value` prop for the *next* mount (`key={resetKey}`) — `""` after a plain commit/reset, or whatever `remount` last seeded it with. Not the live text (`value` above is): this is only read once, at the moment a fresh editor instance mounts. */
  seed: string;
  /** `LazyTaskTitleEditor`'s own `onCommit` — Enter, Shift+Enter, or a caller's own submit button all funnel through this. */
  commit: (text: string) => void;
  /** Forces a fresh editor instance seeded with `text` — the only way to change what's on screen, since `task-title-editor.tsx`'s own doc comment is explicit that a later `value` prop change is never resynced into an already-mounted document. `quick-add-dialog.tsx`'s "Remove date" is this hook's one caller today. */
  remount: (text: string) => void;
  /** `LazyTaskTitleEditor`'s own `extraPlugins` — a fresh array every render is fine; that prop is read once, at mount (task-title-editor.tsx's own doc comment). */
  extraPlugins: ReturnType<typeof quickAddRecognitionPlugin>[];
  /** `LazyTaskTitleEditor`'s own `autocomplete` prop. */
  autocomplete: {
    getProjects: () => readonly AutocompleteEntry[];
    getLabels: () => readonly AutocompleteEntry[];
    onCreateProject?: (name: string) => void;
    onCreateLabel?: (name: string) => void;
  };
  /** The live options (`now`/`smartDates`) this render's parse used — exposed so a caller previewing the parse (`quick-add-dialog.tsx`) reads the identical values `commit` itself will use, rather than recomputing its own `now`. */
  options: QuickAddOptions;
  /**
   * Non-null exactly while `MultiLinePasteDialog` should be open — the
   * pasted lines, verbatim, `TaskTitleEditor`'s own `onMultiLinePaste`
   * callback below populates this. A caller renders the dialog fed by
   * this and the three functions below; nothing else needs to know a
   * multi-line paste happened at all.
   */
  pendingPasteLines: readonly string[] | null;
  /** `TaskTitleEditor`'s own `onMultiLinePaste` prop. */
  onMultiLinePaste: (lines: string[]) => void;
  /** "Add N tasks" (the dialog's default): one Task per line, in the order pasted, each through `commit` — the identical path a normal Enter uses, called once per line rather than a second way to create a Task. */
  confirmSplitPaste: () => void;
  /** "Merge to single task": one Task, its title every pasted line joined with a single space — the exact text this field silently produced before #373, now an explicit, opt-in choice rather than the only outcome. */
  confirmMergePaste: () => void;
  /** Cancel, Escape, or an outside click on the dialog — creates nothing, discards the pending lines. */
  cancelPendingPaste: () => void;
}

/**
 * `add-task-form.tsx`'s pre-#260 `optionsRef`/`projectsRef`/`labelsRef`
 * pattern, unchanged: `todo-quick-add-recognition.ts`'s plugin and
 * `quick-add-autocomplete.ts`'s plugin both read these live, through a
 * closure, on every decoration/keystroke pass — a ref, not plain state,
 * because `extraPlugins`/`autocomplete` are themselves read only once, at
 * mount (`task-title-editor.tsx`'s own doc comments on both props).
 */
export function useQuickAddComposer(options: UseQuickAddComposerOptions): QuickAddComposer {
  const [value, setValue] = useState("");
  const [seed, setSeed] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [pendingPasteLines, setPendingPasteLines] = useState<readonly string[] | null>(null);
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);

  const optionsRef = useRef<QuickAddOptions>({ now: localDayKey(new Date()), smartDates });
  optionsRef.current = { now: localDayKey(new Date()), smartDates };

  const projectsRef = useRef<readonly AutocompleteEntry[]>(options.projects ?? []);
  projectsRef.current = options.projects ?? [];
  const labelsRef = useRef<readonly AutocompleteEntry[]>(options.labels ?? []);
  labelsRef.current = options.labels ?? [];

  const onAddRef = useRef(options.onAdd);
  onAddRef.current = options.onAdd;
  const onCommittedRef = useRef(options.onCommitted);
  onCommittedRef.current = options.onCommitted;

  function commit(text: string) {
    const opts = optionsRef.current;
    // The plain, undemoted parse of whatever the field currently holds —
    // deliberately not aware of the recognition plugin's own withdrawn
    // spans (those live inside the ProseMirror plugin's state, not here).
    const result = parseQuickAdd(text, opts);
    const fields = taskFieldsFromQuickAdd(text, result, opts);
    // A token-only line (typing just "tomorrow" with nothing else) parses
    // to empty `content` — silently doing nothing here mirrors
    // use-tasks.ts's own addTask/renameTask, both of which already treat
    // trimmed-empty as "nothing to add" rather than a Task with no words.
    if (fields.content.trim() === "") {
      return;
    }
    onAddRef.current(fields);
    setValue("");
    setSeed("");
    setResetKey((key) => key + 1);
    onCommittedRef.current?.();
  }

  function remount(text: string) {
    setValue(text);
    setSeed(text);
    setResetKey((key) => key + 1);
  }

  function onMultiLinePaste(lines: string[]) {
    setPendingPasteLines(lines);
  }

  function confirmSplitPaste() {
    const lines = pendingPasteLines;
    setPendingPasteLines(null);
    if (lines === null) {
      return;
    }
    // One `commit` call per line — the exact same path a normal Enter
    // takes, including its own "nothing to add" skip for a token-only
    // line (`commit`'s own comment above). Not a second way to create a
    // Task, per this ticket's own instruction.
    for (const line of lines) {
      commit(line);
    }
  }

  function confirmMergePaste() {
    const lines = pendingPasteLines;
    setPendingPasteLines(null);
    if (lines === null) {
      return;
    }
    commit(lines.join(" "));
  }

  function cancelPendingPaste() {
    setPendingPasteLines(null);
  }

  return {
    value,
    setValue,
    resetKey,
    seed,
    commit,
    remount,
    extraPlugins: [quickAddRecognitionPlugin(() => optionsRef.current)],
    autocomplete: {
      getProjects: () => projectsRef.current,
      getLabels: () => labelsRef.current,
      onCreateProject: options.onCreateProject,
      onCreateLabel: options.onCreateLabel,
    },
    options: optionsRef.current,
    pendingPasteLines,
    onMultiLinePaste,
    confirmSplitPaste,
    confirmMergePaste,
    cancelPendingPaste,
  };
}
