import { describe, expect, it } from "vitest";
import { AxeCliDriver } from "../src/index.js";
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
});
