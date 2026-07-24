import { describe, expect, it } from "vitest";
import { AxeCliDriver, AxeCommandError, AxeCommandTimeoutError, NodeAxeCommandRunner } from "../src/index.js";
import type { AxeCommandRunner } from "../src/axe-cli-driver.js";

class RecordingRunner implements AxeCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly stdout = "{}") {}

  async run(args: readonly string[]) {
    this.calls.push([...args]);
    return { stdout: this.stdout, stderr: "" };
  }
}

describe("AxeCliDriver", () => {
  it("keeps AXe CLI argument construction behind the typed driver", async () => {
    const runner = new RecordingRunner('{ "AXRole": "Application" }');
    const driver = new AxeCliDriver({ udid: "SIMULATOR-UDID", runner });

    await driver.describeUi();
    await driver.tap({ kind: "id", id: "send" });
    await driver.tap({ kind: "point", x: 20, y: 40 });
    await driver.type("Hello");
    await driver.keyCombo([227], 4);
    await driver.screenshot("artifacts/primary.png");

    expect(runner.calls).toEqual([
      ["describe-ui", "--udid", "SIMULATOR-UDID"],
      ["tap", "--id", "send", "--udid", "SIMULATOR-UDID"],
      ["tap", "-x", "20", "-y", "40", "--udid", "SIMULATOR-UDID"],
      ["type", "Hello", "--udid", "SIMULATOR-UDID"],
      ["key-combo", "--modifiers", "227", "--key", "4", "--udid", "SIMULATOR-UDID"],
      [
        "screenshot",
        "--output",
        "artifacts/primary.png",
        "--udid",
        "SIMULATOR-UDID"
      ]
    ]);
  });

  it("builds label-tap and swipe invocations with seconds at the CLI boundary", async () => {
    const runner = new RecordingRunner();
    const driver = new AxeCliDriver({ udid: "SIMULATOR-UDID", runner });

    await driver.tapLabel("Allow", 5_000);
    await driver.tapLabel("Allow");
    await driver.swipe({ startX: 200, startY: 650, endX: 200, endY: 250, durationMs: 400 });
    await driver.swipe({ startX: 0, startY: 0, endX: 0, endY: 100 });

    expect(runner.calls).toEqual([
      ["tap", "--label", "Allow", "--wait-timeout", "5", "--udid", "SIMULATOR-UDID"],
      ["tap", "--label", "Allow", "--udid", "SIMULATOR-UDID"],
      [
        "swipe",
        "--start-x",
        "200",
        "--start-y",
        "650",
        "--end-x",
        "200",
        "--end-y",
        "250",
        "--duration",
        "0.4",
        "--udid",
        "SIMULATOR-UDID"
      ],
      [
        "swipe",
        "--start-x",
        "0",
        "--start-y",
        "0",
        "--end-x",
        "0",
        "--end-y",
        "100",
        "--udid",
        "SIMULATOR-UDID"
      ]
    ]);
  });

  it("long-presses as touch-down, wall-clock hold, touch-up", async () => {
    const runner = new RecordingRunner();
    const driver = new AxeCliDriver({ udid: "SIMULATOR-UDID", runner });

    const startedAt = Date.now();
    await driver.longPress(120, 340, 50);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(runner.calls).toEqual([
      ["touch", "-x", "120", "-y", "340", "--down", "--udid", "SIMULATOR-UDID"],
      ["touch", "-x", "120", "-y", "340", "--up", "--udid", "SIMULATOR-UDID"],
    ]);
  });

  it("keeps a missing AXe executable actionable", async () => {
    const binary = "/tmp/axhandle-missing-binary";
    const runner = new NodeAxeCommandRunner(binary);
    let received: unknown;

    try {
      await runner.run(["--version"]);
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toContain(binary);
    expect((received as Error).message).toContain("ENOENT");
  });

  it("kills a hung CLI process at the hard deadline with a typed error", async () => {
    // A wedged axe process has been observed sitting for hundreds of
    // seconds; the runner must kill it rather than freeze every wait
    // built on top. node stands in for a hang that never returns.
    const runner = new NodeAxeCommandRunner(process.execPath, { timeoutMs: 300 });
    let received: unknown;

    try {
      await runner.run(["-e", "setTimeout(() => {}, 60000)"]);
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(AxeCommandTimeoutError);
    expect((received as AxeCommandTimeoutError).timeoutMs).toBe(300);
    expect((received as Error).message).toContain("hard deadline");
  });

  it("extends the deadline past an explicit --wait-timeout instead of racing it", async () => {
    // tap --wait-timeout N legitimately polls inside the CLI for N
    // seconds — the kill deadline must be N plus a margin, never the
    // flat cap. The stand-in process outlives the 200ms cap but stays
    // within the derived 1s-wait deadline.
    const runner = new NodeAxeCommandRunner(process.execPath, { timeoutMs: 200 });

    await expect(
      runner.run(["-e", "setTimeout(() => {}, 700)", "--", "--wait-timeout", "1"])
    ).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it("redacts entered text from command errors and their public details", () => {
    const enteredText = "test-only-secret";
    const cause = new Error(`Command failed: axe type ${enteredText}`);
    const error = new AxeCommandError(
      ["type", enteredText, "--udid", "SIMULATOR-UDID"],
      `AXe could not type ${enteredText}`,
      cause
    );

    expect(error.args).toEqual(["type", "<redacted>", "--udid", "SIMULATOR-UDID"]);
    expect(error.stderr).toBe("AXe could not type <redacted>");
    expect(error.message).not.toContain(enteredText);
    expect(error.message).toContain("axe type <redacted> --udid SIMULATOR-UDID");
    expect(error.cause).toBeUndefined();
  });
});
