import type { QuickAddOptions, QuickAddSpan, Section } from "@meologue/core";
import { parseQuickAdd } from "@meologue/core";
import { useEffect, useRef, useState } from "react";
import { localDateTimeKey } from "@/lib/local-day-key";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import { type QuickAddTaskFields, taskFieldsFromQuickAdd } from "@/lib/quick-add-task";
import { useSettingsStore } from "@/lib/settings";
import {
  quickAddInsertedPlugin,
  quickAddRecognitionPlugin,
} from "@/lib/todo-quick-add-recognition";

/**
 * `web/01-anatomy.md`'s own captured pool — the title field's placeholder
 * rotates through natural-language quick-add examples on each fresh open,
 * never per keystroke. Kept to web's own four strings rather than also
 * building Android's separate "e.g. "-prefixed pool (`android/02-
 * anatomy.md`): both shells share this one hook, and specialising the
 * pool per platform is a real (if small) piece of unmeasured-against
 * work this ticket's own report flags as deferred, not silently done.
 */
const PLACEHOLDER_POOL: readonly string[] = [
  "Submit essay on AI by Thursday p1",
  "Join student sports club Tuesday p3",
  "Meet with tutor Friday at 3pm",
  "Confirm catering by Fri at noon",
];

export interface UseQuickAddComposerOptions {
  onAdd: (fields: QuickAddTaskFields) => void;
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
  /**
   * Issue #388 — threaded straight into `QuickAddOptions.activeProjectName`
   * (`optionsRef.current` below), the identical value `add-task-form.tsx`/
   * `quick-add-dialog.tsx` already forward to `QuickAddContent` for the
   * Project chip's own display text. Not a second "active project"
   * concept: what `/section` falls back to scoping against when no
   * `#project` token wins in the same line IS the view's ambient Project,
   * so this hook reuses that one value rather than asking a caller to
   * supply it twice under two different names.
   */
  ambientProjectName?: string | null;
  /**
   * Issue #388 — threaded straight into `QuickAddOptions.
   * sectionNamesByProject`, `undefined` in and `undefined` out. Unlike
   * `projects`/`labels` just above (which this hook always turns into a
   * real, possibly-empty `projectNames`/`labelNames` array once a caller
   * wires them at all — see `optionsRef.current` below), an empty `Map`
   * and "no lookup available" mean genuinely different things for
   * `/section` (`QuickAddOptions.sectionNamesByProject`'s own doc
   * comment): a caller with no Section data to offer yet should leave
   * this `undefined`, not synthesise an empty `Map`, or `/section` would
   * stop matching anything instead of staying permissive.
   */
  sectionNamesByProject?: ReadonlyMap<string, readonly string[]>;
  /**
   * Issue #388's remaining half — an on-demand fallback for whichever
   * Project the composer's own live text currently has "active"
   * (`resolveSectionNames`'s rule, `packages/core/src/quick-add/
   * parse-quick-add.ts`: a typed `#OtherProject` in the same line if one
   * won, else `ambientProjectName`) that ISN'T already covered by
   * `sectionNamesByProject` above. `todo-page.tsx`'s own doc comment on
   * building that Map is explicit that it only eagerly fetches the
   * AMBIENT Project's own Sections — typing `#OtherProject /` had no
   * Section list to offer either the parser or this popup. `ProjectStore.
   * listSections` (`use-projects.ts`) is a local SQLite read, not a
   * network round trip — this app's personal scale (`query-keys.ts`'s own
   * "a personal Project list is small") is exactly why fetching it lazily
   * here, keyed by whichever Project name the reader just typed, costs
   * nothing worth avoiding by instead fetching every Project's Sections
   * up front. Omitted entirely keeps `/section` scoped to only the
   * ambient Project, this hook's pre-#388 behaviour past that point.
   */
  listSections?: (projectId: string) => Promise<readonly Section[]>;
  /** Mirrors `onCreateProject`/`onCreateLabel` — `entry-store-layout.tsx`'s own `addSection(projectId, name)`, forwarded once this hook has resolved which Project is active. Omitted keeps the "Create" row inserting only the typed token, same as those two. */
  onCreateSection?: (projectId: string, name: string) => void;
  /**
   * Fires once a commit actually added something — after `onAdd`, after
   * the field is cleared. Not fired for a blank/token-only line (the
   * identical "nothing to add" case `onAdd` itself is skipped for) — a
   * caller collapsing an inline row or closing a dialog on this callback
   * would otherwise do so on an Enter that added nothing.
   */
  onCommitted?: () => void;
  /**
   * Whether this composer's own surface is currently open/expanded —
   * read only to advance `placeholder` below on a closed→open transition
   * (`web/01-anatomy.md`: "rotates through example strings on each fresh
   * open"), the same shape `quick-add-dialog.tsx`'s own pre-#374
   * reset-on-open effect already used for `composer.remount("")`.
   * Omitted entirely by a caller with no open/closed concept of its own
   * (a bare inline field, or a test) — `placeholder` then just stays on
   * the pool's first entry.
   */
  open?: boolean;
}

export interface QuickAddComposer {
  value: string;
  setValue: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  descriptionOpen: boolean;
  setDescriptionOpen: (open: boolean) => void;
  /** Bump this to remount `LazyTaskTitleEditor` (`key={resetKey}`) — `task-title-editor.tsx` seeds its document once, at mount, and never resyncs from a later `value` prop (that file's own doc comment), so clearing after a commit means a fresh instance, not an imperative clear. */
  resetKey: number;
  /** `LazyTaskTitleEditor`'s own `value` prop for the *next* mount (`key={resetKey}`) — `""` after a plain commit/reset, or whatever `remount` last seeded it with. Not the live text (`value` above is): this is only read once, at the moment a fresh editor instance mounts. */
  seed: string;
  /** `LazyTaskTitleEditor`'s own `onCommit` — Enter, Shift+Enter, or a caller's own submit button all funnel through this. */
  commit: (text: string) => void;
  /**
   * Forces a fresh editor instance seeded with `text` — the only way to
   * change what's on screen, since `task-title-editor.tsx`'s own doc
   * comment is explicit that a later `value` prop change is never
   * resynced into an already-mounted document. `quick-add-dialog.tsx`'s
   * "Remove date" is one caller; `quick-add-content.tsx`'s own wrapper
   * around `useDraftDateState`'s `onTextChange` is another.
   *
   * `insertedSpans` (issue #411, defect 3) — the span(s), within `text`,
   * that were written by a picker rather than typed; seeds the freshly-
   * mounted `quickAddInsertedPlugin`'s own initial state below, so the
   * recognition plugin renders them plain instead of as a detected
   * match. Defaults to none: every pre-#411 caller (a plain commit/reset,
   * "Remove date") means "nothing here was just inserted."
   */
  remount: (text: string, insertedSpans?: readonly QuickAddSpan[]) => void;
  /** `LazyTaskTitleEditor`'s own `extraPlugins` — a fresh array every render is fine; that prop is read once, at mount (task-title-editor.tsx's own doc comment). */
  extraPlugins: [
    ReturnType<typeof quickAddRecognitionPlugin>,
    ReturnType<typeof quickAddInsertedPlugin>,
  ];
  /** `LazyTaskTitleEditor`'s own `autocomplete` prop. */
  autocomplete: {
    getProjects: () => readonly AutocompleteEntry[];
    getLabels: () => readonly AutocompleteEntry[];
    onCreateProject?: (name: string) => void;
    onCreateLabel?: (name: string) => void;
    getSections?: (fullText: string) => readonly AutocompleteEntry[];
    onCreateSection?: (fullText: string, name: string) => void;
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
  /** This open's own rotated placeholder string — `UseQuickAddComposerOptions.open`'s own doc comment has the full reasoning. */
  placeholder: string;
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
  const [description, setDescription] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [seed, setSeed] = useState("");
  const [seedInsertedSpans, setSeedInsertedSpans] = useState<readonly QuickAddSpan[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [pendingPasteLines, setPendingPasteLines] = useState<readonly string[] | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);

  // Advances only on the closed→open transition, never per keystroke —
  // `options.open`'s own doc comment. `wasOpenRef`, not `[options.open]`
  // alone as the effect's whole condition, because a caller that never
  // passes `open` at all (it stays `undefined` every render) must not
  // re-fire this on every unrelated render either.
  const wasOpenRef = useRef(options.open ?? false);
  useEffect(() => {
    const isOpen = options.open ?? false;
    if (isOpen && !wasOpenRef.current) {
      setPlaceholderIndex((index) => (index + 1) % PLACEHOLDER_POOL.length);
    }
    wasOpenRef.current = isOpen;
  }, [options.open]);

  const projectsRef = useRef<readonly AutocompleteEntry[]>(options.projects ?? []);
  projectsRef.current = options.projects ?? [];
  const labelsRef = useRef<readonly AutocompleteEntry[]>(options.labels ?? []);
  labelsRef.current = options.labels ?? [];

  // Issue #388's remaining half — `listSections`'s own doc comment above
  // has the full reasoning for why this is fetched here, on demand, per
  // Project name, rather than up front by `todo-page.tsx`. Deliberately
  // NOT `@tanstack/react-query`: `listSections` is already a cheap local-
  // store read on its own (that option's own doc comment), so a bare
  // ref+state pair here is enough, and it avoids this hook — shared by
  // both `add-task-form.tsx` and `quick-add-dialog.tsx` — taking on a
  // `QueryClient` dependency that every one of its own existing tests
  // would then need a `QueryClientProvider` wrapper just to satisfy.
  // Keyed by lower-cased Project name, matching `sectionNamesByProject`'s
  // own key convention exactly (`mergeSectionNames` below relies on it).
  const fetchedSectionNamesRef = useRef<Map<string, readonly string[]>>(new Map());
  const inFlightSectionFetchRef = useRef<Set<string>>(new Set());
  const [sectionsFetchTick, setSectionsFetchTick] = useState(0);

  // The identical "which Project is active" rule `packages/core`'s own
  // `resolveSectionNames` applies (parse-quick-add.ts) — reusing
  // `parseQuickAdd` itself rather than a second, hand-rolled scan for a
  // `#project` token, so this can never disagree with what the parser
  // itself would resolve for the SAME text. Computed fresh every render,
  // same as everything else in this hook; `parseQuickAdd` is a cheap,
  // pure regex scan over a short title, and `quick-add-content.tsx`
  // already re-parses `value` once per render for its own preview, so
  // this is a second cheap parse, not a new class of cost.
  const typedProjectName = parseQuickAdd(value, {
    now: localDateTimeKey(new Date()),
    smartDates,
    projectNames: projectsRef.current.map((project) => project.name),
  }).projectName;
  const effectiveProjectName = typedProjectName ?? options.ambientProjectName ?? null;
  const effectiveProjectKey = effectiveProjectName === null ? null : effectiveProjectName.toLowerCase();

  const listSectionsOption = options.listSections;
  const callerSectionNamesByProject = options.sectionNamesByProject;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sectionsFetchTick is read only to re-run this effect once a fetch (or a local create) elsewhere changes what's already cached — it is a signal, not an input the fetch itself depends on.
  useEffect(() => {
    if (listSectionsOption === undefined || effectiveProjectKey === null) {
      return;
    }
    if (callerSectionNamesByProject?.has(effectiveProjectKey)) {
      return; // Already covered by the caller's own eager Map (the ambient Project, today).
    }
    if (
      fetchedSectionNamesRef.current.has(effectiveProjectKey) ||
      inFlightSectionFetchRef.current.has(effectiveProjectKey)
    ) {
      return;
    }
    const project = projectsRef.current.find(
      (candidate) => candidate.name.toLowerCase() === effectiveProjectKey,
    );
    if (project === undefined) {
      return;
    }
    inFlightSectionFetchRef.current.add(effectiveProjectKey);
    listSectionsOption(project.id)
      .then((sections) => {
        fetchedSectionNamesRef.current.set(
          effectiveProjectKey,
          sections.map((section) => section.name),
        );
      })
      .catch(() => {
        // Nothing recognised for this Project yet; the guard above lets a
        // later keystroke that lands on it again retry, since nothing was
        // ever written into `fetchedSectionNamesRef` on this path.
      })
      .finally(() => {
        inFlightSectionFetchRef.current.delete(effectiveProjectKey);
        setSectionsFetchTick((tick) => tick + 1);
      });
  }, [effectiveProjectKey, listSectionsOption, callerSectionNamesByProject, sectionsFetchTick]);

  // The caller's own eager Map, plus whatever this instance has fetched
  // on demand above — the caller's own entry always wins for a given key
  // (today, only ever the ambient Project), so a fresher on-demand fetch
  // never shadows it.
  function mergeSectionNames(
    base: ReadonlyMap<string, readonly string[]> | undefined,
    extra: ReadonlyMap<string, readonly string[]>,
  ): ReadonlyMap<string, readonly string[]> | undefined {
    if (base === undefined) {
      return undefined;
    }
    if (extra.size === 0) {
      return base;
    }
    const merged = new Map(base);
    for (const [key, names] of extra) {
      if (!merged.has(key)) {
        merged.set(key, names);
      }
    }
    return merged;
  }
  const mergedSectionNamesByProject = mergeSectionNames(
    callerSectionNamesByProject,
    fetchedSectionNamesRef.current,
  );

  // Issue #388: `projectNames`/`labelNames` are built from the identical
  // `projectsRef`/`labelsRef` the autocomplete popup already reads above —
  // no new prop needed for those two. `options.projects`/`options.labels`
  // default to `[]` the moment a caller wires either prop at all
  // (`add-task-form.tsx`/`quick-add-dialog.tsx` both destructure `projects
  // = []`/`labels = []`), so in every real caller this hook has, these are
  // always a real (possibly-empty) array, never `undefined` — "only the
  // composer supplies them" (this ticket's own brief) is true by
  // construction here, not by a conditional this hook has to get right.
  const optionsRef = useRef<QuickAddOptions>({ now: localDateTimeKey(new Date()), smartDates });
  optionsRef.current = {
    now: localDateTimeKey(new Date()),
    smartDates,
    projectNames: projectsRef.current.map((project) => project.name),
    labelNames: labelsRef.current.map((label) => label.name),
    activeProjectName: options.ambientProjectName ?? null,
    sectionNamesByProject: mergedSectionNamesByProject,
  };

  // `QuickAddAutocompleteOptions.getSections`'s own doc comment
  // (`quick-add-autocomplete.ts`) has the full reasoning for why this
  // takes the live document text rather than reading a ref: resolving
  // "the active Project" from that text, via `parseQuickAdd`, is exactly
  // `resolveSectionNames`'s own rule, reused rather than duplicated.
  function getSections(fullText: string): readonly AutocompleteEntry[] {
    if (mergedSectionNamesByProject === undefined) {
      return [];
    }
    const activeProjectName =
      parseQuickAdd(fullText, optionsRef.current).projectName ?? options.ambientProjectName ?? null;
    if (activeProjectName === null) {
      return [];
    }
    const sectionNames = mergedSectionNamesByProject.get(activeProjectName.toLowerCase());
    if (sectionNames === undefined) {
      return [];
    }
    // Section names, not Section objects, are all `sectionNamesByProject`
    // (the parser's own source of truth, `todo-page.tsx`'s own doc
    // comment) ever carries — `AutocompleteEntry`'s own header comment on
    // why nothing here reads past `id`/`name` is why a synthesised
    // name-as-id is safe: `selectAutocompleteOption` never reads
    // `entry.id` for anything but a React list key.
    return sectionNames.map((name) => ({ id: name, name }));
  }

  function onCreateSectionRow(fullText: string, name: string): void {
    const create = options.onCreateSection;
    if (create === undefined) {
      return;
    }
    const activeProjectName =
      parseQuickAdd(fullText, optionsRef.current).projectName ?? options.ambientProjectName ?? null;
    if (activeProjectName === null) {
      return;
    }
    const project = projectsRef.current.find(
      (candidate) => candidate.name.toLowerCase() === activeProjectName.toLowerCase(),
    );
    if (project === undefined) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    create(project.id, trimmed);
    // Optimistic local reflect: the real mutation behind `create`
    // (`addSection`) already invalidates the shared `["sections"]` query
    // cache for every OTHER reader (`query-keys.ts`'s own doc comment) —
    // this only keeps THIS composer instance's own popup/parser from
    // waiting on a re-fetch to recognise the very name it just inserted.
    const key = activeProjectName.toLowerCase();
    if (!callerSectionNamesByProject?.has(key)) {
      const existing = fetchedSectionNamesRef.current.get(key) ?? [];
      if (!existing.some((existingName) => existingName.toLowerCase() === trimmed.toLowerCase())) {
        fetchedSectionNamesRef.current.set(key, [...existing, trimmed]);
        setSectionsFetchTick((tick) => tick + 1);
      }
    }
  }

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
    onAddRef.current({
      ...fields,
      description: description.trim() === "" ? null : description,
    });
    setValue("");
    setDescription("");
    setDescriptionOpen(false);
    setSeed("");
    setSeedInsertedSpans([]);
    setResetKey((key) => key + 1);
    onCommittedRef.current?.();
  }

  function remount(text: string, insertedSpans: readonly QuickAddSpan[] = []) {
    setValue(text);
    setSeed(text);
    setSeedInsertedSpans(insertedSpans);
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
    description,
    setDescription,
    descriptionOpen,
    setDescriptionOpen,
    resetKey,
    seed,
    commit,
    remount,
    extraPlugins: [
      quickAddRecognitionPlugin(() => optionsRef.current),
      quickAddInsertedPlugin(seedInsertedSpans),
    ],
    autocomplete: {
      getProjects: () => projectsRef.current,
      getLabels: () => labelsRef.current,
      onCreateProject: options.onCreateProject,
      onCreateLabel: options.onCreateLabel,
      // `sectionNamesByProject`'s own doc comment: `undefined` in means
      // "no Section capability at all," which `getSections`
      // omitted entirely (not a function that always returns `[]`)
      // turns into "the `/` popup never mounts" — `quick-add-
      // autocomplete.ts`'s own `buildState` doc comment on why that's
      // the contract, not an empty listbox.
      getSections: mergedSectionNamesByProject === undefined ? undefined : getSections,
      onCreateSection: mergedSectionNamesByProject === undefined ? undefined : onCreateSectionRow,
    },
    options: optionsRef.current,
    pendingPasteLines,
    onMultiLinePaste,
    confirmSplitPaste,
    confirmMergePaste,
    cancelPendingPaste,
    // biome-ignore lint/style/noNonNullAssertion: `placeholderIndex % PLACEHOLDER_POOL.length` is always a valid index into a fixed, non-empty pool.
    placeholder: PLACEHOLDER_POOL[placeholderIndex % PLACEHOLDER_POOL.length]!,
  };
}
