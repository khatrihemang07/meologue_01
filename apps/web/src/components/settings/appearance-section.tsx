import { ChoiceRow } from "@/components/settings/choice-row";
import { DeviceGroup } from "@/components/settings/device-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import {
  ACCENTS,
  type AccentId,
  TEXT_SIZES,
  type TextSizeId,
  type Theme,
  useSettingsStore,
} from "@/lib/settings";
import { applyAccent, applyTextSize, applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * How the app is drawn — Theme, Accent, Text size — the first of five topic
 * sections `settings-page.tsx` composes (issue #202). Every setting here is
 * Device-local (ADR 0008), read and written straight off `useSettingsStore`
 * with no props threaded down from the page, the same self-contained shape
 * every topic section in `settings/` takes except `DataSection`, which
 * needs a store handle the page itself has to open.
 *
 * One `DeviceGroup` and no "On the server" sibling: nothing here is a
 * Server setting, and none of these three is ever going to become one — how
 * a Device paints its own screen is a fact about that Device, not something
 * a Server could hold on a reader's behalf. The wrapper still goes on, same
 * as every other topic section, so the shape a topic *with* a Server-owned
 * row will eventually need is already uniform across all five before the
 * first one actually needs it.
 */
export function AppearanceSection() {
  // From the store, not local state — main.tsx already applied this theme
  // before this page ever rendered, and reading it through the store rather
  // than copying it into local state means this control can never drift
  // from what's actually in effect.
  const theme = useSettingsStore((state) => state.theme);
  const accent = useSettingsStore((state) => state.accent);
  const textSize = useSettingsStore((state) => state.textSize);
  const setStoredTheme = useSettingsStore((state) => state.setTheme);
  const setStoredAccent = useSettingsStore((state) => state.setAccent);
  const setStoredTextSize = useSettingsStore((state) => state.setTextSize);

  // Apply first, then persist — the same order every visible choice on this
  // page uses. The visible effect is a custom property or a class on
  // <html>, and a storage write that throws (private browsing) must not be
  // what stands between the reader and the change they just asked for.
  function selectTheme(next: Theme) {
    applyTheme(next);
    setStoredTheme(next);
  }

  function selectAccent(next: AccentId) {
    applyAccent(next);
    setStoredAccent(next);
  }

  function selectTextSize(next: TextSizeId) {
    applyTextSize(next);
    setStoredTextSize(next);
  }

  return (
    <section aria-labelledby="appearance-heading" className="flex flex-col gap-4">
      <h2 id="appearance-heading" className="font-semibold text-sm">
        Appearance
      </h2>
      <DeviceGroup heading="On this device">
        <SettingsSection label="Theme">
          <ChoiceRow columns={3}>
            {THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="touch"
                variant={theme === option.value ? "default" : "outline"}
                aria-pressed={theme === option.value}
                onClick={() => selectTheme(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </ChoiceRow>
        </SettingsSection>

        <SettingsSection label="Accent" hint="Recolours your own Entries, right away.">
          <ChoiceRow columns={5}>
            {ACCENTS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                aria-pressed={accent === option.id}
                onClick={() => selectAccent(option.id)}
                className={cn(
                  "flex h-11 flex-col items-center justify-center gap-1 rounded-lg border transition-colors",
                  accent === option.id
                    ? "border-foreground bg-muted"
                    : "border-transparent hover:bg-muted",
                )}
              >
                {/*
                  The colour comes from `index.css`'s own per-Accent variable
                  rather than an inline hex, so a swatch can never show one
                  colour while the thread paints another.
                */}
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full"
                  style={{ backgroundColor: `var(--accent-${option.id})` }}
                />
                <span className="w-full truncate px-0.5 text-center text-[10px] text-muted-foreground">
                  {option.label}
                </span>
              </button>
            ))}
          </ChoiceRow>
        </SettingsSection>

        <SettingsSection
          label="Text size"
          hint="Changes the words you wrote. The time, the sync tick and the day label stay the same size."
        >
          <ChoiceRow columns={3}>
            {TEXT_SIZES.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="touch"
                variant={textSize === option.id ? "default" : "outline"}
                aria-pressed={textSize === option.id}
                onClick={() => selectTextSize(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </ChoiceRow>
        </SettingsSection>
      </DeviceGroup>
    </section>
  );
}
