import { describe, expect, it } from "vitest";
import {
  AxeCommandError,
  AxeCommandTimeoutError,
  AxeServeDriver,
} from "../src/index.js";
import type { AxeServeProcess } from "../src/index.js";
import type { AxeDriver, AxeTapTarget } from "../src/types.js";

type Listener = (...args: unknown[]) => void;

/**
 * A scriptable serve process: records every protocol line written and
 * answers each with the next scripted response (`ready` is consumed first).
 * Push `undefined` to leave a line unanswered (timeout paths).
 */
class FakeServeProcess implements AxeServeProcess {
  readonly written: string[] = [];
  killed = false;
  private dataListeners: Listener[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(private responses: (string | undefined)[]) {}

  readonly stdin = {
    write: (
      chunk: string,
      callback?: (error?: Error | null) => void,
    ): unknown => {
      this.written.push(chunk.trimEnd());
      callback?.(null);
      const response = this.responses.shift();
      if (response !== undefined) this.emitData(`${response}\n`);
      return true;
    },
  };

  readonly stdout = {
    setEncoding: (): unknown => undefined,
    on: (event: "data", listener: (chunk: string) => void): unknown => {
      if (event === "data") this.dataListeners.push(listener as Listener);
      return undefined;
    },
  };

  on(event: "exit" | "error", listener: Listener): unknown {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...existing, listener]);
    return undefined;
  }

  kill(): unknown {
    this.killed = true;
    return undefined;
  }

  /** Emit the handshake line a real process prints once its session is up. */
  becomeReady(): void {
    this.emitData('{"ready":true}\n');
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  emit(event: "exit" | "error", ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** A driver whose spawns are scripted; hands out one fake process per launch. */
const scriptedDriver = (
  processes: FakeServeProcess[],
  options: { timeoutMs?: number; fallback?: AxeDriver } = {},
): { driver: AxeServeDriver; launches: number } => {
  const state = { launches: 0 };
  const driver = new AxeServeDriver({
    udid: "SIM-UDID",
    binary: "axe-fork",
    timeoutMs: options.timeoutMs ?? 200,
    readyTimeoutMs: 200,
    fallback: options.fallback ?? unusedFallback(),
    launch: () => {
      const child = processes[state.launches];
      if (!child) throw new Error("test scripted too few processes");
      state.launches += 1;
      queueMicrotask(() => child.becomeReady());
      return child;
    },
  });
  return {
    driver,
    get launches() {
      return state.launches;
    },
  };
};

const unusedFallback = (): AxeDriver => ({
  describeUi: async () => {
    throw new Error("fallback should not be used");
  },
  tap: async (_target: AxeTapTarget) => {
    throw new Error("fallback should not be used");
  },
  type: async (_text: string) => {
    throw new Error("fallback should not be used");
  },
  keyCombo: async () => {
    throw new Error("fallback should not be used");
  },
});

describe("AxeServeDriver", () => {
  it("performs the ready handshake once, then one response line per command", async () => {
    const child = new FakeServeProcess([
      '{"ok":true,"tree":{"role":"AXWindow"}}',
      '{"ok":true}',
    ]);
    const { driver } = scriptedDriver([child]);

    expect(await driver.describeUi()).toEqual({ role: "AXWindow" });
    await driver.tap({ kind: "id", id: "send" });

    expect(child.written).toEqual(["describe-ui", "tap --id send"]);
  });

  it("quotes only the tokens the line protocol cannot carry bare", async () => {
    const child = new FakeServeProcess(['{"ok":true}', '{"ok":true}']);
    const { driver } = scriptedDriver([child]);

    await driver.tapLabel('Say "hi" now');
    await driver.type("plain");

    expect(child.written).toEqual([
      'tap --label "Say \\"hi\\" now"',
      "type plain",
    ]);
  });

  it("reassembles responses split across stdout chunks", async () => {
    const child = new FakeServeProcess([undefined]);
    const { driver } = scriptedDriver([child]);

    const pending = driver.describeUi();
    // Let the handshake settle and the command line hit stdin first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emitData('{"ok":true,"tr');
    child.emitData('ee":{"role":"AXWindow"}}\n');

    expect(await pending).toEqual({ role: "AXWindow" });
  });

  it("surfaces ok:false responses as AxeCommandError", async () => {
    const child = new FakeServeProcess([
      '{"ok":false,"error":"No accessibility element matched the label"}',
    ]);
    const { driver } = scriptedDriver([child]);

    await expect(driver.tapLabel("Missing")).rejects.toThrow(AxeCommandError);
    expect(child.killed).toBe(false); // a failed command is not a dead process
  });

  it("redacts typed text from a failed type command", async () => {
    const child = new FakeServeProcess([
      '{"ok":false,"error":"keyboard is not focused"}',
    ]);
    const { driver } = scriptedDriver([child]);

    const failure = await driver
      .type("hunter2 secret")
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(AxeCommandError);
    expect(String(failure)).not.toContain("hunter2");
    expect(String(failure)).toContain("<redacted>");
  });

  it("kills the process on a response timeout and respawns on the next command", async () => {
    const first = new FakeServeProcess([undefined]); // never answers
    const second = new FakeServeProcess(['{"ok":true}']);
    const handles = scriptedDriver([first, second], { timeoutMs: 40 });

    await expect(
      handles.driver.tap({ kind: "point", x: 1, y: 2 }),
    ).rejects.toThrow(AxeCommandTimeoutError);
    expect(first.killed).toBe(true);

    await handles.driver.tap({ kind: "point", x: 1, y: 2 });
    expect(handles.launches).toBe(2);
    expect(second.written).toEqual(["tap -x 1 -y 2"]);
  });

  it("ignores a killed process's late line instead of feeding it to the replacement", async () => {
    const first = new FakeServeProcess([undefined]);
    const second = new FakeServeProcess([
      '{"ok":true,"tree":{"role":"AXWindow"}}',
    ]);
    const handles = scriptedDriver([first, second], { timeoutMs: 40 });

    await expect(handles.driver.describeUi()).rejects.toThrow(
      AxeCommandTimeoutError,
    );

    // The dying first process flushes its (now stale) reply mid-respawn.
    const pending = handles.driver.describeUi();
    first.emitData(
      '{"ok":false,"error":"stale reply from the dead process"}\n',
    );

    expect(await pending).toEqual({ role: "AXWindow" });
  });

  it("recovers from a spawn failure instead of caching the rejected handshake", async () => {
    const broken = new FakeServeProcess([]);
    const healthy = new FakeServeProcess(['{"ok":true}']);
    const state = { launches: 0 };
    const driver = new AxeServeDriver({
      udid: "SIM-UDID",
      binary: "axe-fork",
      timeoutMs: 200,
      readyTimeoutMs: 200,
      fallback: unusedFallback(),
      launch: () => {
        const child = state.launches === 0 ? broken : healthy;
        state.launches += 1;
        queueMicrotask(() =>
          child === broken
            ? child.emit("error", new Error("spawn axe-fork ENOENT"))
            : child.becomeReady(),
        );
        return child;
      },
    });

    await expect(driver.tap({ kind: "id", id: "send" })).rejects.toThrow(
      /ENOENT/,
    );
    await driver.tap({ kind: "id", id: "send" });
    expect(state.launches).toBe(2);
  });

  it("kills the process on a non-JSON response line rather than risk desynchronizing", async () => {
    const child = new FakeServeProcess(["frameworks loaded, listening"]);
    const { driver } = scriptedDriver([child]);

    await expect(driver.describeUi()).rejects.toThrow(/non-JSON/);
    expect(child.killed).toBe(true);
  });

  it("retries an absent label within the client-side wait, interleaving dumps", async () => {
    const child = new FakeServeProcess([
      '{"ok":false,"error":"No accessibility element matched the label"}',
      '{"ok":true,"tree":{}}',
      '{"ok":true}',
    ]);
    const { driver } = scriptedDriver([child]);

    await driver.tapLabel("Allow", 1_000);

    expect(child.written).toEqual([
      "tap --label Allow",
      "describe-ui",
      "tap --label Allow",
    ]);
  });

  it("routes newline-bearing text to the fallback driver", async () => {
    const typed: string[] = [];
    const child = new FakeServeProcess([]);
    const { driver } = scriptedDriver([child], {
      fallback: {
        ...unusedFallback(),
        type: async (text: string) => {
          typed.push(text);
        },
      },
    });

    await driver.type("line one\nline two");

    expect(typed).toEqual(["line one\nline two"]);
    expect(child.written).toEqual([]); // never even spawned a command
  });

  it("dispose kills the process and a later command starts fresh", async () => {
    const first = new FakeServeProcess(['{"ok":true}']);
    const second = new FakeServeProcess(['{"ok":true}']);
    const handles = scriptedDriver([first, second]);

    await handles.driver.tap({ kind: "id", id: "send" });
    handles.driver.dispose();
    expect(first.killed).toBe(true);

    await handles.driver.tap({ kind: "id", id: "send" });
    expect(handles.launches).toBe(2);
  });
});
