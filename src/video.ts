import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** The slice of a child process the recorder needs; injectable for tests. */
export interface VideoRecorderProcess {
  readonly exitCode: number | null;
  readonly killed: boolean;
  kill(signal: "SIGINT"): unknown;
  once(event: "exit" | "error", listener: () => void): unknown;
}

export interface SimulatorVideoRecorderOptions {
  codec?: string;
  /** Upper bound on waiting for the recorder to finalize after SIGINT. */
  finalizeTimeout?: number;
  /** Process launcher override; defaults to node's spawn with ignored stdio. */
  launch?: (command: string, args: readonly string[]) => VideoRecorderProcess;
}

/**
 * Full-run screen recording via `xcrun simctl io recordVideo`. The intended
 * lifecycle is record-always: start() before the test, then stop() to keep
 * the file on failure or discard() on success.
 *
 * Finalization MUST be SIGINT — recordVideo only writes a playable container
 * on SIGINT; SIGTERM (or letting the process die with its parent) leaves a
 * corrupt file. stop() is also deadline-bounded so a wedged recorder can
 * never hang test teardown.
 */
export class SimulatorVideoRecorder {
  private child: VideoRecorderProcess | undefined;
  private exited: Promise<void> | undefined;

  constructor(
    private readonly udid: string,
    readonly outputPath: string,
    private readonly options: SimulatorVideoRecorderOptions = {}
  ) {}

  start(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    const launch =
      this.options.launch ??
      ((command: string, args: readonly string[]) =>
        spawn(command, [...args], { stdio: "ignore" }));

    const child = launch("xcrun", [
      "simctl",
      "io",
      this.udid,
      "recordVideo",
      "--codec",
      this.options.codec ?? "h264",
      "--force",
      this.outputPath
    ]);
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }

  /** Finalize the recording (SIGINT + bounded wait) and keep the file. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;

    if (child.exitCode === null && !child.killed) {
      child.kill("SIGINT");
    }

    const timeout = this.options.finalizeTimeout ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      })
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Finalize and delete — the passing-test path. */
  async discard(): Promise<void> {
    await this.stop();
    rmSync(this.outputPath, { force: true });
  }
}
