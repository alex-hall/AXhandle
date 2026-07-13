import { describe, expect, it } from "vitest";
import {
  UnsupportedBiometricController,
  XcrunSimulatorController
} from "../src/index.js";
import type { SimulatorCommandRunner } from "../src/simulator-control.js";

class RecordingRunner implements SimulatorCommandRunner {
  readonly calls: Array<{ args: string[]; environment?: Readonly<Record<string, string>> }> = [];

  async run(
    args: readonly string[],
    options: { environment?: Readonly<Record<string, string>> } = {}
  ) {
    this.calls.push({ args: [...args], environment: options.environment });
    return { stdout: "dev.example.app: 1234\n", stderr: "" };
  }
}

describe("XcrunSimulatorController", () => {
  it("keeps simulator lifecycle and permission commands shell-free and explicit", async () => {
    const runner = new RecordingRunner();
    const controller = new XcrunSimulatorController(runner);

    await controller.install("SIMULATOR", "/tmp/Example.app");
    await expect(controller.launch({
      udid: "SIMULATOR",
      bundleId: "dev.example.app",
      arguments: ["--e2e"],
      environment: { SAMPLE_MODE: "alice" },
      terminateRunning: true
    })).resolves.toEqual({ pid: 1234 });
    await controller.terminate("SIMULATOR", "dev.example.app");
    await controller.grantPermission("SIMULATOR", "photos", "dev.example.app");
    await controller.revokePermission("SIMULATOR", "photos", "dev.example.app");
    await controller.resetPermissions("SIMULATOR");
    await controller.erase("SIMULATOR");

    expect(runner.calls).toEqual([
      { args: ["install", "SIMULATOR", "/tmp/Example.app"], environment: undefined },
      {
        args: ["launch", "--terminate-running-process", "SIMULATOR", "dev.example.app", "--e2e"],
        environment: { SIMCTL_CHILD_SAMPLE_MODE: "alice" }
      },
      { args: ["terminate", "SIMULATOR", "dev.example.app"], environment: undefined },
      { args: ["privacy", "SIMULATOR", "grant", "photos", "dev.example.app"], environment: undefined },
      { args: ["privacy", "SIMULATOR", "revoke", "photos", "dev.example.app"], environment: undefined },
      { args: ["privacy", "SIMULATOR", "reset", "all"], environment: undefined },
      { args: ["erase", "SIMULATOR"], environment: undefined }
    ]);
  });
});

describe("UnsupportedBiometricController", () => {
  it("fails explicitly instead of treating Face ID as an AXe capability", async () => {
    const controller = new UnsupportedBiometricController();

    await expect(controller.match("SIMULATOR")).rejects.toThrow(
      "Inject a verified BiometricController implementation"
    );
  });
});
