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
