import type { QuickAddToken } from "@meologue/core";
import { parseQuickAdd, uiPriorityOf } from "@meologue/core";
import { ArrowUp, Plus, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type * as React from "react";
import { forwardRef, Suspense, useState } from "react";
import { LazyTaskTitleEditor } from "@/components/todo/lazy-task-title-editor";
import { LazyTaskDescriptionEditor } from "@/components/todo/lazy-task-description-editor";
import { MultiLinePasteDialog } from "@/components/todo/multiline-paste-dialog";
import { Button } from "@/components/ui/button";
import { useDraftDateState } from "@/hooks/use-draft-date-state";
import { appendWords, applyTokenEdits, literalPriorityText } from "@/lib/draft-chip-text";
import { formatTaskDate } from "@/lib/format-task-date";
import { taskFieldsForRename } from "@/lib/quick-add-task";
import { priorityPickerColour } from "@/lib/task-priority-colors";
import type { QuickAddComposer } from "@/lib/use-quick-add-composer";
import { cn } from "@/lib/utils";
import { DraftPrioritySheet } from "./draft-priority-sheet";
import { TaskSchedulePopover } from "./task-schedule-popover";

export interface QuickAddContentProps {
  composer: QuickAddComposer;
  /** Decides the footer's own submit-button shape and whether Cancel renders at all — computed once by the caller's own `touchOnlyDevice()` (issue #365) and threaded down, rather than read again in here: the shell that picked itself by touch capability is the one source of truth for it, not a second read of the same media query. */
  touch: boolean;
  /** `use-quick-add-composer.ts`'s own rotating example string — advances on the closed→open transition, not per keystroke (this file's own header comment on why that lives one level up, not here). */
  placeholder: string;
  /** `TaskSchedulePopover`'s own busy-day dots — `undefined` reads as "no Task has ever been dated," never a crash; a caller with nothing to pass (a test) doesn't have to synthesise an empty Map itself. */
  datesWithTasks?: ReadonlyMap<string, number>;
  /**
   * The Project chip's own display text when nothing typed overrides it —
   * whatever the ambient view would file this Task into (`todo-page.tsx`'s
   * own `captureProjectId`, resolved to a name), or "Inbox" for a caller
   * with no ambient Project at all. Display-only (D11): issue #370 already
   * makes a *typed* `#project` file the Task correctly, but no picker
   * exists yet for clicking this chip to change it without typing — a
   * real gap, not this ticket's to close (flagged in its own report), so
   * the chip shows the resolved name without pretending to be a button.
   */
  ambientProjectName?: string;
  /** The editor's own `onCancel` — Escape, and the footer's Cancel button (non-touch only; touch has none, matching D11's "no Cancel row" reading of `android/02-anatomy.md`'s own control inventory). What "cancel" means (a plain collapse, or `quick-add-dialog.tsx`'s discard-confirmation) is entirely the caller's own call — this component only ever fires it. */
  onCancel: () => void;
  /** `TaskTitleEditor`'s own autocomplete-popup-open prop, forwarded through unchanged — `quick-add-dialog.tsx`'s own Escape-vs-popup guard needs to read this from outside, the same reason it exists on that file today. */
  onAutocompleteOpenChange?: (open: boolean) => void;
  closeAutocompleteRef?: React.RefObject<(() => void) | null>;
}

const EDITOR_ROW_CLASSES = "flex h-8 items-center gap-2";

const EDITOR_BOX_CLASSES =
  "w-full min-w-0 bg-transparent text-[length:var(--td-quick-add-title-font-size)] leading-[length:var(--td-quick-add-title-line-height)] text-[color:var(--td-quick-add-title-color)] outline-none";

const FOOTER_CLASSES = "mt-1 flex items-center justify-between gap-2";

const SUBMIT_CLASSES =
  "bg-[color:var(--td-quick-add-submit-background)] text-[color:var(--td-quick-add-submit-foreground)] hover:bg-[color:var(--td-quick-add-submit-background)]/90";

const EMPTY_DATES_WITH_TASKS: ReadonlyMap<string, number> = new Map();

/**
 * One toolbar/chip button — Todoist paints every chip (Project, Date,
 * Priority) and "More actions" the identical transparent-background,
 * neutral-text treatment (`web/07-native-colours.md`'s own table: no chip
 * carries its own accent colour). A `forwardRef` function, not a plain
 * one, for the same reason `task-detail-view.tsx`'s own `AttributePill`
 * is: `TaskSchedulePopover`'s `trigger` prop clones it via Radix `asChild`
 * to attach a ref, which a non-forwarding component would silently drop.
 */
const Chip = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> & { children: React.ReactNode }
>(function Chip({ children, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        // `web/07-native-colours.md`'s own table: every chip (Project,
        // Date, Priority) is a transparent-background, bordered pill —
        // border and text the identical neutral colour, never a filled
        // background of its own.
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-[length:var(--td-quick-add-chip-radius)] border border-[color:var(--td-quick-add-chip-color)] px-1.5 text-[13px] text-[color:var(--td-quick-add-chip-color)] hover:bg-muted",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

function findToken<K extends QuickAddToken["kind"]>(
  tokens: readonly QuickAddToken[],
  kind: K,
): Extract<QuickAddToken, { kind: K }> | undefined {
  return tokens.find((token): token is Extract<QuickAddToken, { kind: K }> => token.kind === kind);
}

/**
 * The shared subtree Todoist's own dialog and inline row are — one
 * component, editor through footer, wrapped twice (`quick-add-inline-
 * card.tsx` for non-touch, `quick-add-sheet.tsx` for touch). Knows
 * nothing about backdrops, positioning, or how it was opened; `touch`
 * (a plain prop, not its own `touchOnlyDevice()` read — see that prop's
 * own doc comment) is the one thing it reads to shape the footer's
 * submit control and the chip row's own scroll behaviour, matching
 * D16's "layout, not just behaviour" branch.
 */
export function QuickAddContent({
  composer,
  touch,
  placeholder,
  datesWithTasks,
  ambientProjectName = "Inbox",
  onCancel,
  onAutocompleteOpenChange,
  closeAutocompleteRef,
}: QuickAddContentProps) {
  const parsed = parseQuickAdd(composer.value, composer.options);
  const preview = taskFieldsForRename(composer.value, parsed, composer.options);
  // Issue #264's own check, unchanged: trimmed, so whitespace-only input
  // still reads as empty — the same test the submit button's own presence
  // uses below. `composer.value` is the model doc's `textContent`
  // (`task-title-editor.tsx`'s own `titleTextFromDoc`), never the DOM's,
  // so the placeholder decoration can never fake this into "non-empty"
  // (`prosemirror-placeholder-fakes-nonempty`).
  const hasText = composer.value.trim() !== "";
  const hasDate = preview.date !== null || preview.dateString !== null;
  const uiPriority = preview.priority !== null ? uiPriorityOf(preview.priority) : null;

  const [priorityPickerOpen, setPriorityPickerOpen] = useState(false);

  const dateState = useDraftDateState(
    composer.value,
    parsed.tokens,
    composer.options.now,
    composer.remount,
  );

  const priorityToken = findToken(parsed.tokens, "priority");

  function setPriority(nextUiPriority: number | null) {
    if (nextUiPriority === null) {
      if (priorityToken === undefined) {
        return;
      }
      composer.remount(
        applyTokenEdits(composer.value, [
          { start: priorityToken.start, end: priorityToken.end, replacement: null },
        ]),
      );
      return;
    }
    const words = literalPriorityText(nextUiPriority);
    if (priorityToken !== undefined) {
      composer.remount(
        applyTokenEdits(composer.value, [
          { start: priorityToken.start, end: priorityToken.end, replacement: words },
        ]),
      );
      return;
    }
    composer.remount(appendWords(composer.value, words));
  }

  // "More actions" -> Labels/Project/Section: inserts the bare sigil and
  // refocuses (`task-title-editor.tsx`'s own `Selection.atEnd(doc)` on
  // every fresh mount) right after it, the identical state
  // `quick-add-autocomplete.ts`'s popup already watches for from ordinary
  // typing — this is not a second mechanism, just a programmatic keypress.
  function insertSigil(sigil: string) {
    composer.remount(appendWords(composer.value, sigil));
  }

  const dateLabel =
    dateState.dateDay === null
      ? "Date"
      : formatTaskDate(
          dateState.dateTime !== null
            ? `${dateState.dateDay}T${dateState.dateTime}`
            : dateState.dateDay,
          { recurring: dateState.dateString !== null },
        ).text;

  const projectDisplayName = parsed.projectName ?? ambientProjectName;

  return (
    <div className="relative flex flex-col gap-1">
      <div className={EDITOR_ROW_CLASSES}>
        <div className={cn("min-w-0 flex-1", !touch && !hasText && "pr-20")}>
          <Suspense fallback={<div className="h-8" />}>
            <LazyTaskTitleEditor
              key={composer.resetKey}
              value={composer.seed}
              ariaLabel="Task name"
              placeholder={placeholder}
              autoFocus={true}
              commitOnBlur={false}
              onChange={composer.setValue}
              onCommit={composer.commit}
              onCancel={onCancel}
              className={EDITOR_BOX_CLASSES}
              extraPlugins={composer.extraPlugins}
              autocomplete={composer.autocomplete}
              onAutocompleteOpenChange={onAutocompleteOpenChange}
              closeAutocompleteRef={closeAutocompleteRef}
              onMultiLinePaste={composer.onMultiLinePaste}
            />
          </Suspense>
        </div>
      </div>

      {composer.descriptionOpen && (
        <Suspense fallback={<div className="h-7" />}>
          <LazyTaskDescriptionEditor
            value={composer.description}
            onChange={composer.setDescription}
            onCancel={() => composer.setDescriptionOpen(false)}
            placeholder="Description"
            autoFocus={true}
            className="min-h-7 text-sm leading-5 text-[color:var(--td-quick-add-title-color)] outline-none"
          />
        </Suspense>
      )}

      {/*
        One row, split left/right (`web/01-anatomy.md`'s own numbered
        list reads as a single row: "+ More actions -> Project -> Date ->
        remove X" then, far right, "Cancel and Add task") — always
        present (the empty-title tab order names Cancel, the mic, and
        More actions as three of its four stops), growing to include the
        chips only once there's text to attach them to (`web/01-anatomy.md`:
        "toolbar only renders once title is non-empty").
      */}
      <div
        className={cn(
          FOOTER_CLASSES,
          // The measured empty web card is 66px high: its controls share
          // the title row. Once text exists, the chip/actions row moves
          // below it and the card grows to the measured 97–114px range.
          // Android always keeps its bottom controls row.
          !touch && !hasText && "absolute top-0 right-0 mt-0",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-1", touch && "overflow-x-auto")}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="More actions">
                <Plus aria-hidden="true" className="size-3.5" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              {/*
                Priority / Labels / Project / Section only (issue #374's
                own report): Description and Reminders are BOTH omitted,
                not stubbed (D11) — `quick-add-task.ts`'s own
                `UNSUPPORTED_TOKEN_KINDS` still discards both at commit
                time, so a menu item that "added" either would look
                acted-upon and do nothing, the exact defect this whole
                revamp exists to remove. Attachment, Location, task
                extraction, extensions and the dictation mic never had a
                row here to begin with.
              */}
              <DropdownMenu.Content
                align="start"
                className="z-[70] flex w-44 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground text-sm shadow-lg"
              >
                <DropdownMenu.Item
                  className="cursor-pointer rounded-md px-2 py-1.5 outline-hidden data-highlighted:bg-muted"
                  onSelect={() => composer.setDescriptionOpen(true)}
                >
                  Description
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="cursor-pointer rounded-md px-2 py-1.5 outline-hidden data-highlighted:bg-muted"
                  onSelect={() => setPriorityPickerOpen(true)}
                >
                  Priority
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="cursor-pointer rounded-md px-2 py-1.5 outline-hidden data-highlighted:bg-muted"
                  onSelect={() => insertSigil("@")}
                >
                  Labels
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="cursor-pointer rounded-md px-2 py-1.5 outline-hidden data-highlighted:bg-muted"
                  onSelect={() => insertSigil("#")}
                >
                  Project
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="cursor-pointer rounded-md px-2 py-1.5 outline-hidden data-highlighted:bg-muted"
                  onSelect={() => insertSigil("/")}
                >
                  Section
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {(hasText || touch) && (
            <>
              <Chip aria-label="Select project" onClick={() => insertSigil("#")}>
                {projectDisplayName}
              </Chip>

              <TaskSchedulePopover
                trigger={
                  <Chip aria-label={dateState.dateDay === null ? "Set date" : dateLabel}>
                    {dateLabel}
                  </Chip>
                }
                dateDay={dateState.dateDay}
                dateTime={dateState.dateTime}
                onSetTime={dateState.setScheduleTime}
                dateString={dateState.dateString}
                datesWithTasks={datesWithTasks ?? EMPTY_DATES_WITH_TASKS}
                onPickDay={dateState.setScheduleDay}
                onPickRecurrence={dateState.setScheduleRecurrence}
              />
              {hasDate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove date"
                  onClick={() => dateState.setScheduleDay(null)}
                >
                  <X aria-hidden="true" className="size-3" />
                </Button>
              )}

              {uiPriority !== null && (
                <>
                  <Chip
                    aria-label={`Priority P${uiPriority}`}
                    onClick={() => setPriorityPickerOpen(true)}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: priorityPickerColour(uiPriority) }}
                    />
                    {`P${uiPriority}`}
                  </Chip>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove priority"
                    onClick={() => setPriority(null)}
                  >
                    <X aria-hidden="true" className="size-3" />
                  </Button>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Android's own control inventory (`android/02-anatomy.md`)
              never carries a Cancel button beside the mic/send button —
              dismissal there is Back/scrim-tap, not an in-row control
              (D11's "send-only, no mic" reading also drops the row it
              would have sat in). */}
          {!touch && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onCancel}
              className="text-[color:var(--td-quick-add-cancel-color)]"
            >
              Cancel
            </Button>
          )}
          {/* Issue #374's own measured fact (`web/01-anatomy.md`,
              `android/02-anatomy.md`): the submit control is ABSENT from
              the DOM while the title is empty, never merely disabled. */}
          {hasText &&
            (touch ? (
              <Button
                type="button"
                size="icon-lg"
                aria-label="Add task"
                onClick={() => composer.commit(composer.value)}
                className={cn(SUBMIT_CLASSES, "rounded-full")}
              >
                <ArrowUp aria-hidden="true" className="size-5" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon-xs"
                aria-label="Add task"
                onClick={() => composer.commit(composer.value)}
                className={SUBMIT_CLASSES}
              >
                <ArrowUp aria-hidden="true" className="size-3.5" />
              </Button>
            ))}
        </div>
      </div>

      <DraftPrioritySheet
        open={priorityPickerOpen}
        onOpenChange={setPriorityPickerOpen}
        uiPriority={uiPriority ?? 4}
        onSelect={(ui) => {
          setPriority(ui);
          setPriorityPickerOpen(false);
        }}
      />

      <MultiLinePasteDialog
        lines={composer.pendingPasteLines}
        onConfirmSplit={composer.confirmSplitPaste}
        onConfirmMerge={composer.confirmMergePaste}
        onCancel={composer.cancelPendingPaste}
      />
    </div>
  );
}
