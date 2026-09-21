import { Button } from "@/components/ui/button";
import type { TimeSource } from "@/lib/time-transport";

/**
 * One independent on/off fact per lane, rendered as a real `role="switch"`
 * with `aria-checked` for the same reason `switch-row.tsx` gives: a lane is
 * simply shown or not, with no sibling option it is being chosen over.
 *
 * Driven by the configured sources rather than by the day's response, so a
 * lane that has been switched off — and therefore has no records in the
 * response — still has a switch to turn back on.
 */
export function LanePicker({
  sources,
  hidden,
  onChange,
}: {
  sources: TimeSource[];
  hidden: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Source lanes</legend>
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        Lanes
      </span>
      {sources.map((source) => {
        const shown = !hidden.has(source.id);
        return (
          <Button
            key={source.id}
            type="button"
            size="touch"
            variant={shown ? "default" : "outline"}
            role="switch"
            aria-checked={shown}
            aria-label={`${source.name} lane`}
            onClick={() => {
              const next = new Set(hidden);
              if (shown) {
                next.add(source.id);
              } else {
                next.delete(source.id);
              }
              onChange(next);
            }}
          >
            {source.name}
            {!source.enabled && " (archived)"}
          </Button>
        );
      })}
    </fieldset>
  );
}
