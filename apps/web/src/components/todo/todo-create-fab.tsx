import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTodoSidebarLayout } from "@/hooks/use-wide-layout";
import { OPEN_QUICK_ADD_EVENT } from "@/lib/todo-keymap";

export function TodoCreateFab() {
  const wide = useTodoSidebarLayout();
  if (wide) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      aria-label="Quick add"
      onClick={() => document.dispatchEvent(new CustomEvent(OPEN_QUICK_ADD_EVENT))}
      className="absolute right-4 bottom-4 z-10 size-14 rounded-full shadow-lg"
    >
      <Plus aria-hidden="true" className="size-6" />
    </Button>
  );
}
