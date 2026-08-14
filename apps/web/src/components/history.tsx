import type { Entry } from "@meologue/core";

interface HistoryProps {
  entries: Entry[];
}

export function History({ entries }: HistoryProps) {
  if (entries.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">History will appear here.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
        >
          {entry.body}
        </div>
      ))}
    </div>
  );
}
