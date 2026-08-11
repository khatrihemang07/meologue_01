import { beforeEach, describe, expect, it } from "vitest";
import { getDeviceId } from "./device-id";

describe("getDeviceId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("mints a Device id on first run", () => {
    expect(getDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("persists the same id across calls, like a hard reload", () => {
    const first = getDeviceId();

    const second = getDeviceId();

    expect(second).toBe(first);
  });

  it("mints different ids for different Devices", () => {
    const first = getDeviceId();
    localStorage.clear();

    const second = getDeviceId();

    expect(second).not.toBe(first);
  });
});
