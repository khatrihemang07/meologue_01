import { Input } from "@/components/ui/input";

/**
 * Searches this day's Activity intervals and nothing else.
 *
 * Deliberately not the Shell's own History search: Time searches what
 * recorders observed, which is not History, Tasks or any other Destination's
 * material — and one box that sometimes meant one and sometimes the other
 * would be worse than two that each say what they search.
 */
export function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="time-search" className="sr-only">
        Search this day's activity
      </label>
      <Input
        id="time-search"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search this day's activity"
        className="h-11"
      />
    </div>
  );
}
