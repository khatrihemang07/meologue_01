/**
 * The Composer's format toolbar (issue #164) — a row of eleven buttons, in
 * five groups, that sits above the input while the Composer has focus:
 * **bold · italic · code** | **bullet · ordered · checklist** |
 * **outdent · indent** | **Reference** | **undo · redo**.
 *
 * Every button reaches through `composerCommands`/its individual named
 * exports (composer-commands.ts, issue #160) rather than reimplementing any
 * editing behaviour here — this component's only job is to lay eleven
 * `ComposerCommand`s out, read `isActive`/`isEnabled` off the
 * `commandStates` map composer.tsx recomputes on every transaction, and
 * report which command was pressed. `onRun` is composer.tsx's own concern
 * (it owns the live `EditorView`, this component never sees one), matching
 * how `chooseItem`/`insertAtCursor` there already own dispatching against
 * `viewRef.current` rather than handing the view itself down further.
 *
 * Rendered in the ticket's own visual order, not `composerCommands`' array
 * order: the registry lists `indent` before `outdent` (that array's own doc
 * comment says it follows issue #160's ticket, a different one from this
 * component's), but issue #164 groups them "outdent · indent" — decrease
 * before increase, the same order Google Docs' own toolbar uses. The
 * registry's array order is what a `/` menu (#165) or a keyboard-shortcuts
 * list would want; a toolbar's own left-to-right layout is free to differ,
 * same commands either way.
 *
 * `role="toolbar"` names the whole row for assistive tech and gives
 * `apps/e2e` a single stable locator (`getByRole("toolbar")`) instead of
 * five separate button groups it would otherwise have to know to combine.
 * Group dividers are `aria-hidden` decoration only — the five groups are
 * conveyed visually, not as a second layer of structure a screen reader
 * would need to announce.
 */
import {
  AtSign,
  Bold,
  Code,
  IndentDecrease,
  IndentIncrease,
  Italic,
  ListOrdered,
  List as ListPlain,
  ListTodo,
  Redo2,
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
  undoCommand,
} from "@/lib/composer-commands";

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
 * The five groups, left to right, exactly as issue #164 lists them.
 * `ListPlain` (an alias for lucide's `List`, which this file also imports
 * `ListOrdered`/`ListTodo` alongside) is bulletList's icon; `ListTodo` — a
 * list with its own checkbox glyphs — is `checklist`'s, since a plain
 * `List`/`ListOrdered` pair would leave nothing to tell "checklist" apart
 * from "bullet list" at a glance. `AtSign` stands in for Reference: `[[`
 * itself has no glyph in this icon set, and `@`-to-insert-a-reference is
 * the closest existing convention a reader is likely to already know from
 * elsewhere (Notion, Slack, ...) even though this app's own trigger is `[[`.
 */
const GROUPS: readonly (readonly ToolbarButtonSpec[])[] = [
  [
    { command: bold, Icon: Bold },
    { command: italic, Icon: Italic },
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

const FALLBACK_STATE: CommandState = { active: false, enabled: false };

export function ComposerToolbar({ commandStates, onRun }: ComposerToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="mx-auto flex w-[97%] items-center gap-1 overflow-x-auto px-4 pt-2 md:w-[85%]"
    >
      {GROUPS.map((group, groupIndex) => (
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
