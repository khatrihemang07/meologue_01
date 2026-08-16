import type { Action } from "sonner";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerSWMock, updateSWMock } = vi.hoisted(() => ({
  registerSWMock: vi.fn(),
  updateSWMock: vi.fn(),
}));

// vite-plugin-pwa's virtual module (ticket 45) — mocked rather than left to
// resolve for real, so this test exercises only the prompt-on-update
// behaviour this file adds, not the plugin's own registration mechanics.
vi.mock("virtual:pwa-register", () => ({ registerSW: registerSWMock }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

/** The `onNeedRefresh` callback registerServiceWorker() passed to registerSW. */
function onNeedRefreshFromLastCall(): () => void {
  const call = registerSWMock.mock.calls[0];
  const options = call?.[0];
  if (!options?.onNeedRefresh) {
    throw new Error("registerSW was not called with an onNeedRefresh handler");
  }
  return options.onNeedRefresh;
}

describe("register-service-worker.web", () => {
  beforeEach(() => {
    vi.resetModules();
    registerSWMock.mockReset();
    updateSWMock.mockReset();
    registerSWMock.mockReturnValue(updateSWMock);
    vi.mocked(toast).mockReset();
  });

  it("registers the service worker with an onNeedRefresh handler", async () => {
    const { registerServiceWorker } = await import("./register-service-worker.web");

    registerServiceWorker();

    expect(registerSWMock).toHaveBeenCalledWith(
      expect.objectContaining({ onNeedRefresh: expect.any(Function) }),
    );
  });

  it("raises a toast offering to reload once a new version is waiting, rather than reloading on its own", async () => {
    const { registerServiceWorker } = await import("./register-service-worker.web");
    registerServiceWorker();

    onNeedRefreshFromLastCall()();

    expect(updateSWMock).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "A new version of meologue is available.",
      expect.objectContaining({
        duration: Number.POSITIVE_INFINITY,
        action: expect.objectContaining({ label: "Reload", onClick: expect.any(Function) }),
      }),
    );
  });

  it("only reloads once the toast's action is accepted", async () => {
    const { registerServiceWorker } = await import("./register-service-worker.web");
    registerServiceWorker();

    onNeedRefreshFromLastCall()();
    const toastCall = vi.mocked(toast).mock.calls[0];
    const action = toastCall?.[1]?.action as Action | undefined;
    action?.onClick?.({} as never);

    expect(updateSWMock).toHaveBeenCalledWith(true);
  });
});
