import { describe, expect, it } from "vitest";
import { diagnoseAxe } from "../src/index.js";
import type { AxeCommandRunner } from "../src/axe-cli-driver.js";

class ScriptedRunner implements AxeCommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly responses: Record<string, string>,
    private readonly failures: Record<string, Error> = {}
  ) {}

  async run(args: readonly string[]) {
    const key = args.join(" ");
    this.calls.push([...args]);
    const failure = this.failures[key];
    if (failure) throw failure;
    return { stdout: this.responses[key] ?? "", stderr: "" };
  }
}

describe("diagnoseAxe", () => {
  it("reports a healthy AXe binary, booted simulator, tree, and requested screenshot", async () => {
    const runner = new ScriptedRunner({
      "--version": "1.7.1\n",
      "list-simulators": "SIMULATOR-UDID | iPhone 17 | Booted | iPhone 17 | OS 'iOS 26.5'\n",
      "describe-ui --udid SIMULATOR-UDID": JSON.stringify({
        AXRole: "Application",
        AXChildren: [{ AXRole: "Button", AXLabel: "Send" }]
      }),
      "screenshot --output artifacts/doctor.png --udid SIMULATOR-UDID": "artifacts/doctor.png\n"
    });

    const result = await diagnoseAxe({
      udid: "SIMULATOR-UDID",
      runner,
      screenshotPath: "artifacts/doctor.png"
    });

    expect(result).toMatchObject({
      healthy: true,
      axeVersion: "1.7.1",
      accessibilityNodeCount: 2,
      checks: [
        { name: "axe", status: "passed" },
        { name: "simulator", status: "passed" },
        { name: "accessibility", status: "passed" },
        { name: "screenshot", status: "passed" }
      ]
    });
    expect(runner.calls).toEqual([
      ["--version"],
      ["list-simulators"],
      ["describe-ui", "--udid", "SIMULATOR-UDID"],
      ["screenshot", "--output", "artifacts/doctor.png", "--udid", "SIMULATOR-UDID"]
    ]);
  });

  it("keeps independent failures actionable and does not throw", async () => {
    const runner = new ScriptedRunner(
      {
        "list-simulators": "SIMULATOR-UDID | iPhone 17 | Shutdown | iPhone 17 | OS 'iOS 26.5'\n",
        "describe-ui --udid SIMULATOR-UDID": "not json"
      },
      { "--version": new Error("spawn axe ENOENT") }
    );

    const result = await diagnoseAxe({ udid: "SIMULATOR-UDID", runner });

    expect(result.healthy).toBe(false);
    expect(result.checks).toEqual([
      { name: "axe", status: "failed", message: "spawn axe ENOENT" },
      {
        name: "simulator",
        status: "failed",
        message: "Simulator SIMULATOR-UDID is Shutdown, not Booted."
      },
      expect.objectContaining({ name: "accessibility", status: "failed" }),
      { name: "screenshot", status: "skipped", message: "No screenshot path was requested." }
    ]);
  });

  it("reports an unsupported AXe version while retaining later diagnostics", async () => {
    const runner = new ScriptedRunner({
      "--version": "1.8.0\n",
      "list-simulators": "SIMULATOR-UDID | iPhone 17 | Booted | iPhone 17 | OS 'iOS 26.5'\n",
      "describe-ui --udid SIMULATOR-UDID": '{ "AXRole": "Application" }'
    });

    const result = await diagnoseAxe({ udid: "SIMULATOR-UDID", runner });

    expect(result.healthy).toBe(false);
    expect(result.checks).toEqual([
      {
        name: "axe",
        status: "failed",
        message: "AXe 1.8.0 is not supported. Supported versions: 1.7.1."
      },
      expect.objectContaining({ name: "simulator", status: "passed" }),
      expect.objectContaining({ name: "accessibility", status: "passed" }),
      expect.objectContaining({ name: "screenshot", status: "skipped" })
    ]);
  });
});
