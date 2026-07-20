import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    const outputPath = join(mkdtempSync(join(tmpdir(), "axhandle-video-")), "run.mp4");
    const child = new FakeRecorderProcess();
    const launches: Array<{ command: string; args: readonly string[] }> = [];

    const recorder = new SimulatorVideoRecorder("SIMULATOR-UDID", outputPath, {
      launch: (command, args) => {
        launches.push({ command, args });
        return child;
      }
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
          outputPath
        ]
      }
    ]);
    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("discard() finalizes and removes the file — the passing-test path", async () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), "axhandle-video-")), "run.mp4");
    const child = new FakeRecorderProcess();
    const recorder = new SimulatorVideoRecorder("SIMULATOR-UDID", outputPath, {
      launch: () => child
    });

    recorder.start();
    writeFileSync(outputPath, "recording");
    await recorder.discard();

    expect(existsSync(outputPath)).toBe(false);
  });

  it("tolerates stop() without start() and repeated stops", async () => {
    const recorder = new SimulatorVideoRecorder("SIMULATOR-UDID", "/tmp/never-written.mp4", {
      launch: () => new FakeRecorderProcess()
    });

    await expect(recorder.stop()).resolves.toBeUndefined();
    recorder.start();
    await recorder.stop();
    await expect(recorder.stop()).resolves.toBeUndefined();
  });
});
