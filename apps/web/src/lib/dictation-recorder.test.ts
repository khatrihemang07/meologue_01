import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationRecorderError, startDictationRecording } from "./dictation-recorder";

class FakeRecorder {
  static supported = new Set<string>();
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.has(type);
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** When true, `stop()` leaves `onstop` for the test to fire, like a real recorder that finalises later. */
  static deferStop = false;
  options: { mimeType?: string } | undefined;
  stream: MediaStream;
  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options?.mimeType ?? "audio/default";
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (FakeRecorder.deferStop) {
      return;
    }
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track, track] } as unknown as MediaStream };
}

describe("startDictationRecording", () => {
  beforeEach(() => {
    FakeRecorder.supported = new Set();
    FakeRecorder.instances = [];
    FakeRecorder.deferStop = false;
    vi.stubGlobal("MediaRecorder", FakeRecorder);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMedia(getUserMedia: () => Promise<MediaStream>) {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  }

  it("picks the first supported MIME type in preference order", async () => {
    FakeRecorder.supported = new Set(["audio/mp4", "audio/webm"]);
    const { stream } = fakeStream();
    stubMedia(async () => stream);

    await startDictationRecording();

    expect(FakeRecorder.instances[0]?.options?.mimeType).toBe("audio/webm");
  });

  it("falls back to the browser default when nothing is supported", async () => {
    const { stream } = fakeStream();
    stubMedia(async () => stream);

    await startDictationRecording();

    expect(FakeRecorder.instances[0]?.options).toBeUndefined();
  });

  it("stop resolves a blob and stops every track", async () => {
    FakeRecorder.supported = new Set(["audio/webm"]);
    const { stream, track } = fakeStream();
    stubMedia(async () => stream);

    const recording = await startDictationRecording();
    const blob = await recording.stop();

    expect(blob.type).toBe("audio/webm");
    expect(blob.size).toBeGreaterThan(0);
    expect(track.stop).toHaveBeenCalled();
  });

  it("cancel stops every track and discards audio", async () => {
    const { stream, track } = fakeStream();
    stubMedia(async () => stream);

    const recording = await startDictationRecording();
    recording.cancel();

    expect(track.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances[0]?.state).toBe("inactive");
  });

  it("cancel rejects a pending stop as cancelled and stops every track", async () => {
    FakeRecorder.deferStop = true;
    const { stream, track } = fakeStream();
    stubMedia(async () => stream);

    const recording = await startDictationRecording();
    const pending = recording.stop().catch((e) => e);
    recording.cancel();

    const error = await pending;
    expect(error).toBeInstanceOf(DictationRecorderError);
    expect(error.kind).toBe("cancelled");
    expect(track.stop).toHaveBeenCalled();
  });

  it("a recorder error rejects a pending stop and stops every track", async () => {
    FakeRecorder.deferStop = true;
    const { stream, track } = fakeStream();
    stubMedia(async () => stream);

    const recording = await startDictationRecording();
    const pending = recording.stop().catch((e) => e);
    FakeRecorder.instances[0]?.onerror?.();

    const error = await pending;
    expect(error).toBeInstanceOf(DictationRecorderError);
    expect(error.kind).toBe("unknown");
    expect(track.stop).toHaveBeenCalled();
  });

  it("a recorder error while recording stops tracks and fails the later stop", async () => {
    const { stream, track } = fakeStream();
    stubMedia(async () => stream);

    const recording = await startDictationRecording();
    FakeRecorder.instances[0]?.onerror?.();

    expect(track.stop).toHaveBeenCalled();
    const error = await recording.stop().catch((e) => e);
    expect(error.kind).toBe("unknown");
  });

  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no-device"],
  ])("maps %s to %s", async (name, kind) => {
    stubMedia(async () => {
      throw new DOMException("x", name);
    });
    const error = await startDictationRecording().catch((e) => e);
    expect(error).toBeInstanceOf(DictationRecorderError);
    expect(error.kind).toBe(kind);
  });

  it("maps a missing mediaDevices to insecure-context", async () => {
    vi.stubGlobal("navigator", {});
    const error = await startDictationRecording().catch((e) => e);
    expect(error.kind).toBe("insecure-context");
  });
});
