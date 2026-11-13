import { existsSync, readFileSync } from "node:fs";
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
 * Reply lines as each serve prints them, recorded from real binaries (the
 * fork's v2.0.4-serve.2 and upstream AXe main after its serve mode landed)
 * against a simulator's home screen. The UDID and the accessibility tree
 * are replaced with synthetic values; the envelopes are verbatim.
 */
const NOT_FOUND =
  "No accessibility element matched --label 'Example Missing'. Make sure the app is on the expected screen, then run `axe describe-ui --udid <SIMULATOR_UDID>` and prefer --id when available.";
const TREE = [{ type: "Application", AXLabel: "Example App", children: [] }];
const FORK = {
  ready: '{"ready":true}',
  pong: '{"pong":true,"ok":true}',
  tapOk: '{"ok":true}',
  notFound: JSON.stringify({ ok: false, error: NOT_FOUND }),
  tree: JSON.stringify({ ok: true, tree: TREE }),
};
const upstreamLine = (
  command: string,
  data: Record<string, unknown>,
  error?: { code: string; message: string },
): string =>
  JSON.stringify({
    command,
    data,
    didError: error !== undefined,
    ...(error ? { error } : {}),
    nextSteps: [],
    schema: "axe.output.command-result",
    schemaVersion: "1",
  });
const UPSTREAM = {
  ready:
    '{"command":"serve","data":{"result":{"ready":true,"udid":"SIM-UDID"}},"didError":false,"nextSteps":[],"schema":"axe.output.command-result","schemaVersion":"1"}',
  pong: '{"command":"ping","data":{"result":{"pong":true}},"didError":false,"nextSteps":[],"schema":"axe.output.command-result","schemaVersion":"1"}',
  tapOk:
    '{"command":"tap","data":{"messages":["✓ Tap at (1.0, 1.0) completed successfully"],"result":{"outcome":"completed"}},"didError":false,"nextSteps":[],"schema":"axe.output.command-result","schemaVersion":"1"}',
  notFound: upstreamLine(
    "tap",
    {},
    { code: "elementNotFound", message: NOT_FOUND },
  ),
  refusedBatch:
    '{"command":"batch","data":{},"didError":true,"error":{"code":"invalidArguments","message":"serve runs describe-ui, displays, screenshot, tap, swipe, drag, draw, type, button, key, key-sequence, key-combo, touch, gesture, slider, rotate, hinge and ping; `batch` is not one of them."},"nextSteps":[],"schema":"axe.output.command-result","schemaVersion":"1"}',
  tree: upstreamLine("describe-ui", { result: TREE }),
};

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
  becomeReady(line = FORK.ready): void {
    this.emitData(`${line}\n`);
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
  options: {
    timeoutMs?: number;
    fallback?: AxeDriver;
    readyLine?: string;
    minimalKeys?: boolean;
  } = {},
): { driver: AxeServeDriver; launches: number } => {
  const state = { launches: 0 };
  const driver = new AxeServeDriver({
    udid: "SIM-UDID",
    binary: "axe-fork",
    timeoutMs: options.timeoutMs ?? 200,
    readyTimeoutMs: 200,
    fallback: options.fallback ?? unusedFallback(),
    ...(options.minimalKeys === undefined
      ? {}
      : { minimalKeys: options.minimalKeys }),
    launch: () => {
      const child = processes[state.launches];
      if (!child) throw new Error("test scripted too few processes");
      state.launches += 1;
      queueMicrotask(() => child.becomeReady(options.readyLine));
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

/** The file a `type --file <path>` protocol line names, if it is one. */
const typeFilePath = (line: string): string | undefined =>
  /^type --file (\S+)$/.exec(line.trimEnd())?.[1];

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

  it("types newline-bearing text through serve from a file it removes afterwards", async () => {
    const child = new FakeServeProcess(['{"ok":true}']);
    const { driver } = scriptedDriver([child]);
    const text = "line one\nline two\r\nline three";
    let fileContents: string | undefined;
    const write = child.stdin.write;
    child.stdin.write = (chunk, callback) => {
      const path = typeFilePath(chunk);
      if (path) fileContents = readFileSync(path, "utf8");
      return write(chunk, callback);
    };

    await driver.type(text);

    expect(child.written).toHaveLength(1);
    const path = typeFilePath(child.written[0] ?? "");
    expect(path).toBeDefined();
    expect(fileContents).toBe(text);
    expect(existsSync(path!)).toBe(false);
  });

  it("removes the text file when serve rejects the type command", async () => {
    const child = new FakeServeProcess([
      '{"ok":false,"error":"no focused field"}',
    ]);
    const { driver } = scriptedDriver([child]);

    await expect(driver.type("a\nb")).rejects.toThrow("no focused field");

    expect(existsSync(typeFilePath(child.written[0] ?? "")!)).toBe(false);
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

  describe("upstream AXe serve", () => {
    it("handshakes on the command-result ready line and reads the tree from data.result", async () => {
      const child = new FakeServeProcess([UPSTREAM.tree, UPSTREAM.tapOk]);
      const { driver } = scriptedDriver([child], {
        readyLine: UPSTREAM.ready,
      });

      expect(await driver.describeUi()).toEqual(TREE);
      await driver.tap({ kind: "point", x: 1, y: 1 });

      expect(driver.dialect).toBe("upstream");
      expect(child.written).toEqual(["describe-ui", "tap -x 1 -y 1"]);
    });

    it("surfaces didError replies with the error's message", async () => {
      const child = new FakeServeProcess([UPSTREAM.notFound]);
      const { driver } = scriptedDriver([child], {
        readyLine: UPSTREAM.ready,
      });

      const failure = await driver
        .tapLabel("Example Missing")
        .catch((error: Error) => error);

      expect(failure).toBeInstanceOf(AxeCommandError);
      expect(String(failure)).toContain("No accessibility element matched");
      expect(child.killed).toBe(false);
    });

    it("surfaces a refused line as a failed command, not a dead process", async () => {
      const child = new FakeServeProcess([UPSTREAM.refusedBatch]);
      const { driver } = scriptedDriver([child], {
        readyLine: UPSTREAM.ready,
      });

      await expect(driver.tap({ kind: "id", id: "send" })).rejects.toThrow(
        /is not one of them/,
      );
      expect(child.killed).toBe(false);
    });

    it("retries an absent label, reading the absence from error.message", async () => {
      const child = new FakeServeProcess([
        UPSTREAM.notFound,
        UPSTREAM.tree,
        UPSTREAM.tapOk,
      ]);
      const { driver } = scriptedDriver([child], {
        readyLine: UPSTREAM.ready,
      });

      await driver.tapLabel("Allow", 1_000);

      expect(child.written).toEqual([
        "tap --label Allow",
        "describe-ui",
        "tap --label Allow",
      ]);
    });

    it("asks for minimal keys on every dump, including the first after a spawn", async () => {
      const child = new FakeServeProcess([
        UPSTREAM.tree,
        UPSTREAM.notFound,
        UPSTREAM.tree,
        UPSTREAM.tapOk,
      ]);
      const { driver } = scriptedDriver([child], {
        readyLine: UPSTREAM.ready,
        minimalKeys: true,
      });

      await driver.describeUi();
      await driver.tapLabel("Allow", 1_000);

      expect(child.written).toEqual([
        "describe-ui --minimal-keys",
        "tap --label Allow",
        "describe-ui --minimal-keys",
        "tap --label Allow",
      ]);
    });

    it("refuses a ready line that reports an error", async () => {
      const child = new FakeServeProcess([]);
      const { driver } = scriptedDriver([child], {
        readyLine: upstreamLine(
          "serve",
          {},
          { code: "simulatorNotBooted", message: "not booted" },
        ),
      });

      await expect(driver.describeUi()).rejects.toThrow(/never became ready/);
      expect(child.killed).toBe(true);
    });
  });

  describe("fork serve (recorded lines)", () => {
    it("handshakes on {ready:true} and reads ok/error/tree", async () => {
      const child = new FakeServeProcess([FORK.tree, FORK.notFound]);
      const { driver } = scriptedDriver([child], { readyLine: FORK.ready });

      expect(await driver.describeUi()).toEqual(TREE);
      await expect(driver.tapLabel("Example Missing")).rejects.toThrow(
        /No accessibility element matched/,
      );
      expect(driver.dialect).toBe("fork");
    });

    it("leaves minimal keys to the launch arguments, never the dump line", async () => {
      const child = new FakeServeProcess([FORK.tree]);
      const { driver } = scriptedDriver([child], {
        readyLine: FORK.ready,
        minimalKeys: true,
      });

      await driver.describeUi();

      expect(child.written).toEqual(["describe-ui"]);
    });
  });

  it("kills the process on a JSON line that is neither protocol's reply", async () => {
    const child = new FakeServeProcess(["[1,2,3]"]);
    const { driver } = scriptedDriver([child]);

    await expect(driver.describeUi()).rejects.toThrow(/unrecognized/);
    expect(child.killed).toBe(true);
  });

  it("forgets the dialect when the process is disposed", async () => {
    const child = new FakeServeProcess([UPSTREAM.tapOk]);
    const { driver } = scriptedDriver([child], { readyLine: UPSTREAM.ready });

    await driver.tap({ kind: "id", id: "send" });
    driver.dispose();

    expect(driver.dialect).toBeUndefined();
  });
});
