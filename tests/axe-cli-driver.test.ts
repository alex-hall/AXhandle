import { describe, expect, it } from "vitest";
import { AxeCliDriver, AxeCommandError, NodeAxeCommandRunner } from "../src/index.js";
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
