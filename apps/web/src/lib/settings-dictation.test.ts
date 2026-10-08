import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDeviceSettings, readAllDeviceSettings, removeRetiredDictationKeys } from "./settings";

describe("retired per-Device dictation keys (issue #455)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("removes both legacy keys and leaves other settings alone", () => {
    localStorage.setItem("meologue.dictation-url", "http://mac.local:47300");
    localStorage.setItem("meologue.dictation-token", "secret");
    localStorage.setItem("meologue.theme", "dark");

    removeRetiredDictationKeys();

    expect(localStorage.getItem("meologue.dictation-url")).toBeNull();
    expect(localStorage.getItem("meologue.dictation-token")).toBeNull();
    expect(localStorage.getItem("meologue.theme")).toBe("dark");
  });

  it("runs once when the settings module loads", async () => {
    localStorage.setItem("meologue.dictation-url", "http://x");
    localStorage.setItem("meologue.dictation-token", "secret");
    vi.resetModules();

    await import("./settings");

    expect(localStorage.getItem("meologue.dictation-url")).toBeNull();
    expect(localStorage.getItem("meologue.dictation-token")).toBeNull();
  });

  it("keeps the token out of a Backup even if the key is present", () => {
    localStorage.setItem("meologue.dictation-token", "secret");
    localStorage.setItem("meologue.theme", "dark");

    const settings = readAllDeviceSettings();

    expect(settings).not.toHaveProperty("meologue.dictation-token");
    expect(settings["meologue.theme"]).toBe("dark");
  });

  it("never lets a Restore write the token", () => {
    applyDeviceSettings({
      "meologue.dictation-token": "from-backup",
      "meologue.theme": "dark",
    });

    expect(localStorage.getItem("meologue.dictation-token")).toBeNull();
    expect(localStorage.getItem("meologue.theme")).toBe("dark");
  });

  it("never lets a Restore overwrite a token already on the Device", () => {
    localStorage.setItem("meologue.dictation-token", "mine");

    applyDeviceSettings({ "meologue.dictation-token": "from-backup" });

    expect(localStorage.getItem("meologue.dictation-token")).toBe("mine");
  });
});
