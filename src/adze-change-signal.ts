import { spawn } from "node:child_process";
import type { SignalWatcherProcess, UiChangeSignal } from "./change-signal.js";

export interface AdzeChangeSignalOptions {
  /** The emulator's adb serial, e.g. `emulator-5554`. */
  serial: string;
  /** The adze binary. Default: `adze` on PATH. */
  binary?: string;
  /** Process launcher override; defaults to node's spawn with piped stdout. */
  launch?: (command: string, args: readonly string[]) => SignalWatcherProcess;
}

/**
 * A `UiChangeSignal` for Android emulators: one persistent
 * `adze watch-changes` process, which prints a line whenever the system's
 * accessibility events say the screen may have changed. Unlike the iOS
 * notification bridge, the app under test needs nothing added.
 *
 * Started lazily by `ensureWatching()`, and started again the same way if it
 * dies (adze exits when the device server goes away); killed on `dispose()`.
 */
export class AdzeChangeSignal implements UiChangeSignal {
  private readonly listeners = new Set<() => void>();
  private watcher: SignalWatcherProcess | undefined;
  private disposed = false;
  private readonly launch: (
    command: string,
    args: readonly string[],
  ) => SignalWatcherProcess;

  constructor(private readonly options: AdzeChangeSignalOptions) {
    this.launch =
      options.launch ??
      ((command, args) =>
        spawn(command, [...args], {
          stdio: ["ignore", "pipe", "ignore"],
        }) as unknown as SignalWatcherProcess);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureWatching(): void {
    if (this.disposed) return;
    if (this.watcher && this.watcher.exitCode === null) return;

    const watcher = this.launch(this.options.binary ?? "adze", [
      "watch-changes",
      "--serial",
      this.options.serial,
    ]);
    watcher.stdout.setEncoding("utf8");
    // One line per change; a chunk carrying several still means "changed".
    watcher.stdout.on("data", () => this.emit());
    watcher.on("exit", () => this.clear(watcher));
    watcher.on("error", () => this.clear(watcher));
    this.watcher = watcher;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.kill();
    this.watcher = undefined;
    this.listeners.clear();
  }

  private clear(watcher: SignalWatcherProcess): void {
    if (this.watcher === watcher) this.watcher = undefined;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
