import { Mic } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";

/** The id of the Settings gateway URL field, and the hash that asks Settings to focus it. */
export const DICTATION_URL_FIELD_ID = "dictation-url";

/**
 * The mic as the Composer shows it while no dictation gateway URL is saved
 * (issue #454 follow-up, ADR 0090). It never records: a tap opens Settings
 * with `#dictation-url`, and SettingsPage scrolls to and focuses that field.
 * Same icon, size and styling as DictateButton, so the toolbar looks the
 * same before and after setup.
 */
export function DictationSetupButton() {
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      size="icon-lg"
      variant="ghost"
      aria-label="Set up dictation"
      className="size-11 shrink-0"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => navigate(`/settings#${DICTATION_URL_FIELD_ID}`)}
    >
      <Mic aria-hidden="true" className="size-5" />
    </Button>
  );
}
