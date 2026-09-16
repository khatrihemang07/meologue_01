/**
 * The Composer's format toolbar (issue #164, extended by issue #211, split
 * pointer/touch by issue #213) — a row of buttons that sits above the input
 * while the Composer has focus. Two different button sets exist, chosen per
 * render by `hoverCapable()` (`lib/pointer.ts`):
 *
 * - `POINTER_GROUPS` (today's set, unchanged since #211): **bold · italic ·
 *   strikethrough · code** | **bullet · ordered · checklist** | **outdent ·
 *   indent** | **Reference** | **undo · redo**.
 * - `TOUCH_GROUPS` (issue #213): **checklist · bullet · ordered** |
 *   **outdent · indent · soft break** | **bold · italic · strikethrough** |
 *   **Reference** | **undo · redo** — led by the three actions a phone's
 *   keyboard has no other way to reach at all (no Tab, no Shift+Enter; see
 *   `meologue-reference/upnote-android-detail.md`), with inline `code` dropped
 *   (a backtick pair is still typeable, and it's the least-used mark on a
 *   phone).
 *
 * `hoverCapable()` is read fresh on every render, not cached: the same
 * comment on `hoverCapable()` itself explains why (a mouse can be plugged
 * into a tablet mid-session), and composer.tsx already re-renders this
 * component on every focus/transaction change, so there is no missing
 * trigger to re-evaluate it on.
 *
 * Every button reaches through `composerCommands`/its individual named
 * exports (composer-commands.ts, issue #160) rather than reimplementing any
 * editing behaviour here — this component's only job is to lay the chosen
 * group set out, read `isActive`/`isEnabled` off the `commandStates` map
 * composer.tsx recomputes on every transaction (over the WHOLE registry, so
 * either group set needs no state changes of its own), and report which
 * command was pressed. `onRun` is composer.tsx's own concern (it owns the
 * live `EditorView`, this component never sees one), matching how
 * `chooseItem`/`insertAtCursor` there already own dispatching against
 * `viewRef.current` rather than handing the view itself down further.
 *
 * `POINTER_GROUPS` is rendered in the ticket's own visual order, not
 * `composerCommands`' array order: the registry lists `indent` before
 * `outdent` (that array's own doc comment says it follows issue #160's
 * ticket, a different one from this component's), but issue #164 groups
 * them "outdent · indent" — decrease before increase, the same order
 * Google Docs' own toolbar uses. The registry's array order is what a `/`
 * menu (#165) or a keyboard-shortcuts list would want; a toolbar's own
 * left-to-right layout is free to differ, same commands either way.
 *
 * `role="toolbar"` names the whole row for assistive tech and gives
 * `apps/e2e` a single stable locator (`getByRole("toolbar")`) instead of
 * separate button groups it would otherwise have to know to combine. Group
 * dividers are `aria-hidden` decoration only — the groups are conveyed
 * visually, not as a second layer of structure a screen reader would need
 * to announce.
 *
 * The slash menu (composer-slash.ts) is deliberately unchanged by any of
 * this: its trigger is a typed character, which presupposes the keyboard
 * whose Enter key already is the soft break, and its query closes on a
 * newline anyway — nothing here.
 */
import {
  AtSign,
  Bold,
  Code,
  CornerDownLeft,
  IndentDecrease,
  IndentIncrease,
  Italic,
  ListOrdered,
  List as ListPlain,
  ListTodo,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  bold,
  bulletList,
  type ComposerCommand,
  checklist,
  code,
  indent,
  italic,
  orderedList,
  outdent,
  redoCommand,
  reference,
  softBreak,
  strikethrough,
  undoCommand,
} from "@/lib/composer-commands";
import { hoverCapable } from "@/lib/pointer";

export interface CommandState {
  active: boolean;
  enabled: boolean;
}

interface ComposerToolbarProps {
  /** `command.id` -> its current `isActive`/`isEnabled` reading — recomputed by composer.tsx on every transaction (its own `dispatchTransactionImplRef` comment explains where and why). A command with no entry yet (the very first render, before the mount effect populates this) reads as inactive-and-disabled, the safe default for a row that isn't shown until the Composer has focus anyway. */
  commandStates: Readonly<Record<string, CommandState>>;
  /** Runs `command` against the live `EditorView` — composer.tsx's own concern; see this file's module comment. */
  onRun: (command: ComposerCommand) => void;
}

/** One button's fixed shape — icon, and which `ComposerCommand` it runs — paired with an accessible label pulled from the command's own `label` rather than a second copy of it here. */
interface ToolbarButtonSpec {
  command: ComposerCommand;
  Icon: ComponentType<{ "aria-hidden": true; className?: string }>;
}

/**
 * The five groups, left to right, exactly as issue #164 lists them — the
 * set a pointer device (mouse/trackpad) sees, unchanged by issue #213.
 * `ListPlain` (an alias for lucide's `List`, which this file also imports
 * `ListOrdered`/`ListTodo` alongside) is bulletList's icon; `ListTodo` — a
 * list with its own checkbox glyphs — is `checklist`'s, since a plain
 * `List`/`ListOrdered` pair would leave nothing to tell "checklist" apart
 * from "bullet list" at a glance. `AtSign` stands in for Reference: `[[`
 * itself has no glyph in this icon set, and `@`-to-insert-a-reference is
 * the closest existing convention a reader is likely to already know from
 * elsewhere (Notion, Slack, ...) even though this app's own trigger is `[[`.
 */
const POINTER_GROUPS: readonly (readonly ToolbarButtonSpec[])[] = [
  [
    { command: bold, Icon: Bold },
    { command: italic, Icon: Italic },
    { command: strikethrough, Icon: Strikethrough },
    { command: code, Icon: Code },
  ],
  [
    { command: bulletList, Icon: ListPlain },
    { command: orderedList, Icon: ListOrdered },
    { command: checklist, Icon: ListTodo },
  ],
  [
    { command: outdent, Icon: IndentDecrease },
    { command: indent, Icon: IndentIncrease },
  ],
  [{ command: reference, Icon: AtSign }],
  [
    { command: undoCommand, Icon: Undo2 },
    { command: redoCommand, Icon: Redo2 },
  ],
];

/**
 * The touch set (issue #213), led by the three actions with no keyboard
 * equivalent at all on a phone — no Tab, no Shift+Enter, and `KEYCODE_TAB`
 * itself blurs the field and closes the keyboard rather than moving focus
 * (verified on device, `meologue-reference/upnote-android-detail.md`) — followed
 * by the list types, the marks (`code` dropped — still typeable as a
 * backtick pair, and the least-used mark on a phone), Reference, and
 * undo/redo. `CornerDownLeft` is `softBreak`'s icon: it reads as "Enter"
 * pictorially, which is exactly what this button stands in for on a device
 * whose actual Enter key already sends.
 */
const TOUCH_GROUPS: readonly (readonly ToolbarButtonSpec[])[] = [
  [
    { command: checklist, Icon: ListTodo },
    { command: bulletList, Icon: ListPlain },
    { command: orderedList, Icon: ListOrdered },
  ],
  [
    { command: outdent, Icon: IndentDecrease },
    { command: indent, Icon: IndentIncrease },
    { command: softBreak, Icon: CornerDownLeft },
  ],
  [
    { command: bold, Icon: Bold },
    { command: italic, Icon: Italic },
    { command: strikethrough, Icon: Strikethrough },
  ],
  [{ command: reference, Icon: AtSign }],
  [
    { command: undoCommand, Icon: Undo2 },
    { command: redoCommand, Icon: Redo2 },
  ],
];

const FALLBACK_STATE: CommandState = { active: false, enabled: false };

export function ComposerToolbar({ commandStates, onRun }: ComposerToolbarProps) {
  // Read fresh on every render rather than cached — see this file's own
  // module comment on why (a mouse can be plugged into a tablet mid-session).
  const groups = hoverCapable() ? POINTER_GROUPS : TOUCH_GROUPS;
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="mx-auto flex w-[97%] items-center gap-1 overflow-x-auto px-4 pt-2 md:w-[85%]"
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.map((spec) => spec.command.id).join("-")}
          className="flex shrink-0 items-center gap-0.5"
        >
          {groupIndex > 0 && (
            // A plain divider between groups — decorative only, per this
            // file's own module comment on why the groups aren't a second
            // structural layer for assistive tech.
            <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-border" />
          )}
          {group.map(({ command, Icon }) => {
            const state = commandStates[command.id] ?? FALLBACK_STATE;
            return (
              <Button
                key={command.id}
                type="button"
                aria-label={command.label}
                aria-pressed={state.active}
                variant={state.active ? "secondary" : "ghost"}
                size="icon-lg"
                // size-11 (44px), the same override composer.tsx's own Send
                // button uses (its own comment: "icon-lg alone (36px)
                // doesn't reach" the platform tap-target minimum) — every
                // one of these eleven buttons is a phone's ONLY path to
                // indent/outdent/checklist (there are no keyboard shortcuts
                // on Android at all, per this ticket), so none of them can
                // be smaller.
                className="size-11 shrink-0"
                disabled={!state.enabled}
                // Steals no caret: the mousedown that would otherwise move
                // focus onto this button (and off the live `EditorView`) is
                // prevented here, so the editor never blurs and the
                // selection this button is about to act on is still
                // exactly where the reader left it. The actual action runs
                // on `click`, which still fires normally after a
                // prevented `mousedown` — this is the same trick every
                // contenteditable-backed rich-text toolbar uses.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onRun(command)}
              >
                <Icon aria-hidden={true} className="size-5" />
              </Button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
