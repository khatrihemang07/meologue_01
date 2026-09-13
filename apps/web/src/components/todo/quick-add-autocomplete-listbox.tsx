/**
 * The React half of the `#`/`@` autocomplete popup — `quick-add-
 * autocomplete.ts`'s own header comment carries the full Todoist reference
 * and the calls this module makes where nothing was measured. Purely
 * presentational: every piece of state (which options, which is active) is
 * computed by that file's plugin and handed down as props, so this
 * component owns no state of its own and needs no test beyond what it
 * renders for a given prop set — `task-title-editor.test.tsx` covers the
 * behaviour end to end, through a real `EditorView`.
 *
 * `role="listbox"`/`role="option"`/`aria-selected` match Todoist's own
 * captured markup (`quick-add.md` § "Autocomplete popups",
 * `data-testid="content-editor-suggestions-dropdown"` — reproduced here as
 * `data-testid` too, so a caller looking for Todoist's own selector finds
 * this component's markup as well).
 */
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

/** Todoist's own recorded fallback wording (QA-13/QA-14): *"Project not found. Create &lt;text&gt;"* / *"Label not found. Create &lt;text&gt;"* — the live DOM capture ran the two sentences together with no space (`live-audit-dom/qa-flow-todoist-qa13-14-final.json`'s `qa13FallbackText: "Project not found.Create zzznonexistent"`); rendered here as two stacked lines rather than reproduced as one run-together string, since nothing in the ledger treats that concatenation itself as meaningful. */
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
