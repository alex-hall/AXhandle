import { describe, expect, it } from "vitest";
import {
  AxeEventCachedDriver,
  Device,
  NotifyutilChangeSignal,
} from "../src/index.js";
import type { SignalWatcherProcess, UiChangeSignal } from "../src/index.js";
import type { AxeDriver, AxeTapTarget } from "../src/types.js";

/** A manually-fired change signal with call accounting. */
class FakeSignal implements UiChangeSignal {
  private readonly listeners = new Set<() => void>();
  ensureCalls = 0;
  disposed = false;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureWatching(): void {
    this.ensureCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  fire(): void {
    for (const listener of this.listeners) listener();
  }
}

class CountingDriver implements AxeDriver {
  dumps = 0;
  taps = 0;
  disposeCalls = 0;
  /** When set, describeUi blocks until the caller resolves it. */
  gate: Promise<void> | undefined;

  async describeUi(): Promise<unknown> {
    this.dumps += 1;
    if (this.gate) await this.gate;
    return { role_description: "application", children: [], dump: this.dumps };
  }

  async tap(_target: AxeTapTarget): Promise<void> {
    this.taps += 1;
  }

  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}

  dispose(): void {
    this.disposeCalls += 1;
  }
}

const wallWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("AxeEventCachedDriver caching", () => {
  it("serves repeated dumps from cache until a change event lands", async () => {
    const inner = new CountingDriver();
    const signal = new FakeSignal();
    const driver = new AxeEventCachedDriver(inner, { signal });

    await driver.describeUi();
    await driver.describeUi();
    await driver.describeUi();
    expect(inner.dumps).toBe(1);

    signal.fire();
    await driver.describeUi();
    await driver.describeUi();
    expect(inner.dumps).toBe(2);
  });

  it("marks the screen dirty on every interaction", async () => {
    const inner = new CountingDriver();
    const driver = new AxeEventCachedDriver(inner, {
      signal: new FakeSignal(),
    });

    await driver.describeUi();
    await driver.tap({ kind: "point", x: 1, y: 1 });
    await driver.describeUi();
    expect(inner.dumps).toBe(2);

    await driver.type("hello");
    await driver.describeUi();
    expect(inner.dumps).toBe(3);
  });

  it("re-dumps after maxStalenessMs even with no event — beacon-blind UI", async () => {
    const inner = new CountingDriver();
    const driver = new AxeEventCachedDriver(inner, {
      signal: new FakeSignal(),
      maxStalenessMs: 30,
    });

    await driver.describeUi();
    await driver.describeUi();
    expect(inner.dumps).toBe(1);

    await wallWait(50);
    await driver.describeUi();
    expect(inner.dumps).toBe(2);
  });

  it("over-invalidates on an event that lands mid-dump", async () => {
    const inner = new CountingDriver();
    const signal = new FakeSignal();
    const driver = new AxeEventCachedDriver(inner, { signal });

    let release!: () => void;
    inner.gate = new Promise((resolve) => {
      release = resolve;
    });

    // The event fires while the dump is in flight: the dump's result may or
    // may not include the change, so the flag must survive the dump and
    // force a re-dump on the next read.
    const pending = driver.describeUi();
    signal.fire();
    release();
    await pending;
    inner.gate = undefined;

    await driver.describeUi();
    expect(inner.dumps).toBe(2);
  });

  it("only offers the capabilities the wrapped driver has", () => {
    const bare = new AxeEventCachedDriver(new CountingDriver(), {
      signal: new FakeSignal(),
    });
    expect(bare.tapLabel).toBeUndefined();
    expect(bare.swipe).toBeUndefined();
    expect(bare.longPress).toBeUndefined();
    expect(bare.screenshot).toBeUndefined();

    const labelTaps: string[] = [];
    const capable = new AxeEventCachedDriver(
      Object.assign(new CountingDriver(), {
        tapLabel: async (label: string) => {
          labelTaps.push(label);
        },
      }),
      { signal: new FakeSignal() },
    );
    expect(capable.tapLabel).toBeDefined();
  });

  it("disposes the signal and the wrapped driver it owns", () => {
    const inner = new CountingDriver();
    const signal = new FakeSignal();
    const driver = new AxeEventCachedDriver(inner, { signal });

    driver.dispose();

    expect(signal.disposed).toBe(true);
    expect(inner.disposeCalls).toBe(1);
  });
});

describe("AxeEventCachedDriver sleepUntilChange", () => {
  it("ends early the moment a change event lands", async () => {
    const inner = new CountingDriver();
    const signal = new FakeSignal();
    const driver = new AxeEventCachedDriver(inner, { signal });

    await driver.describeUi(); // clears the initial dirty flag

    const startedAt = Date.now();
    const sleep = driver.sleepUntilChange(5_000);
    setTimeout(() => signal.fire(), 20);
    await sleep;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("falls back to the full duration when nothing changes", async () => {
    const driver = new AxeEventCachedDriver(new CountingDriver(), {
      signal: new FakeSignal(),
    });
    await driver.describeUi();

    const startedAt = Date.now();
    await driver.sleepUntilChange(40);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it("floors the sleep on an already-dirty screen instead of spinning", async () => {
    const driver = new AxeEventCachedDriver(new CountingDriver(), {
      signal: new FakeSignal(),
      minPollMs: 30,
    });
    // No dump yet: the screen starts dirty, as it does mid-animation.

    const startedAt = Date.now();
    await driver.sleepUntilChange(5_000);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("Device with a change-observing driver", () => {
  it("wakes waits early instead of waiting out the poll interval", async () => {
    // The target appears 30ms in; the poll interval is far larger than the
    // test timeout, so only an early wake can pass.
    const inner = new CountingDriver();
    const signal = new FakeSignal();
    const driver = new AxeEventCachedDriver(inner, { signal });
    const device = new Device("primary", driver, {
      timeouts: { assertion: 10_000, interval: 60_000 },
    });

    let arrived = false;
    const originalDescribeUi = inner.describeUi.bind(inner);
    inner.describeUi = async () => {
      await originalDescribeUi();
      return {
        role_description: "application",
        children: arrived
          ? [
              {
                role_description: "statictext",
                AXLabel: "Welcome",
                children: [],
              },
            ]
          : [],
      };
    };
    setTimeout(() => {
      arrived = true;
      signal.fire();
    }, 30);

    const startedAt = Date.now();
    await device.findByLabel("Welcome").waitForPresent();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("lets an explicit clock win over the driver's change sleep", async () => {
    let changeSleeps = 0;
    const inner = new CountingDriver();
    const driver = new AxeEventCachedDriver(inner, {
      signal: new FakeSignal(),
    });
    const observed = Object.assign(driver, {
      sleepUntilChange: async (_milliseconds: number) => {
        changeSleeps += 1;
      },
    });

    let time = 0;
    const device = new Device("primary", observed, {
      clock: {
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      },
      timeouts: { assertion: 500, interval: 100 },
    });

    await expect(
      device.findByLabel("Missing").waitForPresent(),
    ).rejects.toThrow("never appeared");
    expect(changeSleeps).toBe(0);
  });

  it("wallSleep always elapses in real time", async () => {
    const device = new Device("primary", new CountingDriver());
    const startedAt = Date.now();
    await device.wallSleep(30);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });
});

describe("NotifyutilChangeSignal", () => {
  class FakeWatcher implements SignalWatcherProcess {
    exitCode: number | null = null;
    killed = false;
    private dataListener: ((chunk: string) => void) | undefined;
    private exitListener: (() => void) | undefined;

    readonly stdout = {
      setEncoding: (_encoding: "utf8") => undefined,
      on: (event: "data", listener: (chunk: string) => void) => {
        if (event === "data") this.dataListener = listener;
        return undefined;
      },
    };

    on(event: "exit" | "error", listener: (...args: unknown[]) => void): void {
      if (event === "exit") this.exitListener = () => listener();
    }

    kill(): void {
      this.killed = true;
      this.die();
    }

    emitLine(): void {
      this.dataListener?.("io.example.changed\n");
    }

    die(): void {
      this.exitCode = 0;
      this.exitListener?.();
    }
  }

  const watchedSignal = () => {
    const launches: Array<{ command: string; args: readonly string[] }> = [];
    const watchers: FakeWatcher[] = [];
    const signal = new NotifyutilChangeSignal({
      udid: "SIMULATOR",
      notification: "io.example.changed",
      launch: (command, args) => {
        launches.push({ command, args });
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher;
      },
    });
    return { signal, launches, watchers };
  };

  it("spawns one notifyutil watcher and forwards its fires", () => {
    const { signal, launches, watchers } = watchedSignal();
    let fires = 0;
    signal.subscribe(() => {
      fires += 1;
    });

    signal.ensureWatching();
    signal.ensureWatching();
    expect(launches).toEqual([
      {
        command: "xcrun",
        args: [
          "simctl",
          "spawn",
          "SIMULATOR",
          "notifyutil",
          "-w",
          "io.example.changed",
        ],
      },
    ]);

    watchers[0]?.emitLine();
    watchers[0]?.emitLine();
    expect(fires).toBe(2);
  });

  it("restarts a dead watcher lazily on the next ensureWatching", () => {
    const { signal, launches, watchers } = watchedSignal();

    signal.ensureWatching();
    watchers[0]?.die(); // a simulator reboot kills spawned processes
    signal.ensureWatching();

    expect(launches).toHaveLength(2);
  });

  it("dispose kills the watcher and stops any restart", () => {
    const { signal, launches, watchers } = watchedSignal();

    signal.ensureWatching();
    signal.dispose();
    signal.ensureWatching();

    expect(watchers[0]?.killed).toBe(true);
    expect(launches).toHaveLength(1);
  });
});
