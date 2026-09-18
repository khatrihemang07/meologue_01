import { Button } from "@/components/ui/button";

export function CompletionToastBody({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <>
      <div className="min-w-0 flex-1 font-medium">{message}</div>
      <Button type="button" size="xs" onClick={onUndo}>
        Undo
      </Button>
    </>
  );
}
