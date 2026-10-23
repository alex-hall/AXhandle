import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  defaultAdbPath,
  NodeAdbCommandRunner,
  type AdbCommandRunner,
} from "./android-control.js";
import type { VideoRecorderProcess } from "./video.js";

export interface AdbScreenRecorderOptions {
  /** The adb binary. Default: `$ANDROID_HOME/platform-tools/adb`, or `adb`. */
  adb?: string;
  runner?: AdbCommandRunner;
  /** Upper bound on waiting for the recording to finish after stop(). */
  finalizeTimeout?: number;
  /** Process launcher override; defaults to node's spawn with ignored stdio. */
  launch?: (command: string, args: readonly string[]) => VideoRecorderProcess;
}

/**
 * Screen recording on an Android emulator via `adb shell screenrecord`, with
 * the same record-always lifecycle as `SimulatorVideoRecorder`: start()
 * before the test, then stop() to keep the file or discard() to drop it.
 *
 * The recording is written on the device and pulled to `outputPath` by
 * stop(). It must be ended with SIGINT on the device — that's what makes
 * screenrecord close a playable file. Android caps one recording at three
 * minutes; longer tests keep the first three.
 */
export class AdbScreenRecorder {
  private child: VideoRecorderProcess | undefined;
  private exited: Promise<void> | undefined;
  private readonly runner: AdbCommandRunner;
  private readonly devicePath: string;

  constructor(
    private readonly serial: string,
    readonly outputPath: string,
    private readonly options: AdbScreenRecorderOptions = {},
  ) {
    this.runner =
      options.runner ??
      new NodeAdbCommandRunner(options.adb ?? defaultAdbPath());
    this.devicePath = `/sdcard/axhandle-recording-${process.pid}-${Date.now()}.mp4`;
  }

  start(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    const launch =
      this.options.launch ??
      ((command: string, args: readonly string[]) =>
        spawn(command, [...args], { stdio: "ignore" }));
    const child = launch(this.options.adb ?? defaultAdbPath(), [
      "-s",
      this.serial,
      "shell",
      "screenrecord",
      "--time-limit",
      "180",
      this.devicePath,
    ]);
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }

  /** Finish the recording (SIGINT on the device, bounded wait), then pull it. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;

    await this.runner
      .run(this.serial, ["shell", "pkill", "-INT", "-f", this.devicePath])
      .catch(() => undefined);
    const timeout = this.options.finalizeTimeout ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    await this.runner.run(this.serial, [
      "pull",
      this.devicePath,
      this.outputPath,
    ]);
    await this.runner
      .run(this.serial, ["shell", "rm", "-f", this.devicePath])
      .catch(() => undefined);
  }

  /** Finish and delete — the passing-test path. */
  async discard(): Promise<void> {
    await this.stop().catch(() => undefined);
    rmSync(this.outputPath, { force: true });
  }
}
