import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SimulatorVideoRecorder } from "../src/index.js";
import type { VideoRecorderProcess } from "../src/index.js";

class FakeRecorderProcess implements VideoRecorderProcess {
  exitCode: number | null = null;
  killed = false;
  readonly signals: string[] = [];
  private readonly listeners: Array<() => void> = [];

  kill(signal: "SIGINT"): void {
    this.signals.push(signal);
    this.killed = true;
    this.exitCode = 0;
    // recordVideo finalizes the container and exits after SIGINT.
    for (const listener of this.listeners) listener();
  }

  once(_event: "exit" | "error", listener: () => void): void {
    this.listeners.push(listener);
  }
}

describe("SimulatorVideoRecorder", () => {
  it("records via simctl and finalizes with SIGINT, never SIGTERM", async () => {
    const outputPath = join(
      mkdtempSync(join(tmpdir(), "axhandle-video-")),
      "run.mp4",
    );
    const child = new FakeRecorderProcess();
    const launches: Array<{ command: string; args: readonly string[] }> = [];

    const recorder = new SimulatorVideoRecorder("SIMULATOR-UDID", outputPath, {
      launch: (command, args) => {
        launches.push({ command, args });
        return child;
      },
      sweepStale: null,
    });

    recorder.start();
    await recorder.stop();

    expect(launches).toEqual([
      {
        command: "xcrun",
        args: [
          "simctl",
          "io",
          "SIMULATOR-UDID",
          "recordVideo",
          "--codec",
          "h264",
          "--force",
          outputPath,
        ],
      },
    ]);
    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("discard() finalizes and removes the file — the passing-test path", async () => {
    const outputPath = join(
      mkdtempSync(join(tmpdir(), "axhandle-video-")),
      "run.mp4",
    );
    const child = new FakeRecorderProcess();
    const recorder = new SimulatorVideoRecorder("SIMULATOR-UDID", outputPath, {
      launch: () => child,
      sweepStale: null,
    });

    recorder.start();
    writeFileSync(outputPath, "recording");
    await recorder.discard();

    expect(existsSync(outputPath)).toBe(false);
  });

  it("tolerates stop() without start() and repeated stops", async () => {
    const recorder = new SimulatorVideoRecorder(
      "SIMULATOR-UDID",
      "/tmp/never-written.mp4",
      {
        launch: () => new FakeRecorderProcess(),
        sweepStale: null,
      },
    );

    await expect(recorder.stop()).resolves.toBeUndefined();
    recorder.start();
    await recorder.stop();
    await expect(recorder.stop()).resolves.toBeUndefined();
  });

  it("clears recorders already holding the device before starting", () => {
    const swept: string[] = [];
    const recorder = new SimulatorVideoRecorder(
      "SIMULATOR-UDID",
      "/tmp/sweep.mp4",
      {
        launch: () => new FakeRecorderProcess(),
        sweepStale: (udid) => swept.push(udid),
      },
    );

    recorder.start();

    // A SIGKILLed predecessor leaves an orphan no exit hook could have caught;
    // the next run is the only chance to release the device.
    expect(swept).toEqual(["SIMULATOR-UDID"]);
  });

  it("finalizeSync() releases the device without awaiting — the process-exit path", () => {
    const child = new FakeRecorderProcess();
    const recorder = new SimulatorVideoRecorder(
      "SIMULATOR-UDID",
      "/tmp/exit.mp4",
      {
        launch: () => child,
        sweepStale: null,
      },
    );

    recorder.start();
    recorder.finalizeSync();

    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("finalizeSync() is idempotent and safe before start()", () => {
    const child = new FakeRecorderProcess();
    const recorder = new SimulatorVideoRecorder(
      "SIMULATOR-UDID",
      "/tmp/exit.mp4",
      {
        launch: () => child,
        sweepStale: null,
      },
    );

    expect(() => recorder.finalizeSync()).not.toThrow();
    recorder.start();
    recorder.finalizeSync();
    recorder.finalizeSync();

    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("stops a recording that outlives the duration ceiling", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeRecorderProcess();
      const recorder = new SimulatorVideoRecorder(
        "SIMULATOR-UDID",
        "/tmp/runaway.mp4",
        {
          launch: () => child,
          sweepStale: null,
          maxDuration: 1000,
        },
      );

      recorder.start();
      expect(child.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1001);

      expect(child.signals).toEqual(["SIGINT"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the recording alone when the ceiling is disabled", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeRecorderProcess();
      const recorder = new SimulatorVideoRecorder(
        "SIMULATOR-UDID",
        "/tmp/unbounded.mp4",
        {
          launch: () => child,
          sweepStale: null,
          maxDuration: 0,
        },
      );

      recorder.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(child.signals).toEqual([]);
      await recorder.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
