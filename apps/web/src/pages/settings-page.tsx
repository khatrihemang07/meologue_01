import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readServerUrl, readTheme, type Theme, writeServerUrl, writeTheme } from "@/lib/settings";
import { applyTheme } from "@/lib/theme";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function SettingsPage() {
  // Initialised from storage, not a fixed default, so the control shows
  // what's actually in effect (main.tsx already applied it before this
  // page ever rendered).
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [serverUrl, setServerUrl] = useState(() => readServerUrl());

  function selectTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
    writeTheme(next);
  }

  function saveServerUrl() {
    writeServerUrl(serverUrl);
    // Reflect back the normalised (trimmed, trailing-slash-stripped) value
    // rather than leaving whatever the user typed sitting in the field.
    setServerUrl(readServerUrl());
  }

  return (
    <Shell title="Settings">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back
      </Link>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Theme</span>
        <div className="inline-flex gap-1">
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={theme === option.value ? "default" : "outline"}
              aria-pressed={theme === option.value}
              onClick={() => selectTheme(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="server-url" className="text-sm font-medium">
          Server URL
        </label>
        <div className="flex gap-2">
          <Input
            id="server-url"
            type="text"
            placeholder="Leave empty to use this app's default"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
          <Button type="button" onClick={saveServerUrl}>
            Save
          </Button>
        </div>
      </div>
    </Shell>
  );
}
