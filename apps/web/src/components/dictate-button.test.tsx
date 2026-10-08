import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationRecorderError, type DictationRecording } from "@/lib/dictation-recorder";
import { DictationError, type TranscribeOptions } from "@/lib/dictation-transport";
import { DictateButton } from "./dictate-button";

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));

function fakeRecording(blob = new Blob(["a"], { type: "audio/webm" })) {
  const recording = {
    stop: vi.fn(async () => blob),
    cancel: vi.fn(),
  } satisfies DictationRecording;
  return recording;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DictateButton", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    toastMock.mockClear();
    toastMock.error.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is an idle Dictate button to begin with", () => {
    render(<DictateButton onText={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("records, shows an elapsed timer, then transcribes and inserts without sending", async () => {
    const recording = fakeRecording();
    const start = vi.fn(async () => recording);
    let resolveTranscript: (v: { text: string; rawText: string; warning: null }) => void = () => {};
    const transcribe = vi.fn(
      (_blob: Blob, _options: TranscribeOptions) =>
        new Promise<{ text: string; rawText: string; warning: null }>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    const onText = vi.fn();
    render(<DictateButton onText={onText} startRecording={start} transcribe={transcribe} />);

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
    // The timer follows the stop button, so starting a recording never moves
    // the button out from under the finger that will tap it again to stop.
    expect(
      screen
        .getByRole("button", { name: "Stop dictation" })
        .compareDocumentPosition(screen.getByText("0:00")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await act(async () => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByText("1:05")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await flush();
    const busy = screen.getByRole("button", { name: "Transcribing" });
    expect(busy).toBeDisabled();
    expect(transcribe.mock.calls[0]?.[1]).toHaveProperty("signal");

    await act(async () => {
      resolveTranscript({ text: "hello there", rawText: "hello there", warning: null });
    });
    expect(onText).toHaveBeenCalledWith("hello there");
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("toasts and inserts nothing for empty text", async () => {
    const onText = vi.fn();
    render(
      <DictateButton
        onText={onText}
        startRecording={async () => fakeRecording()}
        transcribe={async () => ({ text: "", rawText: "", warning: "no_speech" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await flush();

    expect(onText).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith("No speech detected");
  });

  it.each([
    [new DictationRecorderError("denied", "x"), "Microphone access was denied."],
    [
      new DictationRecorderError("insecure-context", "x"),
      "Dictation needs a secure (HTTPS or localhost) page.",
    ],
  ])("toasts a start failure (%#)", async (error, sentence) => {
    render(
      <DictateButton
        onText={vi.fn()}
        startRecording={async () => {
          throw error;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(sentence);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it.each([
    [new DictationError("unreachable", "x"), "Couldn't reach the Server."],
    [new DictationError("unavailable", "x"), "Dictation is turned off on the Server."],
    [
      new DictationError("gateway-unreachable", "x"),
      "The Server couldn't reach the dictation gateway.",
    ],
    [
      new DictationError("gateway-rejected", "x"),
      "The Server's dictation token was rejected by the gateway.",
    ],
    [new DictationError("failed", "whisper crashed"), "whisper crashed"],
  ])("toasts a transcription failure (%#)", async (error, sentence) => {
    render(
      <DictateButton
        onText={vi.fn()}
        startRecording={async () => fakeRecording()}
        transcribe={async () => {
          throw error;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(sentence);
  });

  it("cancels the recording on unmount", async () => {
    const recording = fakeRecording();
    const { unmount } = render(
      <DictateButton onText={vi.fn()} startRecording={async () => recording} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();

    unmount();

    expect(recording.cancel).toHaveBeenCalled();
  });

  it("cancels the recording when the Composer becomes disabled", async () => {
    const recording = fakeRecording();
    const { rerender } = render(
      <DictateButton onText={vi.fn()} startRecording={async () => recording} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();

    rerender(<DictateButton onText={vi.fn()} disabled startRecording={async () => recording} />);

    expect(recording.cancel).toHaveBeenCalled();
  });

  it("toasts nothing when unmount cancels a still-pending stop", async () => {
    let rejectStop: (e: unknown) => void = () => {};
    const recording = {
      stop: vi.fn(
        () =>
          new Promise<Blob>((_resolve, reject) => {
            rejectStop = reject;
          }),
      ),
      cancel: vi.fn(() => rejectStop(new DictationRecorderError("cancelled", "cancelled"))),
    } satisfies DictationRecording;
    const onText = vi.fn();
    const { unmount } = render(
      <DictateButton onText={onText} startRecording={async () => recording} transcribe={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await flush();

    unmount();
    await flush();

    expect(recording.cancel).toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it("aborts an in-flight transcription on unmount and inserts nothing", async () => {
    let signal: AbortSignal | undefined;
    const onText = vi.fn();
    const { unmount } = render(
      <DictateButton
        onText={onText}
        startRecording={async () => fakeRecording()}
        transcribe={(_blob, options) => {
          signal = options.signal;
          return new Promise(() => {});
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await flush();

    unmount();

    expect(signal?.aborted).toBe(true);
    expect(onText).not.toHaveBeenCalled();
  });

  it("keeps the caret: mousedown is default-prevented", () => {
    render(<DictateButton onText={vi.fn()} />);
    const notCancelled = fireEvent.mouseDown(screen.getByRole("button", { name: "Dictate" }));
    expect(notCancelled).toBe(false);
  });
});
