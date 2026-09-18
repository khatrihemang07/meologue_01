import type { AutocompleteOptionRow, AutocompleteSigil } from "@/lib/quick-add-autocomplete";
import { cn } from "@/lib/utils";

export interface QuickAddAutocompleteListboxProps {
  id: string;
  sigil: AutocompleteSigil;
  options: readonly AutocompleteOptionRow[];
  activeIndex: number;
  /** Absolute positioning, computed by the caller from `EditorView.coordsAtPos` — this component never measures anything itself (jsdom has no layout to measure, `task-title-editor.tsx`'s own report on this ticket says so plainly). */
  style: React.CSSProperties;
  getOptionId: (index: number) => string;
}

function notFoundLabelFor(sigil: AutocompleteSigil): string {
  return sigil === "#" ? "Project not found." : "Label not found.";
}

export function QuickAddAutocompleteListbox({
  id,
  sigil,
  options,
  activeIndex,
  style,
  getOptionId,
}: QuickAddAutocompleteListboxProps) {
  return (
    <div
      id={id}
      role="listbox"
      data-testid="content-editor-suggestions-dropdown"
      aria-label={sigil === "#" ? "Projects" : "Labels"}
      className="absolute z-50 max-h-60 min-w-[180px] overflow-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md"
      style={style}
    >
      {options.map((row, index) => {
        const active = index === activeIndex;
        const key = row.kind === "entry" ? row.entry.id : "__create__";
        return (
          <div
            key={key}
            id={getOptionId(index)}
            role="option"
            aria-selected={active}
            // Not independently focusable, by design: the `aria-
            // activedescendant` pattern `task-title-editor.tsx` implements
            // keeps real focus on the editor itself the whole time a
            // popup is open (Todoist's own capture never showed focus
            // leaving the title field either) — `tabIndex={-1}` here is
            // only to satisfy the a11y linter's "an interactive role must
            // be focusable" rule without making Tab visit each option.
            tabIndex={-1}
            className={cn(
              "cursor-default px-2 py-1 leading-tight",
              active && "bg-accent text-accent-foreground",
            )}
          >
            {row.kind === "entry" ? (
              row.entry.name
            ) : (
              <>
                <span className="block text-muted-foreground">{notFoundLabelFor(sigil)}</span>
                <span className="block">{`Create ${row.query}`}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
