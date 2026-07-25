import { execFileSync, spawn } from "node:child_process";
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
  /**
   * Ceiling on a single recording. A run that outlives this is finalized
   * anyway: an unbounded recorder both fills the disk and holds the device.
   * Defaults to 30 minutes; set 0 to disable.
   */
  maxDuration?: number;
  /**
   * Kill recorders already attached to this udid before starting. Scoped to
   * the one device so parallel runs on other simulators are untouched.
   * Injectable for tests; set null to skip the sweep.
   */
  sweepStale?: ((udid: string) => void) | null;
}

/** Every recorder currently holding a device, for the process-exit sweep. */
const liveRecorders = new Set<SimulatorVideoRecorder>();
let exitHooksInstalled = false;

/**
 * A recorder that outlives its parent keeps growing the file forever AND
 * blocks `simctl shutdown` on that device, which wedges the next run. Node
 * fires no 'exit' event for an unhandled SIGINT/SIGTERM, so those need their
 * own handlers; everything else (normal return, uncaught exception) lands on
 * 'exit'. All of this must be synchronous — 'exit' cannot await.
 */
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  process.on("exit", () => {
    for (const recorder of [...liveRecorders]) recorder.finalizeSync();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const recorder of [...liveRecorders]) recorder.finalizeSync();
      // Re-raise now that our one-shot listener is spent, so the host's own
      // handling — or the default termination — still happens.
      process.kill(process.pid, signal);
    });
  }
}

/** SIGINT (not SIGTERM) so an orphan still finalizes a playable container. */
function defaultSweepStale(udid: string): void {
  try {
    execFileSync("pkill", ["-INT", "-f", `simctl io ${udid} recordVideo`], {
      stdio: "ignore",
    });
  } catch {
    // pkill exits non-zero when nothing matched — the common, healthy case.
  }
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
 *
 * An abandoned recorder is worse than a lost video: it grows the file without
 * limit and holds the device, so the next `simctl shutdown` hangs. Three
 * guards, since none covers every way a run can die — exit hooks (host exits
 * or is signalled), a duration ceiling (host lives but the run never ends),
 * and a start-time sweep of this udid (host was SIGKILLed, so nothing in-
 * process could have run at all).
 */
export class SimulatorVideoRecorder {
  private child: VideoRecorderProcess | undefined;
  private exited: Promise<void> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly udid: string,
    readonly outputPath: string,
    private readonly options: SimulatorVideoRecorderOptions = {},
  ) {}

  start(): void {
    const sweep =
      this.options.sweepStale === undefined
        ? defaultSweepStale
        : this.options.sweepStale;
    sweep?.(this.udid);

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
      this.outputPath,
    ]);
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    installExitHooks();
    liveRecorders.add(this);

    const maxDuration = this.options.maxDuration ?? 30 * 60_000;
    if (maxDuration > 0) {
      this.watchdog = setTimeout(() => void this.stop(), maxDuration);
      // Never keep the process alive purely to wait out the ceiling.
      this.watchdog.unref?.();
    }
  }

  /**
   * Last-resort finalization for the process-exit path: signal and return,
   * because 'exit' handlers cannot await. Enough to release the device and
   * stop the file growing.
   */
  finalizeSync(): void {
    const child = this.child;
    this.forget();
    if (!child) return;
    if (child.exitCode === null && !child.killed) child.kill("SIGINT");
  }

  private forget(): void {
    this.child = undefined;
    liveRecorders.delete(this);
    if (this.watchdog !== undefined) {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /** Finalize the recording (SIGINT + bounded wait) and keep the file. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.forget();

    if (child.exitCode === null && !child.killed) {
      child.kill("SIGINT");
    }

    const timeout = this.options.finalizeTimeout ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Finalize and delete — the passing-test path. */
  async discard(): Promise<void> {
    await this.stop();
    rmSync(this.outputPath, { force: true });
  }
}
