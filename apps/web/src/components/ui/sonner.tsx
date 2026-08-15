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
      {...props}
    />
  );
}
