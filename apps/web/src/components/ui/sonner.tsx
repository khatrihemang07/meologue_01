import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useResolvedTheme } from "@/hooks/use-resolved-theme";

// sonner defaults to a light theme and does not read the `dark` class this
// app toggles on <html> — useResolvedTheme is what keeps it in step,
// including while the theme is changed on the very Settings page toasts
// appear on.
export function Toaster(props: ToasterProps) {
  const theme = useResolvedTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      // Issue #355: nothing previously kept a toast clear of Todo's own
      // docked bottom bar (`todo-nav.tsx`'s `h-20` row — 80 CSS px,
      // Todoist Android's own measured item height) or the Composer's own
      // docked bar (`composer.tsx`'s `[padding-bottom:var(--safe-bottom)]`
      // div — shorter than Todo's bar, but not a fixed height either way).
      // sonner's own default position sits at the raw viewport edge,
      // underneath both. `6rem` clears the taller of the two with room to
      // spare; `--safe-bottom` (`env(safe-area-inset-bottom)`, index.css)
      // is added on top since sonner's own offset math has no way to know
      // about the device's own home-indicator inset the way both docked
      // bars already account for individually.
      offset={{ bottom: "calc(6rem + var(--safe-bottom))" }}
      {...props}
    />
  );
}
