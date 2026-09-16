/**
 * The global Quick Add modal (issue #260 — NAV-07, QA-13/QA-15/QA-16/
 * QA-18, PRI-04, parity ledger). Opened from anywhere in Todo — the
 * sidebar's "Add task" button (`todo-sidebar.tsx`) and the `q` key
 * (`todo-keymap.ts`'s `quick-add` binding, driven live in `keyboard.md`'s
 * own "Quick Add (opened with Q for inspection only...)" capture) both
 * dispatch `OPEN_QUICK_ADD_EVENT`, which `todo-page.tsx` listens for and
 * turns into this dialog's own `open` state — the identical document-event
 * fan-in `OPEN_COMMAND_MENU_EVENT`/`OPEN_SCHEDULE_EVENT` already use
 * (`todo-keymap.ts`'s own doc comments), needed here because the sidebar
 * sits outside `EntryStoreLayout`'s Outlet and cannot call `handleAdd`
 * directly (`todo-sidebar.tsx`'s own header comment on that structural
 * split).
 *
 * **Geometry, from the one live-measured artifact this ticket has**
 * (`meologue-reference/todoist/live-audit-dom/quickadd-dialog-todoist.json`,
 * identity asserted `role="dialog"` `aria-label="Quick Add"`, dark theme):
 * 580×66px at rest, 580×97px once a date is recognised, radius 12px,
 * padding 16px on all four sides, border `1px solid rgb(61,61,61)`,
 * background `rgb(40,40,40)`, shadow `rgba(0,0,0,.2) 0 4px 8px`. Width,
 * padding, radius, border and background all read off
 * `--td-composer-*`/`--muted-foreground`-adjacent tokens `index.css`
 * already declares (QA-16's own "trap for whoever builds this": those
 * tokens existed with zero consumers before this file). Height is NOT
 * set explicitly anywhere below — 66px vs 97px is what the box model
 * already produces once the Remove-date row is conditionally rendered,
 * not a value this component chooses.
 *
 * **That 66→97px growth is now what this file does too (issue #264).**
 * Flow 12's round S1 (2026-09-13, `flow12-S1-QA-13-14-15-16-18-both.json`)
 * reported Todoist "no longer shrinks at rest", flat at 97px in both
 * states, and concluded the reference had drifted. **Round S2 the next
 * day overturned that** (`flow12-S2-verification-both.json`, both sides
 * driven in one session, ≥800ms settle on every read): Todoist reads
 * **580×66px at rest and 580×97px once text is present**, because its
 * Inbox/Date/Priority/Labels toolbar row is only rendered once the field
 * is non-empty — the original capture was right, and S1's "the reference
 * moved" was a bad reading. Two sources now agree against the flat
 * reading, so this file grows on text the same way.
 *
 * **The 66/97 arithmetic, worked from the box model, not guessed.** The
 * chrome outside the content is fixed by the tokens above and never
 * changes: `1 border + 16 padding + <content> + 16 padding + 1 border`,
 * i.e. 34px of chrome either way.
 * - **Rest** (66px): chrome (34) + a single content row of **32px**
 *   (`h-8`, the editor plus the dismiss button below, vertically
 *   centred) — the identical `h-8` idiom `add-task-form.tsx`'s own
 *   `EDITOR_BOX_CLASSES` already uses for its own editor row, not a
 *   fresh magic number.
 * - **Grown** (97px): chrome (34) + the same 32px editor row + a footer
 *   block that must total **31px** (97 − 34 − 32), against the original
 *   design's 53px (`12 mt-3 + 1 border-t + 12 pt-3 + 28 h-7 button`).
 *   Landed on `mt-1 (4) + border-t (1) + pt-0.5 (2) + h-6 "xs"-size
 *   buttons (24)` = 4 + 1 + 2 + 24 = **31px exactly** — the footer
 *   buttons shrink from `size="sm"` to `size="xs"` to make that number
 *   reachable with real Tailwind spacing rather than an arbitrary
 *   `h-[Npx]`.
 *
 * A dismiss (X) button sits in the editor row in both states — the
 * editor row's own height (32px) doesn't change between rest and grown,
 * so nothing in this file hides it once the footer appears. **QA-15:
 * that X is a plain close affordance, not a stand-in for Todoist's red
 * Ramble/dictate button.** meologue has no dictation feature; this file
 * deliberately does not add one, stub one, or add a disabled placeholder
 * for one — QA-15 stays a known open item in the parity ledger rather
 * than being papered over with a fake control.
 *
 * **Footer — the recorded subset, not the full described one.**
 * `quick-add.md` describes six footer controls (More actions, Select
 * project, Set date, Set priority, Add labels, then Cancel/Add task);
 * the live DOM capture only pins down four by `aria-label` — More
 * actions, Remove date, Cancel, Add task (`qa15_footerButtons` in the
 * artifact above) — the other three were never confirmed to carry an
 * aria-label at all (QA-15's own "Not established" caveat). This dialog
 * builds exactly the four that are actually pinned down, in the order
 * QA-18 measured (`Tab` from the title lands on More actions first).
 * Project/priority/label PICKERS are a different ticket's surface
 * (`task-schedule-popover.tsx`) and are not duplicated here; PRI-04's own
 * pill is shown instead, using whatever priority the shared parse already
 * recognised, since the composer already carries that information whether
 * or not a dedicated "Set priority" button exists yet.
 *
 * **Escape vs. the `#`/`@` popup — issue #261, the Radix trap
 * `task-title-editor.tsx` names but cannot fix alone.** Radix's
 * `DismissableLayer` (what `Dialog.Content` is built on) wires its own
 * Escape handler on `document`, capture phase, BEFORE the contenteditable's
 * own bubble-phase keydown handler ever runs (confirmed against
 * `@radix-ui/react-dismissable-layer`'s own source: `addEventListener(...,
 * { capture: true })`, and its handler calls `onDismiss()` — closing this
 * dialog — unless the consumer's own `onEscapeKeyDown` called
 * `preventDefault()` first). **What actually gates ProseMirror's own
 * handling is `defaultPrevented`, not propagation** — `prosemirror-view`'s
 * own dispatch gate (`eventBelongsToView`) refuses to run this view's
 * `handleKeyDown` at all once ANYONE earlier in the same event's lifecycle
 * called `event.preventDefault()`, capture-phase included. An earlier
 * version of this comment argued the opposite — that because
 * `DismissableLayer` "never calls `stopPropagation()`", the keystroke
 * would still reach the editor's own bubble handler after `Content`'s own
 * `preventDefault()` ran. That is exactly backwards: propagation
 * continuing is irrelevant when the gate checked is `defaultPrevented`,
 * and `Content`'s own `preventDefault()` (below) trips that gate before
 * `quick-add-autocomplete.ts`'s own `handleKeyDown` ever runs — Escape did
 * nothing at all, to either layer, which is issue #261's exact symptom.
 * The fix is the same one `task-detail-view.tsx`'s `dismissGuardRef`
 * already ships (`8eafad9`): don't trust the same gated keydown to close
 * the popup — call `closeAutocompleteRef.current?.()` directly.
 * `view.dispatch()` is a plain method call, not a DOM event, so it is
 * never subject to that gate; `task-title-editor.tsx`'s own doc comment on
 * `closeAutocompleteRef` has the full proof. `onAutocompleteOpenChange`
 * (wired through both composer instances below) is the one signal this
 * dialog has for "is a popup open right now" — `Content`'s own
 * `onEscapeKeyDown` reads it, calls `preventDefault()` (keeping Radix from
 * closing the whole dialog) AND `closeAutocompleteRef.current?.()`
 * (actually closing the popup) in the same synchronous tick, rather than
 * leaving the second half to a keydown that will never arrive.
 *
 * **Issue #265 — discarding an unsaved title now confirms first.** Split
 * out of #261 (whose own acceptance criteria bundled the Escape/popup fix
 * above with this, deliberately left out as unmeasured at the time). Before
 * this, every dismissal here — the editor's own Escape `onCancel`, the
 * footer's Cancel button, and Radix `Root`'s own `onOpenChange` (Escape
 * without a popup open, an outside click, the X button) — called
 * `onOpenChange(false)` unconditionally, silently discarding whatever was
 * typed. Live Todoist (both its modal Quick Add and, corroborated
 * separately, Todoist Android's own composer — this ticket's own capture,
 * 2026-09-15) confirms first whenever the field holds text, and closes with
 * no prompt at all when it's empty. `requestDismiss` (below, next to
 * `hasText`) is the one door all of the above now go through instead,
 * reusing `task-detail-view.tsx`'s DET-15 `requestCancelEditing` shape
 * rather than inventing a second one; its own doc comment there, and
 * `requestDismiss`'s here, have the rest.
 */
import { parseQuickAdd, uiPriorityOf } from "@meologue/core";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Suspense, useEffect, useRef, useState } from "react";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import { type QuickAddTaskFields, taskFieldsForRename } from "@/lib/quick-add-task";
import { priorityPickerColour } from "@/lib/task-priority-colors";
import { useQuickAddComposer } from "@/lib/use-quick-add-composer";
import { cn } from "@/lib/utils";

export interface QuickAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (fields: QuickAddTaskFields) => void;
  projects?: readonly AutocompleteEntry[];
  labels?: readonly AutocompleteEntry[];
  onCreateProject?: (name: string) => void;
  onCreateLabel?: (name: string) => void;
}

// A `date`-family token span, spliced out of the raw text by "Remove
// date" below. Not established by any record how Todoist's own control
// edits the text (no artifact ever clicked it) — this is a best-effort
// reimplementation, not a measured behaviour; flagged in this ticket's
// own report rather than presented as verified.
const DATE_FAMILY_KINDS = new Set(["date", "time", "recurrence"]);

function stripDateTokens(
  text: string,
  tokens: readonly { kind: string; start: number; end: number }[],
): string {
  const spans = tokens
    .filter((token) => DATE_FAMILY_KINDS.has(token.kind))
    .slice()
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const span of spans) {
    result = result.slice(0, span.start) + result.slice(span.end);
  }
  return result.replace(/\s+/g, " ").trim();
}

// 580px at every width the record measured, capped so a narrow viewport
// never overflows — the record itself only ever measured one width.
const DIALOG_CLASSES =
  "fixed top-1/2 left-1/2 z-50 w-[580px] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[length:var(--td-composer-radius)] border border-[color:var(--td-composer-border)] bg-[color:var(--td-composer-background)] p-4 text-foreground shadow-[0_4px_8px_rgba(0,0,0,0.2)] outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const EDITOR_BOX_CLASSES =
  "w-full min-w-0 bg-transparent text-[length:var(--td-composer-title-font-size)] leading-[length:var(--td-composer-title-line-height)] outline-none";

// 32px (`h-8`) — the content row the rest state's 66px chrome math needs
// (this file's own header comment). Same idiom `add-task-form.tsx`'s
// `EDITOR_BOX_CLASSES` already reaches for with its own `h-8`, not a
// number invented here.
const EDITOR_ROW_CLASSES = "flex h-8 items-center gap-2";

// 31px (`mt-1` 4 + `border-t` 1 + `pt-0.5` 2 + `h-6` "xs" buttons 24) —
// the exact footer sum the grown state's 97px chrome math needs (this
// file's own header comment does the arithmetic).
const FOOTER_CLASSES =
  "mt-1 flex items-center justify-between gap-2 border-t border-[color:var(--td-composer-border)] pt-0.5";

export function QuickAddDialog({
  open,
  onOpenChange,
  onAdd,
  projects = [],
  labels = [],
  onCreateProject,
  onCreateLabel,
}: QuickAddDialogProps) {
  // A ref, not state: this only ever needs to be read out-of-band, from
  // `Content`'s own `onEscapeKeyDown` handler below — the identical
  // "no render needed, just a fresh read at fire-time" shape
  // `todo-keymap.ts`'s own `focusedTaskId()` already uses.
  const autocompleteOpenRef = useRef(false);
  // Issue #261 — this file's own header comment on the Escape/popup trap
  // has the full reasoning: `onEscapeKeyDown` below cannot trust the same
  // keydown to reach `quick-add-autocomplete.ts`'s own handler once it has
  // called `event.preventDefault()` itself, so it closes the popup
  // directly through this instead, the identical shape
  // `task-detail-view.tsx`'s `dismissGuardRef` already uses.
  const closeAutocompleteRef = useRef<(() => void) | null>(null);
  // Issue #265 — the discard confirmation's own `onCloseAutoFocus` (below)
  // needs somewhere real to send focus back to when it closes without a
  // Discard, and it opens programmatically (never from a click Radix can
  // treat as "the trigger"), so its own default falls back to
  // `document.body` exactly as `task-detail-view.tsx`'s DET-15 fix found.
  // Unlike that file, this dialog has exactly one focusable editor
  // (title only, always mounted, never swapped for another), so a plain
  // `querySelector` scoped to this ref at close time is enough — no
  // `focusin` listener tracking "whichever editor last had it" is needed
  // here.
  const contentRef = useRef<HTMLDivElement | null>(null);

  const composer = useQuickAddComposer({
    onAdd,
    projects,
    labels,
    onCreateProject,
    onCreateLabel,
    // QA-19 (matched, live-driven): Shift+Enter closed/cleared Quick Add
    // on both sides — the whole dialog, not just the field, for this
    // surface.
    onCommitted: () => onOpenChange(false),
  });

  // Issue #265 follow-up — a live pass found the discard confirmation
  // itself firing on a genuinely empty reopened Quick Add. Root cause,
  // confirmed by reading `use-quick-add-composer.ts`: this dialog is
  // always mounted (`todo-page.tsx` renders `<QuickAddDialog open=
  // {quickAddOpen} .../>` unconditionally, only toggling `open`), so
  // `composer`'s own state outlives any single open/close cycle.
  // `composer.value` — the "live mirror" `onChange` updates on every
  // keystroke — is what `hasText` reads, but NOTHING resets it when a
  // dismissal ends the session without a commit: `commit`/`remount` are
  // the only two functions that ever touch it, and neither Discard nor
  // Cancel/Escape/an outside click/the X button call either. So after
  // type → Escape → Discard, `composer.value` still reads "buy milk" —
  // stale, not merely uncleared — even once Radix has torn the old
  // `LazyTaskTitleEditor` down and the next open mounts a genuinely fresh
  // one. (`composer.seed`, the OTHER piece `remount` also owns, is
  // usually fine on its own — plain typing never touches it — which is
  // why the reopened editor itself really was empty; the bug is a stale
  // mirror, not an unclear field. Except "Remove date" also calls
  // `remount(stripped)`, so a type → Remove date → Escape → Discard cycle
  // leaves `seed` stale too, the identical bug one layer deeper — this
  // fix covers that path as well.)
  //
  // The fix matches this repo's own precedent for exactly this bug class:
  // `task-time-dialog.tsx`'s and `task-custom-repeat-dialog.tsx`'s own
  // "re-seed the local draft on the open transition, never while already
  // open" `useEffect` (their own comments: "a dismiss never commits, so
  // the next open must reflect reality, not an abandoned draft"). Those
  // two re-seed FROM a prop (`time`/the Task's own repeat rule); Quick Add
  // has no such source of truth to re-seed from — its own "reality" is
  // simply blank — so this resets straight to `""`, reusing
  // `composer.remount` (the identical primitive `removeDate` below
  // already trusts) rather than resetting `value`/`seed`/`resetKey` by
  // hand here. This is deliberately unconditional (every open, not only
  // when something was actually left stale) and applies uniformly to
  // every dismissal route — Discard, Cancel, Escape, an outside click, the
  // X button all funnel through the identical `requestDismiss`/Radix
  // `onOpenChange` wiring below with no door-specific state to clean up,
  // so fixing the shared `composer` fixes every door at once rather than
  // patching `hasText` or any one handler.
  //
  // Also answers "does anything else the composer holds leak the same
  // way" (asked directly during review): no — `hasDate`/`hasPriority`/
  // `uiPriority`/`preview` below are all pure derivations of `composer.
  // value` via `parseQuickAdd`/`taskFieldsForRename`, recomputed fresh
  // every render, not separate stored state. Quick Add has no project/
  // label picker of its own yet (this file's own header comment: "a
  // different ticket's surface"), so `composer.value` was the only actual
  // piece of draft state to leak.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open transition (`task-time-dialog.tsx`'s own biome-ignore, identical reason) — not on every `composer` identity change, which is a fresh object every render regardless.
  useEffect(() => {
    if (open) {
      composer.remount("");
    }
  }, [open]);

  // Live preview of the current line's own parse — the identical
  // `parseQuickAdd`/`taskFieldsForRename` pipeline `commit` itself will
  // run, just read a render early so the footer can react to it (QA-16's
  // grow-on-recognition, PRI-04's pill) without waiting for Add to be
  // pressed. `taskFieldsForRename`, not `taskFieldsFromQuickAdd`: only it
  // distinguishes "no p[1-4] typed" (null) from "p4, typed" (1) — the
  // distinction PRI-04's pill needs to decide whether to render at all.
  const parsed = parseQuickAdd(composer.value, composer.options);
  const preview = taskFieldsForRename(composer.value, parsed, composer.options);
  const hasDate = preview.date !== null || preview.dateString !== null;
  const hasPriority = preview.priority !== null;
  const uiPriority = hasPriority ? uiPriorityOf(preview.priority as number) : null;
  // Issue #264: the one thing that decides 66px vs 97px. Trimmed so
  // whitespace-only input still reads as "empty" — the identical check
  // "Add task" already uses below to decide whether it's enabled.
  //
  // Issue #265 reuses this same check for the discard guard below, and it
  // is already safe against the trap this repo has been bitten by before
  // (a ProseMirror placeholder decoration making an empty editor read as
  // non-empty via `textContent`, `prosemirror-placeholder-fakes-nonempty`):
  // `composer.value` is set from `onChange`, which `task-title-editor.tsx`
  // feeds with `titleTextFromDoc(nextState.doc)` — the MODEL doc's own
  // `textContent`, not the DOM's. The placeholder ("Add task") is painted
  // by `placeholderPlugin` as a `Decoration.widget`, which lives outside
  // the document entirely (`task-title-editor.tsx`'s own `decorations`
  // prop, gated on `state.doc.content.size > 0` — the widget only renders
  // when the doc IS empty). So `doc.textContent`, and therefore
  // `composer.value`, never contains it: an empty field reads as `""`
  // here, not `"Add task"`. Verified by reading that source, not assumed.
  const hasText = composer.value.trim() !== "";

  // Issue #265 — the shared door every dismissal route below now goes
  // through, replacing three independent unconditional `onOpenChange(false)`
  // calls (the editor's own Escape `onCancel`, the footer's Cancel button,
  // and Radix `Root`'s own `onOpenChange`, which Escape without a popup
  // open, an outside click, and the X button all funnel into). The shape
  // is `task-detail-view.tsx`'s `requestCancelEditing`/`dismissGuardRef`
  // pair for DET-15, simplified for this surface: Quick Add has only one
  // "editing" state (open/closed), not DET-15's separate "is the form in
  // edit mode" question, so one function suffices in place of that file's
  // two.
  //
  // Wording measured live against Todoist's own modal Quick Add
  // (2026-09-15, this ticket's own capture) and matched verbatim — same
  // heading, same body, same Cancel/Discard button order. Not shared as a
  // constant with DET-15's identical strings: no caller in this codebase
  // pulls `ConfirmDialog` copy from a shared module today (every existing
  // caller — `entry-actions.tsx`, `sessions-page.tsx`, `task-detail-view.tsx`
  // — inlines its own title/description/confirmLabel), so introducing one
  // module for two four-word/six-word literals would be new structure this
  // codebase doesn't otherwise use, not a simplification.
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // Set only by the confirm's own Discard button (below), read only by its
  // `onCloseAutoFocus` — distinguishes "this confirm is closing because the
  // whole dialog is closing" (skip the focus-restore) from "this confirm is
  // closing back to the still-open composer" (restore focus to the editor),
  // the identical role `task-detail-view.tsx`'s own `discardConfirmedRef`
  // plays for DET-15.
  const discardConfirmedRef = useRef(false);

  function requestDismiss() {
    if (hasText) {
      setDiscardConfirmOpen(true);
      return;
    }
    onOpenChange(false);
  }

  function removeDate() {
    // `composer.remount` is what actually changes what's on screen —
    // `task-title-editor.tsx`'s own doc comment is explicit that a later
    // `value` prop change is never resynced into an already-mounted
    // document, so this rebuilds a fresh instance seeded with the
    // date-stripped text instead of trying to edit the live ProseMirror
    // doc from outside it.
    const stripped = stripDateTokens(composer.value, parsed.tokens);
    composer.remount(stripped);
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Issue #265 — Radix only ever calls this with `false` (opening is
        // this component's own `open` prop, not something Root decides for
        // itself), for every dismissal it drives directly: Escape when the
        // autocomplete popup isn't open (`onEscapeKeyDown` below only
        // intercepts the popup-open case), an outside click (no
        // `onPointerDownOutside` override here — there is nothing else for
        // it to do), and the X button (`DialogPrimitive.Close` calls this
        // same `onOpenChange` under Radix's own hood). Routing all three
        // through `requestDismiss` is what makes them agree with the
        // editor's own Escape `onCancel` and the footer's Cancel button
        // below, rather than three doors independently deciding whether
        // there's something worth confirming.
        if (next) {
          onOpenChange(next);
          return;
        }
        requestDismiss();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          aria-label="Quick Add"
          data-testid="quick-add"
          className={DIALOG_CLASSES}
          onEscapeKeyDown={(event) => {
            // This file's own header comment has the full reasoning: the
            // `preventDefault()` below is what stops Radix dismissing the
            // dialog, but it ALSO gates `prosemirror-view`'s own key
            // handling for this same event — so the popup has to be
            // closed directly, through `closeAutocompleteRef`, rather than
            // trusted to close itself once this handler returns.
            if (autocompleteOpenRef.current) {
              event.preventDefault();
              closeAutocompleteRef.current?.();
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Quick Add</DialogPrimitive.Title>
          <div className={EDITOR_ROW_CLASSES}>
            <div className="min-w-0 flex-1">
              <Suspense fallback={<div className="h-8" />}>
                <LazyTaskTitleEditor
                  key={composer.resetKey}
                  value={composer.seed}
                  ariaLabel="Task name"
                  autoFocus={true}
                  commitOnBlur={false}
                  onChange={composer.setValue}
                  onCommit={composer.commit}
                  // Issue #265 — this is the door Escape actually travels
                  // through whenever the autocomplete popup ISN'T open:
                  // `task-title-editor.tsx`'s own `commitKeymap` binds
                  // `Escape` to call this prop directly (its own doc
                  // comment on `onCancel`), and reaches Radix's document-
                  // capture Escape listener too on the same keystroke — both
                  // now agree, because both call `requestDismiss`.
                  onCancel={requestDismiss}
                  className={EDITOR_BOX_CLASSES}
                  extraPlugins={composer.extraPlugins}
                  autocomplete={composer.autocomplete}
                  onAutocompleteOpenChange={(isOpen) => {
                    autocompleteOpenRef.current = isOpen;
                  }}
                  closeAutocompleteRef={closeAutocompleteRef}
                />
              </Suspense>
            </div>
            {/* QA-15: Todoist's rest state carries a red Ramble/dictate
                button here — meologue has no dictation feature, so this
                stays a plain dismiss affordance rather than a stub or a
                disabled placeholder for one. Known open item, not papered
                over (this file's own header comment). */}
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close">
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {/* PRI-04: the flag icon alone carries the priority's colour —
              the `P{n}` text stays the shared neutral grey
              (`text-muted-foreground`, which is `rgb(204,204,204)` in dark
              theme, the exact value scheduler-and-priority.md §10b
              measured for the text). */}
          {hasPriority && uiPriority !== null && (
            <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="size-3.5"
                fill={priorityPickerColour(uiPriority)}
              >
                <path d="M2 1.5a.5.5 0 0 1 1 0V2h9.5a.5.5 0 0 1 .4.8L11 6l1.9 3.2a.5.5 0 0 1-.4.8H3v4.5a.5.5 0 0 1-1 0v-13Z" />
              </svg>
              <span>P{uiPriority}</span>
            </div>
          )}

          {/* Issue #264: this whole toolbar row only exists once there's
              text — matching Todoist's own 66→97px grow-on-text (this
              file's own header comment has the exact arithmetic behind
              `FOOTER_CLASSES` and the "xs"-sized buttons below). At rest
              this block is absent entirely, not hidden, so it contributes
              nothing to the compact single-row layout above. */}
          {hasText && (
            <div className={FOOTER_CLASSES}>
              <div className="flex items-center gap-2">
                {/* QA-18: `Tab` from the title field lands here first —
                    natural DOM order already gives that, since this is the
                    editor's very next focusable sibling. No menu is wired
                    behind it (out of scope for this ticket — the record
                    never established its contents, only that Tab reaches
                    it); reported as unimplemented rather than faked. */}
                <Button type="button" variant="ghost" size="xs" aria-label="More actions">
                  <span aria-hidden="true">…</span>
                </Button>
                {hasDate && (
                  <Button type="button" variant="ghost" size="xs" onClick={removeDate}>
                    Remove date
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Issue #265 — this button only ever renders once `hasText`
                    is true (the `{hasText && (...)}` footer above), so every
                    real click here already has something worth confirming;
                    `requestDismiss` still gets the general check, rather
                    than this call site special-casing "always confirm",
                    so it stays the one door with the guard, not two. */}
                <Button type="button" variant="outline" size="xs" onClick={requestDismiss}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => composer.commit(composer.value)}
                  disabled={composer.value.trim() === ""}
                >
                  Add task
                </Button>
              </div>
            </div>
          )}

          {/* Issue #265 — rendered unconditionally, not nested inside the
              `hasText` footer above: `discardConfirmOpen` alone controls
              whether this is open, so a Discard click racing a `hasText`
              flip in the same tick can't unmount this out from under its
              own closing animation (`task-detail-view.tsx`'s identical
              DET-15 comment on its own sibling `ConfirmDialog`).
              `role="alertdialog"`, not Todoist's own `role="dialog"`: the
              standing decision on STR-01, STR-03 and DET-15 is to keep
              `alertdialog` on destructive confirms regardless of what
              Todoist itself uses, and `ConfirmDialog` already carries that
              role by hand (`alert-dialog.tsx`'s own top comment) — this is
              that same ratified divergence again, not a fresh call. Cancel
              stays focused by default here too (`ConfirmDialog`'s own
              `cancelRef`), diverging from Todoist's measured default focus
              on Discard: defaulting focus to the destructive action on a
              confirm that exists specifically to prevent data loss would
              undermine the one thing it's for, and a stray Enter would
              discard the draft it just asked to protect. */}
          <ConfirmDialog
            open={discardConfirmOpen}
            onOpenChange={setDiscardConfirmOpen}
            title="Discard unsaved changes?"
            description="Your unsaved changes will be discarded."
            confirmLabel="Discard"
            onConfirm={() => {
              discardConfirmedRef.current = true;
              onOpenChange(false);
            }}
            // Reached only when this closes WITHOUT Discard (Cancel, or its
            // own Escape) — `discardConfirmedRef` is what tells the two
            // apart, set only by `onConfirm` just above, the identical
            // shape `task-detail-view.tsx`'s DET-15 fix uses for the same
            // reason. Radix's own default would try to restore focus to
            // whatever "triggered" this dialog's open, which is nothing (it
            // opens programmatically, from `requestDismiss`) — without this
            // override that default strands focus on `document.body`
            // exactly as DET-15 first found; `preventScroll` matches
            // `ConfirmDialog`'s own `onOpenAutoFocus` call.
            onCloseAutoFocus={(event) => {
              if (discardConfirmedRef.current) {
                discardConfirmedRef.current = false;
                return;
              }
              event.preventDefault();
              contentRef.current
                ?.querySelector<HTMLElement>('[contenteditable="true"]')
                ?.focus({ preventScroll: true });
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
