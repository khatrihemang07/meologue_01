import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules } from "prosemirror-inputrules";
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
import { titleLinkSegments } from "@/lib/task-title-links";
import { cn } from "@/lib/utils";

/**
 * The smallest schema that is still a real ProseMirror document: `doc`
 * holds inline `text*` directly, with no paragraph (or any other block)
 * node for a newline to split into. Exported so #226's decoration plugin
 * (and any test that wants to build a title `Node` directly, the way
 * `composer-editor.test.ts` builds `entrySchema` nodes without mounting a
 * view) can type against the identical schema this editor actually runs.
 *
 * Issue #373 gives this editor its first mark ever — `link`, with an
 * `href` attribute — for typed `[text](url)`. Verified before landing:
 * none of the pre-#373 tests assert mark-emptiness, and `doc` needs no
 * explicit `marks` property of its own to allow it (`NodeSpec.marks`'
 * own default, per prosemirror-model: a node with inline content, which
 * `doc` has directly here, allows every mark in the schema unless told
 * otherwise). `inclusive: false` is what keeps typing right after a link,
 * at its own end boundary, from silently continuing the link — the same
 * property every rich editor gives a hyperlink mark and withholds from
 * `strong`/`em` (this schema has neither, but it's why a future one
 * shouldn't copy this default without thinking about it).
 */
export const taskTitleSchema = new Schema({
  nodes: {
    doc: { content: "text*" },
    text: { inline: true },
  },
  marks: {
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute("href") }),
        },
      ],
      toDOM: (mark) => ["a", { href: mark.attrs.href as string, rel: "noopener noreferrer" }, 0],
    },
  },
});

/**
 * A title `Node` seeded with `text` — empty text becomes an empty `doc`,
 * never a zero-length text node (ProseMirror disallows those outright).
 *
 * Issue #373: `Task.title` is stored as a plain string, unchanged — a
 * `[text](url)` link is stored as that literal markdown text, not as
 * separate mark metadata the storage layer would have to know about. This
 * is the "read" half of the round trip that keeps it that way: every seed
 * (a fresh rename, reopening the detail view, reloading the add field
 * after a remount) is re-scanned for the markdown link syntax and turned
 * back into a live mark here, so the mark surviving a save-then-reopen
 * cycle costs nothing but re-running this same parse — `titleTextFromDoc`
 * below is the inverse that makes the round trip whole.
 *
 * `titleLinkSegments` (`@/lib/task-title-links`) is where the actual
 * `[text](url)` matching lives — issue #398's read-only title renderer
 * (`task-title-text.tsx`) needs the identical split, so it moved out of
 * this file rather than being duplicated; that module's own header
 * comment explains why it isn't here.
 */
export function titleDocFromText(text: string): PMNode {
  if (text.length === 0) {
    return taskTitleSchema.node("doc", null, []);
  }
  const linkType = taskTitleSchema.marks.link;
  const nodes = titleLinkSegments(text).map((segment) =>
    segment.href === undefined
      ? taskTitleSchema.text(segment.text)
      : taskTitleSchema.text(segment.text, [linkType.create({ href: segment.href })]),
  );
  return taskTitleSchema.node("doc", null, nodes);
}

/**
 * The plain text a title document holds — the inverse of `titleDocFromText`,
 * and all `dispatchTransaction`/the commit keymap below ever need to hand
 * back to a caller. A `link`-marked run is written back out as
 * `[text](href)`, not as its bare display text: `doc.textContent` alone
 * would silently drop the href the moment a link left this editor, which
 * is exactly the "keeps stored data plain AND round-trippable" property
 * issue #373 asks for — the stored string carries everything the mark
 * carried, in the same syntax that produces it again on the way back in.
 */
export function titleTextFromDoc(doc: PMNode): string {
  const linkType = taskTitleSchema.marks.link;
  let result = "";
  doc.forEach((node) => {
    const linkMark = linkType.isInSet(node.marks);
    result +=
      linkMark !== undefined
        ? `[${node.text ?? ""}](${linkMark.attrs.href as string})`
        : (node.text ?? "");
  });
  return result;
}

/**
 * `[text](url)` -> a live `link` mark on `text`, with the whole `](url)`
 * run deleted along with the opening `[`. `composer-editor.ts`'s own
 * `markInputRule` is NOT reusable here (that file's module comment on why
 * a hand-written replacement exists at all): it takes exactly one capture
 * group and applies a mark to it verbatim, symmetric delimiters on both
 * sides. This rule has two groups feeding two DIFFERENT things — `text`
 * becomes the marked content, `url` becomes the mark's own `href` — and
 * the url has to be deleted outright, not merely trimmed off like a
 * delimiter pair, since none of it survives into the document itself
 * (`titleTextFromDoc` reconstructs it from the mark's `href` attr later,
 * not from anything left behind in the text).
 *
 * Fires on typing only, never on paste (issue #373's own asymmetry,
 * matching Todoist): `inputRules()`'s plugin only ever calls a rule from
 * `handleTextInput`, which a paste never goes through — `transformPasted`
 * below is a completely separate code path that only ever inserts plain
 * text, so a pasted `[text](url)` string is untouched, unaffected by this
 * rule entirely.
 *
 * Exported so a test can exercise it directly through its own `match`/
 * `handler` pair (`InputRule`'s `@internal`-tagged but runtime-real
 * properties — `composer-editor.test.ts`'s own header comment has the
 * full reasoning for why that's the seam, jsdom having no way to drive
 * `handleTextInput` itself) — `task-title-editor.test.tsx`'s own suite is
 * that test.
 */
export function linkInputRule(): InputRule {
  return new InputRule(/\[([^\]]+)\]\(([^)]+)\)$/, (state, match, start, end) => {
    const text = match[1];
    const href = match[2];
    if (text === undefined || href === undefined || text.trim() === "" || href.trim() === "") {
      return null;
    }
    const textOffset = match[0].indexOf(text);
    if (textOffset < 0) {
      return null;
    }
    const tr = state.tr;
    const textStart = start + textOffset;
    const textEnd = textStart + text.length;
    // Deletes the trailing `](url)` run whole — positions before `text`
    // are unaffected by this first deletion, so it's safe to do before
    // trimming the leading `[` next.
    if (textEnd < end) {
      tr.delete(textEnd, end);
    }
    if (textStart > start) {
      tr.delete(start, textStart);
    }
    const markEnd = start + text.length;
    tr.addMark(start, markEnd, taskTitleSchema.marks.link.create({ href }));
    // Without this, typing immediately after the closing `)` would carry
    // the link mark onto the next character too — `link`'s own
    // `inclusive: false` (this file's own doc comment on the schema)
    // already stops that for ordinary typing at the boundary, but the
    // input rule's own `addMark` call above sets a STORED mark for this
    // exact transaction that `inclusive` doesn't reach; this clears it.
    tr.removeStoredMark(taskTitleSchema.marks.link);
    return tr;
  });
}

/**
 * Collapses a paste to one line, UNLESS `getOnMultiLinePaste` is supplied
 * and the paste actually holds more than one real (non-blank) line — in
 * which case this defers to that callback instead and inserts nothing
 * (issue #373's "Add N tasks?" confirmation, `multiline-paste-dialog.tsx`).
 * A `Slice` transform can't open a dialog itself, so this is the seam that
 * hands the decision to a caller that can: `TaskTitleEditor`'s own
 * `onMultiLinePaste` prop, read live through a ref the same way every
 * other callback here is (this file's own "latest callback ref" comment).
 *
 * `undefined` (no callback supplied — every rename/detail-view caller,
 * which has no "create N tasks" concept to defer to) keeps this editor's
 * pre-#373 behaviour exactly: silently collapse to one line, regardless
 * of how many lines were pasted. Only a caller that opts in gets the
 * dialog at all.
 *
 * Clipboard HTML with block structure (a copied paragraph, a multi-line
 * plain-text paste) has nowhere to go in a schema with no block node at
 * all — left to ProseMirror's own default parsing, the block boundaries
 * would simply vanish and concatenate two words with no separator between
 * them ("line onetwo", not "line one two"). `textBetween`'s own
 * `blockSeparator` argument is exactly the tool for turning "a boundary
 * the schema can't represent" into a real line break, which is what lets
 * the two paths below tell a genuine multi-line paste apart from a single
 * line assembled out of several inline blocks.
 */
function transformPasted(getOnMultiLinePaste: () => ((lines: string[]) => void) | undefined) {
  return (slice: Slice): Slice => {
    const text = slice.content.textBetween(0, slice.content.size, "\n", "\n");
    if (text.length === 0) {
      return Slice.empty;
    }
    const onMultiLinePaste = getOnMultiLinePaste();
    if (onMultiLinePaste !== undefined) {
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length > 1) {
        onMultiLinePaste(lines);
        return Slice.empty;
      }
    }
    const collapsed = slice.content.textBetween(0, slice.content.size, " ", " ");
    return new Slice(Fragment.from(taskTitleSchema.text(collapsed)), 0, 0);
  };
}

function placeholderPlugin(text: string | undefined): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (text === undefined || state.doc.content.size > 0) {
          return DecorationSet.empty;
        }
        const widget = document.createElement("span");
        widget.className =
          "pointer-events-none select-none text-[length:var(--td-quick-add-placeholder-font-size)] text-[color:var(--td-quick-add-placeholder)]";
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
  /**
   * Issue #373: fires instead of the ordinary collapse-to-one-line paste
   * behaviour when a paste actually holds more than one non-blank line —
   * `transformPasted`'s own doc comment has the full reasoning for why a
   * `Slice` transform defers to this rather than deciding itself. Read
   * live through a ref, the same "latest callback" pattern every other
   * prop here uses, not a mount-time seed: unlike `extraPlugins`, nothing
   * about which callback is current needs to survive past the render that
   * supplied it.
   *
   * Omitted entirely by every rename/detail-view caller, which has no
   * "create N tasks from N lines" concept to defer to — only
   * `add-task-form.tsx`/`quick-add-dialog.tsx` (through
   * `use-quick-add-composer.ts`) supply this.
   */
  onMultiLinePaste?: (lines: string[]) => void;
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
    Enter: () => {
      options.commit();
      return true;
    },
    "Shift-Enter": () => {
      options.commit();
      return true;
    },
    // Issue #411: Ctrl+Enter/Cmd+Enter did nothing — a capture-phase
    // keydown logger showed the keystroke reaching this editor
    // `defaultPrevented: false`, so this was a missing binding, not a
    // swallowed event. `prosemirror-keymap`'s own `Mod-` shorthand
    // (verified against the installed 1.2.3 source, not assumed)
    // resolves to `Cmd-` on Mac and `Ctrl-` elsewhere, decided once at
    // that module's own import time from `navigator.platform` — so
    // `Mod-Enter` alone is enough for both, on a real browser. `Cmd-
    // Enter` is bound too, explicitly, because that per-platform
    // resolution is exactly what jsdom cannot exercise (`navigator.
    // platform` is `""` there, read as non-Mac, so `Mod-Enter` only ever
    // normalises to `Ctrl-Enter` in this suite): binding `Cmd-Enter`
    // directly — it always normalises to `Meta-Enter`, independent of
    // platform detection — is what makes Cmd+Enter provable by a jsdom
    // test at all, not just assumed correct from reading prosemirror-
    // keymap's source. On a real Mac the two bindings collide (both
    // normalise to `Meta-Enter`); harmless, since both call `commit()`.
    "Mod-Enter": () => {
      options.commit();
      return true;
    },
    "Cmd-Enter": () => {
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
    // Issue #373: `inputRules()` only ever hooks `handleTextInput`, a prop
    // no other plugin here defines, so its position relative to the
    // keymaps above carries no ordering risk the way `handleKeyDown`
    // registration order does — placed here, after `baseKeymap`, purely to
    // match `composer-editor.ts`'s own `buildComposerPlugins` precedent.
    inputRules({ rules: [linkInputRule()] }),
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
  onMultiLinePaste,
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
  const onMultiLinePasteRef = useRef(onMultiLinePaste);
  onMultiLinePasteRef.current = onMultiLinePaste;

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
            class: cn("tiptap", className),
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
        transformPasted: transformPasted(() => onMultiLinePasteRef.current),
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
