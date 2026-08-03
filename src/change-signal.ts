import { spawn } from "node:child_process";

/**
 * A source of "the screen may have changed" events for one simulator.
 *
 * This is the seam between AXhandle and however an app announces its UI
 * changes. `AxeEventCachedDriver` consumes one to serve accessibility dumps
 * from cache between changes and to end poll sleeps early the moment a
 * change lands. The reference implementation is `NotifyutilChangeSignal`
 * (Darwin notifications); anything that can call a listener works — a
 * WebSocket from the app, a file watcher, a test fake.
 */
export interface UiChangeSignal {
  /**
   * Deliver every change event to `listener` until the returned
   * unsubscribe function is called.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Idempotent lazy-start hook. Consumers call it on their hot paths
   * (every dump, every sleep), so a watcher that died — a simulator
   * reboot kills its spawned processes — restarts on next use instead of
   * needing a supervision loop. Implementations without a process to
   * watch can no-op.
   */
  ensureWatching(): void;

  /** Stop watching and release any held process. Idempotent. */
  dispose(): void;
}

/** The slice of a child process the watcher needs; injectable for tests. */
export interface SignalWatcherProcess {
  readonly stdout: {
    setEncoding(encoding: "utf8"): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  /** `null` while the process is alive. */
  readonly exitCode: number | null;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(): unknown;
}

export interface NotifyutilChangeSignalOptions {
  udid: string;
  /**
   * The Darwin notification name the app posts on UI change, for example
   * `dev.example.ui.changed`. The app side is consumer-owned: post it from
   * any UI-change hook (on React Native, a Fabric mount-transaction
   * observer is the natural spot). Names are per-simulator — each
   * simulator runs its own notifyd — so parallel devices never hear each
   * other's beacons.
   */
  notification: string;
  /** Process launcher override; defaults to node's spawn with piped stdout. */
  launch?: (command: string, args: readonly string[]) => SignalWatcherProcess;
}

/**
 * A `UiChangeSignal` over the simulator's Darwin notification bridge: one
 * persistent `xcrun simctl spawn <udid> notifyutil -w <name>` watcher,
 * emitting a change event per posted notification.
 *
 * The watcher is started lazily by `ensureWatching()` and restarted the
 * same way if it dies; it is killed on `dispose()` and also exits with the
 * parent process (its pipes close). This is the listening half only — the
 * app under test must post the notification; see
 * `NotifyutilChangeSignalOptions.notification`.
 */
export class NotifyutilChangeSignal implements UiChangeSignal {
  private readonly listeners = new Set<() => void>();
  private watcher: SignalWatcherProcess | undefined;
  private disposed = false;
  private readonly launch: (
    command: string,
    args: readonly string[],
  ) => SignalWatcherProcess;

  constructor(private readonly options: NotifyutilChangeSignalOptions) {
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

    const watcher = this.launch("xcrun", [
      "simctl",
      "spawn",
      this.options.udid,
      "notifyutil",
      "-w",
      this.options.notification,
    ]);
    watcher.stdout.setEncoding("utf8");
    // One stdout line per notification fire; the content is irrelevant.
    watcher.stdout.on("data", () => this.emit());
    // 'error' must be handled: an unlistened error event (spawn failure)
    // would crash the process. Either way the watcher slot is cleared so
    // the next ensureWatching() retries.
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
