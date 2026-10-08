import { LoaderCircle, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { describeDictationError } from "@/lib/describe-dictation-error";
import { type DictationRecording, startDictationRecording } from "@/lib/dictation-recorder";
import {
  type DictationResult,
  type TranscribeOptions,
  transcribeRecording,
} from "@/lib/dictation-transport";

type Phase = "idle" | "starting" | "recording" | "transcribing";

interface DictateButtonProps {
  /** Receives the transcript. The Composer inserts it at the cursor; this button never sends. */
  onText: (text: string) => void;
  /** The Composer's own `disabled` (store still opening). Going true mid-recording cancels it. */
  disabled?: boolean;
  /** Seams for tests: the real recorder and transport are the defaults. */
  startRecording?: () => Promise<DictationRecording>;
  transcribe?: (blob: Blob, options: TranscribeOptions) => Promise<DictationResult>;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The Composer's mic button (issue #454, ADR 0090; Server-backed since #455, ADR 0091): idle, recording,
 * transcribing. Composer passes it into the format toolbar's first group
 * (the owner moved it there from beside Send), so it is sized and styled
 * like the toolbar's own buttons: square, ghost when idle.
 *
 * Owns the recording and the in-flight request, and releases both whenever
 * this component goes away or the Composer is disabled: an orphaned
 * recording would keep the OS microphone indicator lit with nothing on
 * screen to stop it, and an orphaned request would insert text into a
 * Composer the user has already left.
 */
export function DictateButton({
  onText,
  disabled = false,
  startRecording = startDictationRecording,
  transcribe = transcribeRecording,
}: DictateButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recordingRef = useRef<DictationRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  // Bumped by every release, so an async step that resumes after a
  // cancel (getUserMedia resolving late, a transcript landing after
  // unmount) can tell its own run is stale and must not touch anything.
  const runRef = useRef(0);

  const release = useCallback(() => {
    runRef.current += 1;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      release();
    };
  }, [release]);

  useEffect(() => {
    if (disabled) {
      release();
      setPhase("idle");
    }
  }, [disabled, release]);

  useEffect(() => {
    if (phase !== "recording") {
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  function report(error: unknown) {
    const sentence = describeDictationError(error);
    if (sentence !== null) {
      toast.error(sentence);
    }
  }

  async function startDictation() {
    const run = ++runRef.current;
    setPhase("starting");
    try {
      const recording = await startRecording();
      if (run !== runRef.current) {
        // Released (unmount or disabled) while the permission prompt was open.
        recording.cancel();
        return;
      }
      recordingRef.current = recording;
      setPhase("recording");
    } catch (error) {
      if (run === runRef.current) {
        setPhase("idle");
        report(error);
      }
    }
  }

  async function stopAndTranscribe() {
    const recording = recordingRef.current;
    if (recording === null) {
      return;
    }
    // Left in `recordingRef` while the stop is pending, so a release
    // (unmount, disabled) can still cancel it and settle the stop.
    const run = runRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("transcribing");
    try {
      const blob = await recording.stop();
      if (run === runRef.current) {
        recordingRef.current = null;
      }
      const result = await transcribe(blob, { signal: controller.signal });
      if (run !== runRef.current || !aliveRef.current) {
        return;
      }
      if (result.text.trim() === "" || result.warning === "no_speech") {
        toast("No speech detected");
      } else {
        onText(result.text.trim());
      }
    } catch (error) {
      if (run === runRef.current) {
        report(error);
      }
    } finally {
      if (run === runRef.current) {
        recordingRef.current = null;
        abortRef.current = null;
        setPhase("idle");
      }
    }
  }

  const recording = phase === "recording";
  const transcribing = phase === "transcribing";

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="icon-lg"
        variant={recording ? "destructive" : "ghost"}
        aria-label={recording ? "Stop dictation" : transcribing ? "Transcribing" : "Dictate"}
        className="size-11 shrink-0"
        // Same "steals no caret" trick as the toolbar's other buttons: without it a
        // tap blurs the editor and drops the soft keyboard, and the
        // transcript then has no caret to land at.
        onMouseDown={(event) => event.preventDefault()}
        onClick={recording ? stopAndTranscribe : startDictation}
        disabled={disabled || transcribing || phase === "starting"}
      >
        {recording ? (
          <Square aria-hidden="true" className="size-4 fill-current" />
        ) : transcribing ? (
          <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
        ) : (
          <Mic aria-hidden="true" className="size-5" />
        )}
      </Button>
      {recording && (
        // Visible, not just announced: a user glancing at the screen has to
        // be able to tell at once that the mic is live and for how long. After
        // the button, not before it, so starting a recording never shifts the
        // button out from under the finger that will tap it again to stop.
        <span className="flex items-center gap-1.5 text-destructive text-sm tabular-nums">
          <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-destructive" />
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}
