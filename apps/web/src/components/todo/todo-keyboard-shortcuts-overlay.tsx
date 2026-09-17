/**
 * The `?` overlay (issue #228, `keyboard.md` §1's own reference: opened
 * with `?`, `role="dialog"`, titled "Keyboard Shortcuts"). Every row here
 * comes from `groupedBindingsBySection()` (`@/lib/todo-keymap`) — the same
 * table `use-todo-keymap.ts` matches keydowns against and `task-command-
 * menu.tsx` reads its own legend from — so this overlay can never advertise
 * a key that does nothing, the exact defect issue #228 closes elsewhere in
 * Todo. It is deliberately much shorter than the 80-row transcription in
 * `meologue-reference/todoist/keyboard.md`: only bindings with a real target in
 * this app are in the table at all (that module's own header comment lists
 * what's missing and why).
 */
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatKeyHint, groupedBindingsBySection } from "@/lib/todo-keymap";

export interface TodoKeyboardShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TodoKeyboardShortcutsOverlay({
  open,
  onOpenChange,
}: TodoKeyboardShortcutsOverlayProps) {
  const sections = groupedBindingsBySection();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogContent
          open={open}
          className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
        >
          <DialogTitle className="mb-3 font-semibold text-base">Keyboard Shortcuts</DialogTitle>
          <div className="flex flex-col gap-4">
            {sections.map(({ section, rows }) => (
              <div key={section}>
                <h3 className="mb-1.5 text-muted-foreground text-xs uppercase tracking-wide">
                  {section}
                </h3>
                <dl className="flex flex-col gap-1">
                  {rows.map((row) => (
                    <div
                      key={`${row.section}:${row.label}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <dt>{row.label}</dt>
                      <dd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
                        {formatKeyHint(row.keys)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
