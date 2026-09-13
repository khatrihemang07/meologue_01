/**
 * The shared Task title editor — issue #225. Todoist's own reference
 * (`docs/reference/todoist/quick-add.md`, `row-and-detail.md` §2,
 * `lifecycle.md`) establishes that a Task's title is edited by **one**
 * component in every place it appears: `[contenteditable=true]`,
 * `role="textbox"`, `aria-label="Task name"`, `class="tiptap ProseMirror"`
 * — identical in the Quick Add composer and in the detail view's edit
 * mode (DET-06). This file is that component.
 *
 * **Why ProseMirror, not a plain `<input>`.** Gate A (issue #225's own
 * GitHub comment, `quick-add.md` § "the one fact that decides the
 * implementation") measured a recognised natural-language match as an
 * `inline-block` span carrying 4px of horizontal padding — 32.31px wide
 * recognised against 24.31px withdrawn. It occupies real width, so the
 * glyphs after it physically shift when recognition fires. A
 * transparent-text `<input>` with a highlight layer painted behind it
 * (this app's own pre-#225 `add-task-form.tsx`) can recolour text but
 * cannot move it — only a real contenteditable with an inline-block span
 * can. The repo already ships ProseMirror for the Composer
 * (`composer-editor.ts`), so building a second contenteditable by hand
 * here — reimplementing IME handling, selection and inline decorations,
 * all things a bespoke editor gets subtly wrong — would be the more
 * expensive and more fragile choice for no dependency saved.
 *
 * **Why this schema, not `entrySchema`.** A Task title is one line, full
 * stop — Todoist's own composer treats `Shift+Enter` as *submit*, not
 * "insert a newline" (QA-19), and nothing in the reference ever shows a
 * second line inside a title. `entrySchema` (entry-schema.ts) models a
 * whole Entry: paragraphs, lists, checkboxes, References — none of which
 * a title can ever contain. `taskTitleSchema` below is the smallest
 * schema that is still genuinely ProseMirror: `doc` holds `text*`
 * directly, with no block node for a newline to split into at all, so a
 * multi-line title isn't merely discouraged by a keymap, it is
 * structurally impossible to create. That is also what keeps this
 * component's own bundle weight to just the ProseMirror runtime
 * (`lazy-task-title-editor.ts`'s own header comment has the bundle
 * numbers) rather than the whole of `entrySchema`'s node/mark set.
 *
 * **The seam for #226.** Recognition (the parse, the highlighted span,
 * the two-step Backspace withdrawal QA-04/QA-05 describe) is deliberately
 * NOT built here — issue #225's own brief reserves it for #226. What this
 * file guarantees instead is the attachment point: `extraPlugins`, spliced
 * into this view's own plugin list *before* `keymap(baseKeymap)` (see
 * `buildTitlePlugins` below). A decoration plugin reads `state.doc`/
 * `state.selection` directly — it needs no caret-offset prop threaded in
 * from outside the way `add-task-form.tsx`'s pre-#225 backdrop needed
 * `caretOffset` state, because it lives inside the same `EditorState` the
 * decorations are drawn against. Registering before `keymap(baseKeymap)`
 * is load-bearing, not incidental: a plugin's own `handleKeyDown` for
 * Backspace has to be asked before `baseKeymap`'s ordinary Backspace, the
 * identical "so `listKeymap` wins" ordering `composer-editor.ts`'s own
 * `buildComposerPlugins` documents for the identical reason.
 *
 * **Why no test here mounts `<TaskTitleEditor>`.** `composer.tsx`'s own
 * header comment already recorded this limitation for the Composer's
 * `EditorView`: jsdom implements no `Range`, no `Selection`, and no
 * meaningful `getBoundingClientRect`, so a ProseMirror view "cannot
 * usefully mount in it, let alone be typed into." Every caller of this
 * component mocks the module in its own test file instead (the same
 * "mock exactly the piece that needs a real browser" split
 * `entry-store-layout.tsx` gets mocked for in `todo-sidebar.test.tsx`
 * and `chat-shell-layout.test.tsx`, for the unrelated reason that one
 * needs a real SqliteDriver). Real typing, IME and caret behaviour belong
 * in `apps/e2e`, against a real browser, exactly as `composer.tsx`'s own
 * comment prescribes for the Composer.
 */
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { Fragment, Schema, Slice } from "prosemirror-model";
import { EditorState, Plugin, Selection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { QuickAddAutocompleteListbox } from "@/components/todo/quick-add-autocomplete-listbox";
import type { AutocompleteState, QuickAddAutocompleteOptions } from "@/lib/quick-add-autocomplete";
import {
  closeAutocomplete,
  quickAddAutocompletePlugin,
  quickAddAutocompletePluginKey,
} from "@/lib/quick-add-autocomplete";
import { cn } from "@/lib/utils";

/**
 * The smallest schema that is still a real ProseMirror document: `doc`
 * holds inline `text*` directly, with no paragraph (or any other block)
 * node for a newline to split into. Exported so #226's decoration plugin
 * (and any test that wants to build a title `Node` directly, the way
 * `composer-editor.test.ts` builds `entrySchema` nodes without mounting a
 * view) can type against the identical schema this editor actually runs.
 */
export const taskTitleSchema = new Schema({
  nodes: {
    doc: { content: "text*" },
    text: { inline: true },
  },
});

/** A title `Node` seeded with `text` — empty text becomes an empty `doc`, never a zero-length text node (ProseMirror disallows those outright). */
export function titleDocFromText(text: string): PMNode {
  return taskTitleSchema.node("doc", null, text.length === 0 ? [] : [taskTitleSchema.text(text)]);
}

/** The plain text a title document holds — the inverse of `titleDocFromText`, and all `dispatchTransaction`/the commit keymap below ever need to hand back to a caller. */
export function titleTextFromDoc(doc: PMNode): string {
  return doc.textContent;
}

/**
 * Collapses a paste to one line. Clipboard HTML with block structure
 * (a copied paragraph, a multi-line plain-text paste) has nowhere to go
 * in a schema with no block node at all — left to ProseMirror's own
 * default parsing, the block boundaries would simply vanish and
 * concatenate two words with no separator between them ("line onetwo",
 * not "line one two"). `textBetween`'s own `blockSeparator` argument is
 * exactly the tool for turning "a boundary the schema can't represent"
 * into "a space," which is what a reader pasting multi-line text into a
 * single-line field would actually want.
 */
function transformPasted(slice: Slice): Slice {
  const text = slice.content.textBetween(0, slice.content.size, " ", " ");
  if (text.length === 0) {
    return Slice.empty;
  }
  return new Slice(Fragment.from(taskTitleSchema.text(text)), 0, 0);
}

/**
 * Shown only over a genuinely empty document — a plain decoration widget,
 * not a native `placeholder` attribute (a contenteditable root has no
 * such rendering of its own; `composer-editor.ts`'s own `placeholderPlugin`
 * makes the identical choice for the same reason).
 *
 * **This is live, and its own older comment saying otherwise was wrong.**
 * That comment read "nothing exercises this today", on the grounds that a
 * rename always seeds real content and the add field was not yet built on
 * this editor. The second half stopped being true: `add-task-form.tsx`
 * mounts this component with `value=""` and `placeholder="Add a Task"`, so
 * the add field renders this widget every time the list is not being typed
 * into — the single most visible instance of it in the app. The claim was
 * left standing long enough to be believed, which is why it is corrected
 * here rather than deleted.
 *
 * The size is the add row's own token, not the editor's (`index.css`'s
 * `--td-add-task-font-size`, 14px, whose comment carries the full
 * reasoning): Todoist rests its "+ Add task" affordance at 14px and only
 * shows the 16px title scale once the composer is open, and this app has
 * no open/closed distinction yet (NAV-12), so the placeholder is where that
 * resting size has to live. Deliberately NOT a hardcoded `text-sm` beside
 * the token — that is the dead-token defect issue #251 spent a ticket
 * removing from the very component this widget renders inside.
 *
 * The two remaining callers never see it: `task-row-content.tsx` and
 * `task-detail-view.tsx` both seed a Task's existing content, so their
 * documents are never empty and this decoration never renders there.
 */
function placeholderPlugin(text: string | undefined): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (text === undefined || state.doc.content.size > 0) {
          return DecorationSet.empty;
        }
        const widget = document.createElement("span");
        // NAV-10: the placeholder's own token, not `text-muted-foreground`.
        // That token paints every muted label on the Todo surface, and only
        // this widget was measured (rgb(128,128,128) in Todoist against
        // rgb(204,204,204) here). index.css's `--td-add-task-placeholder`
        // carries the dark-theme reading and leaves light unchanged.
        widget.className =
          "pointer-events-none select-none text-[length:var(--td-add-task-font-size)] text-[color:var(--td-add-task-placeholder)]";
        widget.textContent = text;
        return DecorationSet.create(state.doc, [Decoration.widget(0, widget)]);
      },
    },
  });
}

export interface TaskTitleEditorProps {
  /** The title's starting text — read once, at mount, to seed this editor's own document. Not resynced on later prop changes: every caller mounts this component fresh (inside a `<Suspense>`, behind its own "am I editing this title right now" state) exactly when activation happens, so "value at mount" already means "value at the moment editing began." */
  value: string;
  /** Fires on every transaction that changes the document — the live text, for a caller that wants to mirror it (a submit button's disabled state, say). Not required: a caller that only cares about the committed result can omit it entirely. */
  onChange?: (value: string) => void;
  /** Enter, Shift+Enter, or (unless `commitOnBlur` is `false`) losing focus — the current text, trimmed by nobody but the caller: `task-detail-view.tsx`'s own pre-#225 `commitTitle` already owned the "trim, then compare against the original" decision, and this component keeps that split rather than duplicating it. */
  onCommit: (value: string) => void;
  /** Escape — the caller's job is to discard the draft (unmount this editor and show the display element again), exactly as `task-detail-view.tsx`'s pre-#225 Escape handler already reverted its own `title` state without committing. */
  onCancel: () => void;
  /** Defaults to `"Task name"` — Todoist's own measured `aria-label`, identical in the composer and the detail view (DET-06, this file's own header comment). Only a caller with a genuinely different accessible name (none of this ticket's three call sites need one) should override it. */
  ariaLabel?: string;
  placeholder?: string;
  /** Defaults to `true`. Off for a caller that mounts this editor without wanting focus stolen immediately — none of this ticket's call sites do that today, but a future one might. */
  autoFocus?: boolean;
  /** Defaults to `true`. `task-detail-view.tsx`'s pre-#225 title already committed on blur (clicking away from an in-progress rename saves it, matching `project-view.tsx`'s identical `commitRename` convention) — set `false` only for a caller that wants blur to discard instead, which no call site here needs. */
  commitOnBlur?: boolean;
  className?: string;
  /**
   * The attachment point issue #226's recognition-decoration plugin lands
   * on. Spliced into this view's own plugin list *before*
   * `keymap(baseKeymap)` (this file's own header comment on why the order
   * is load-bearing) — read once, at mount, exactly like `value` above:
   * a caller that needs its own plugin to react to later prop changes
   * reaches for that plugin's own `PluginKey`/`apply`, not a new array
   * identity here.
   */
  extraPlugins?: Plugin[];
  /**
   * Enables the `#project` / `@label` autocomplete popup (issue #226's own
   * second half, `quick-add-autocomplete.ts`'s header comment carries the
   * Todoist reference) when supplied; omitted entirely, this editor behaves
   * exactly as it did before the popup existed. Read once at mount, same as
   * `extraPlugins` — but unlike `extraPlugins`, the object itself is
   * re-read on every render into a ref (below), so `getProjects`/
   * `getLabels`/`onCreateProject`/`onCreateLabel` stay live even though
   * whether the FEATURE is on at all is still a mount-time seed. A caller
   * builds this the same way `add-task-form.tsx` already builds
   * `quickAddRecognitionPlugin`'s own options: a ref holding the live
   * Project/Label lists, read through a closure.
   */
  autocomplete?: QuickAddAutocompleteOptions;
  /**
   * Fires whenever the autocomplete popup opens or closes. Exists for
   * exactly one reason today: `task-detail-view.tsx`'s own `dismissGuardRef`
   * (its header comment on DET-15) used to call `requestCancelEditing()`
   * on ANY Escape while its editor is active, with no way to know a popup
   * from THIS component just wanted Escape for itself — a caller sitting
   * inside a Radix `Dialog` reads this into a ref to gate that guard shut
   * while a popup is open.
   */
  onAutocompleteOpenChange?: (open: boolean) => void;
  /**
   * An imperative escape hatch `closeAutocomplete` (this module's own
   * `quick-add-autocomplete.ts` export) — needed because a caller sitting
   * inside a Radix `Dialog` cannot simply let Escape fall through to this
   * editor's own `handleKeyDown` and trust it to close the popup.
   * `Dialog.Content`'s own `onEscapeKeyDown` fires from a listener bound at
   * `document`, capture phase; a browser always runs a capture-phase
   * listener on an ANCESTOR before any listener bound directly to a
   * DESCENDANT target, so that caller's own guard is asked, and can call
   * `event.preventDefault()` to keep Radix from closing its whole Dialog,
   * strictly before this editor's own keydown handling ever sees the same
   * event. Once `event.preventDefault()` has been called by ANYONE earlier
   * in that same event's lifecycle, `prosemirror-view`'s own dispatch gate
   * (`eventBelongsToView`, `dist/index.js`) silently refuses to run this
   * view's `handleKeyDown` at all for it — proven directly, not reasoned
   * about, while wiring this into `task-detail-view.tsx`: a bare
   * `TaskTitleEditor` (no Dialog ancestor) closed its own popup on Escape
   * exactly as `task-title-editor.test.tsx` already covers, but the
   * identical keystroke through the real `Dialog`-wrapped `TaskDetailView`
   * did not, because Radix's own capture-phase `preventDefault()` had
   * already run. `view.dispatch()` is a plain method call, not a DOM
   * event — it is not subject to that gate at all — so a caller's OWN
   * capture-phase handler can call this function directly, in the same
   * synchronous tick it calls its own `event.preventDefault()`, and the
   * popup closes for real regardless of what already happened to the
   * event. Populated with a real function once this editor mounts (only
   * when `autocomplete` was supplied at all), and reset to `null` on
   * unmount — a caller invokes it unconditionally; it is a no-op once no
   * popup is open (`closeAutocomplete` itself is idempotent, `quick-add-
   * autocomplete.ts`'s own `apply()` returns `previous` unchanged from a
   * `"close"` meta once state is already `null`).
   */
  closeAutocompleteRef?: React.RefObject<(() => void) | null>;
}

/**
 * Every plugin this editor's `EditorView` needs, in the order that makes
 * the commit/cancel keymap and (once #226 lands) a decoration plugin's own
 * key handling take priority over `baseKeymap`'s ordinary bindings —
 * `composer-editor.ts`'s `buildComposerPlugins` documents the identical
 * "plugins earlier in this array are asked first" mechanism this relies
 * on.
 *
 * Exported for the identical reason `composer-editor.ts` exports
 * `buildComposerPlugins`: a test that wants to prove `Mod-z`/`Mod-Shift-z`
 * actually undo/redo typed text needs the REAL plugin list this editor
 * mounts with — building an ad hoc `[history(), keymap({...})]` array by
 * hand in a test would only prove `prosemirror-history` itself works, not
 * that this file remembers to register it (`task-title-editor.test.tsx`'s
 * own "history" suite is exactly that regression test).
 */
export function buildTitlePlugins(options: {
  placeholder: string | undefined;
  extraPlugins: Plugin[];
  commit: () => void;
  cancel: () => void;
  /**
   * The `#`/`@` autocomplete plugin (`quick-add-autocomplete.ts`), when this
   * editor was given `autocomplete` options — placed ahead of `commitKeymap`
   * below, not inside `extraPlugins`, because `handleKeyDown` is asked of
   * plugins in array order (`ProseMirror`'s own `someProp`, first truthy
   * return wins) and `Enter`/`Tab`/`Escape` all need to reach this plugin
   * FIRST while a popup is open: `commitKeymap`'s own `Enter` would
   * otherwise commit the whole title out from under it, and its own
   * `Escape` would call `cancel()` instead of merely closing the popup.
   * This plugin's `handleKeyDown` returns `false` for all three whenever no
   * popup is open, so `commitKeymap` still runs normally the rest of the
   * time. **Escape here is only half the story** — `TaskTitleEditor`'s own
   * header comment on the Radix trap explains the other half, which this
   * function cannot reach: a `Dialog`'s own document-capture dismissal can
   * fire before this plugin ever sees the keystroke at all.
   */
  autocompletePlugin?: Plugin | null;
}): Plugin[] {
  const commitKeymap = keymap({
    // A title has nowhere for a newline to go (this file's own header
    // comment on `taskTitleSchema`), so Enter and Shift+Enter mean the
    // same thing here — unlike the Composer, where Shift+Enter is a
    // deliberate second meaning (`insertSoftBreak`, composer-editor.ts)
    // for a schema that actually has paragraphs to break. This also
    // matches QA-19: Todoist's own composer submits on Shift+Enter too.
    Enter: () => {
      options.commit();
      return true;
    },
    "Shift-Enter": () => {
      options.commit();
      return true;
    },
    Escape: () => {
      options.cancel();
      return true;
    },
  });
  // `todo-keymap.ts` also binds a global `z`/`Mod-z` chord ("undo-complete")
  // that undoes a Task's own last COMPLETION, not text — the two never
  // race, because that binding carries the default `allowInField: false`
  // (`use-todo-keymap.ts`'s own dispatch, untouched here) and so never
  // fires while focus sits inside this editor. That default is exactly
  // what leaves `Mod-z` free for `historyKeymap` below to mean "undo my
  // typing" whenever a title editor is focused; outside one, the same
  // chord means "undo my last completion" instead. Fixing the bug this
  // file's own header comment on `history()` describes is what makes that
  // split real rather than moot — with `undo` a no-op, `Mod-z` in a title
  // editor used to do nothing at all, so there was nothing here to
  // conflict with in the first place.
  const historyKeymap = keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
  });
  return [
    // A genuine pre-existing bug, not something #253's rename-capture work
    // introduced: `historyKeymap` above has always bound `undo`/`redo`, but
    // `history()` — the plugin that actually records the done/undone step
    // stacks those two commands read — was never registered anywhere in
    // this list. Both commands look up that state via a fixed plugin key
    // (`prosemirror-history`'s own `historyKey.getState`), which comes back
    // `undefined` with no `history()` plugin present, so `undo`/`redo` were
    // silent no-ops in every editor built on this component — the Add-a-
    // Task composer, a row's inline rename, and this view's own title, all
    // three. `composer-editor.ts`'s `buildComposerPlugins` registers
    // `history()` too (last in its own list, proof this project already
    // knows the plugin is needed here) — its own placement doesn't matter:
    // `historyKey.getState` is a lookup into `EditorState.plugins`, keyed
    // by plugin identity, not by array order, so `history()` only has to
    // be present somewhere in the list, not before or after any particular
    // keymap. It's placed first here anyway, ahead of the keymaps that
    // dispatch `undo`/`redo`, matching the usual ProseMirror convention
    // (most published examples register it before `keymap(baseKeymap)`)
    // rather than after, as `composer-editor.ts` happens to.
    history(),
    // Ahead of `commitKeymap` — this parameter's own doc comment above has
    // the full ordering reasoning.
    ...(options.autocompletePlugin ? [options.autocompletePlugin] : []),
    commitKeymap,
    historyKeymap,
    ...options.extraPlugins,
    keymap(baseKeymap),
    placeholderPlugin(options.placeholder),
  ];
}

/**
 * The shared Task title editor — this file's own header comment carries
 * the full rationale. Wired up imperatively, in refs, mirroring
 * `composer.tsx`'s own `EditorView` (that file's header comment gives the
 * general reasoning: ProseMirror owns its DOM once mounted, and fighting
 * that with React's reconciliation over the same nodes is exactly the
 * "passed every test and was wrong on screen" bug class ADR 0036 names).
 * Always rendered behind `LazyTaskTitleEditor` (`lazy-task-title-editor.ts`)
 * by every real caller — never imported statically from a route Todo's own
 * bundle budget has to answer for.
 */
export function TaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel = "Task name",
  placeholder,
  autoFocus = true,
  commitOnBlur = true,
  className,
  extraPlugins = [],
  autocomplete,
  onAutocompleteOpenChange,
  closeAutocompleteRef,
}: TaskTitleEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const listboxId = useId();

  // The "latest callback" ref pattern `composer.tsx`'s own header comment
  // names: the `EditorView` below is built once, in the mount effect, so
  // its own `handleKeyDown`/`dispatchTransaction`/`handleDOMEvents`
  // closures need a way to see this render's `onChange`/`onCommit`/
  // `onCancel` props without the view itself being torn down and rebuilt
  // (which would lose focus and undo history) every time a caller
  // re-renders for an unrelated reason.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const commitOnBlurRef = useRef(commitOnBlur);
  commitOnBlurRef.current = commitOnBlur;
  // `autocomplete`'s own doc comment: whether the feature is on at all is a
  // mount-time seed (below), but `getProjects`/`getLabels`/the create hooks
  // it carries stay live through this ref, the identical "read a ref
  // through a closure" shape `add-task-form.tsx`'s own `optionsRef` gives
  // `quickAddRecognitionPlugin`.
  const autocompleteRef = useRef(autocomplete);
  autocompleteRef.current = autocomplete;
  const onAutocompleteOpenChangeRef = useRef(onAutocompleteOpenChange);
  onAutocompleteOpenChangeRef.current = onAutocompleteOpenChange;

  // Drives the React-rendered listbox (`quick-add-autocomplete-listbox.tsx`)
  // — the one piece of state this otherwise fully-imperative component
  // keeps, because rendering a portal-free popup is something only React,
  // not a ProseMirror decoration, can do here. Kept in sync from
  // `dispatchTransaction` below, never written any other way.
  const [popupState, setPopupState] = useState<AutocompleteState | null>(null);

  // Mount-only: `value`, `ariaLabel`, `placeholder`, `autoFocus` and
  // `extraPlugins` are every one of them read exactly once, at
  // construction — this component's own prop doc comments explain why
  // each is a "seed," not a controlled value this effect needs to
  // resync on every change. Whether `autocomplete` was supplied AT ALL is
  // the identical kind of seed; only what it POINTS to (via
  // `autocompleteRef`) stays live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only, matching composer.tsx's own EditorView effect.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    function commit() {
      const view = viewRef.current;
      if (view !== null) {
        onCommitRef.current(titleTextFromDoc(view.state.doc));
      }
    }
    function cancel() {
      onCancelRef.current();
    }

    const autocompletePlugin =
      autocompleteRef.current !== undefined
        ? quickAddAutocompletePlugin(() => {
            // A non-null assertion would be sound here (this closure only
            // ever runs because the plugin above was only ever constructed
            // when `autocompleteRef.current` was defined at mount, and a
            // caller supplying `autocomplete` at all is what this whole
            // branch is gated on) — read fresh off the ref anyway, on
            // every call, so a later render's new `getProjects`/`getLabels`
            // closures are the ones actually consulted.
            return autocompleteRef.current as QuickAddAutocompleteOptions;
          })
        : null;

    const doc = titleDocFromText(value);
    const state = EditorState.create({
      schema: taskTitleSchema,
      doc,
      // Places the caret at the end of the seeded text, matching every
      // reader's own expectation on activating a rename: the cursor
      // lands where they'd naturally keep typing, not back at the start.
      selection: Selection.atEnd(doc),
      plugins: buildTitlePlugins({ placeholder, extraPlugins, commit, cancel, autocompletePlugin }),
    });

    const view = new EditorView(
      { mount: host },
      {
        state,
        attributes: (viewState) => {
          const popup =
            autocompletePlugin !== null ? quickAddAutocompletePluginKey.getState(viewState) : null;
          return {
            // `tiptap ProseMirror` is Todoist's own measured class pair
            // (DET-06) — `ProseMirror` is ProseMirror's own base class,
            // applied automatically underneath whatever `class` this
            // function returns (`composer.tsx`'s own comment on this exact
            // mechanism), so only `tiptap` needs adding here.
            class: cn("tiptap", className),
            // `qa-flow-QA-13-14.json`'s own recorded
            // `role_of_composer_while_open: "combobox"` — Todoist's own
            // field flips role the instant its popup opens.
            role: popup !== null && popup !== undefined ? "combobox" : "textbox",
            "aria-label": ariaLabel,
            "aria-multiline": "false",
            ...(popup !== null && popup !== undefined
              ? {
                  "aria-expanded": "true",
                  "aria-controls": listboxId,
                  "aria-activedescendant": `${listboxId}-option-${popup.activeIndex}`,
                }
              : {}),
            ...(placeholder !== undefined ? { placeholder } : {}),
          };
        },
        transformPasted,
        dispatchTransaction: (tr) => {
          const current = viewRef.current;
          if (current === null) {
            return;
          }
          const nextState = current.state.apply(tr);
          current.updateState(nextState);
          if (tr.docChanged) {
            onChangeRef.current?.(titleTextFromDoc(nextState.doc));
          }
          if (autocompletePlugin !== null) {
            const nextPopup = quickAddAutocompletePluginKey.getState(nextState) ?? null;
            setPopupState((previous) => {
              if (previous === nextPopup) {
                return previous;
              }
              if ((previous === null) !== (nextPopup === null)) {
                onAutocompleteOpenChangeRef.current?.(nextPopup !== null);
              }
              return nextPopup;
            });
          }
        },
        handleDOMEvents: {
          blur: () => {
            if (commitOnBlurRef.current) {
              commit();
            }
            return false;
          },
        },
      },
    );
    viewRef.current = view;
    if (autoFocus) {
      view.focus();
    }
    // `closeAutocompleteRef`'s own doc comment has the full reasoning:
    // populated only when this editor was actually given `autocomplete`
    // options (a `null` popup plugin has nothing worth an imperative
    // closer), and only ever with a plain `view.dispatch()` call — never
    // routed back through this view's own (potentially gated) DOM keydown
    // handling.
    if (closeAutocompleteRef && autocompletePlugin !== null) {
      closeAutocompleteRef.current = () => {
        closeAutocomplete(view);
      };
    }

    return () => {
      view.destroy();
      viewRef.current = null;
      setPopupState(null);
      if (closeAutocompleteRef) {
        closeAutocompleteRef.current = null;
      }
    };
  }, []);

  // `coordsAtPos` needs a live `EditorView` and returns viewport-relative
  // coordinates — offset against `hostRef`'s own bounding rect to anchor
  // the popup inside this component's own `position: relative` wrapper
  // below, rather than against the viewport directly. jsdom implements no
  // layout at all (`getBoundingClientRect`/`coordsAtPos` both return an
  // all-zero rect — this file's own header comment on why no test here
  // mounts a real browser), so this can only ever be verified in
  // `apps/e2e`; this ticket's own report says so plainly rather than
  // claiming a jsdom test proves real anchoring.
  function popupStyle(): React.CSSProperties {
    const view = viewRef.current;
    const host = hostRef.current;
    if (view === null || host === null || popupState === null) {
      return { display: "none" };
    }
    const coords = view.coordsAtPos(popupState.from);
    const hostRect = host.getBoundingClientRect();
    return {
      top: coords.bottom - hostRect.top,
      left: coords.left - hostRect.left,
    };
  }

  return (
    <div className="relative">
      <div ref={hostRef} />
      {popupState !== null && (
        <QuickAddAutocompleteListbox
          id={listboxId}
          sigil={popupState.sigil}
          options={popupState.options}
          activeIndex={popupState.activeIndex}
          style={popupStyle()}
          getOptionId={(index) => `${listboxId}-option-${index}`}
        />
      )}
    </div>
  );
}
