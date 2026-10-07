import { beforeEach, describe, expect, it } from "vitest";
import { applyDeviceSettings, readAllDeviceSettings, useSettingsStore } from "./settings";

describe("dictation settings (issue #454)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ dictationUrl: "", dictationToken: "" });
  });

  it("normalises the URL and persists it under a plain key", () => {
    useSettingsStore.getState().setDictationUrl("  http://mac.local:8765//  ");

    expect(useSettingsStore.getState().dictationUrl).toBe("http://mac.local:8765");
    expect(localStorage.getItem("meologue.dictation-url")).toBe("http://mac.local:8765");
  });

  it("persists the token under a plain key", () => {
    useSettingsStore.getState().setDictationToken(" secret ");

    expect(useSettingsStore.getState().dictationToken).toBe("secret");
    expect(localStorage.getItem("meologue.dictation-token")).toBe("secret");
  });

  it("leaves no key behind when the URL is cleared", () => {
    useSettingsStore.getState().setDictationUrl("http://x");
    useSettingsStore.getState().setDictationUrl("");

    expect(localStorage.getItem("meologue.dictation-url")).toBeNull();
  });

  it("keeps the token out of a Backup but keeps the URL", () => {
    useSettingsStore.getState().setDictationUrl("http://x");
    useSettingsStore.getState().setDictationToken("secret");

    const settings = readAllDeviceSettings();

    expect(settings["meologue.dictation-url"]).toBe("http://x");
    expect(settings).not.toHaveProperty("meologue.dictation-token");
  });

  it("never lets a Restore write or overwrite the token", () => {
    useSettingsStore.getState().setDictationToken("mine");

    applyDeviceSettings({
      "meologue.dictation-token": "from-backup",
      "meologue.dictation-url": "http://restored",
    });

    expect(localStorage.getItem("meologue.dictation-token")).toBe("mine");
    expect(localStorage.getItem("meologue.dictation-url")).toBe("http://restored");
  });
});
