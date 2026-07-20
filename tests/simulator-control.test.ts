import { describe, expect, it } from "vitest";
import {
  NotifyutilBiometricController,
  SimulatorCommandError,
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

describe("XcrunSimulatorController app lifecycle additions", () => {
  it("covers uninstall, container queries, and keychain reset", async () => {
    const runner = new RecordingRunner();
    const controller = new XcrunSimulatorController(runner);

    await controller.uninstall("SIMULATOR", "dev.example.app");
    await controller.resetKeychain("SIMULATOR");
    await controller.appContainerPath("SIMULATOR", "dev.example.app");
    await controller.appContainerPath("SIMULATOR", "dev.example.app", "data");

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["uninstall", "SIMULATOR", "dev.example.app"],
      ["keychain", "SIMULATOR", "reset"],
      ["get_app_container", "SIMULATOR", "dev.example.app", "app"],
      ["get_app_container", "SIMULATOR", "dev.example.app", "data"]
    ]);
  });

  it("treats a failed container query as not-installed instead of throwing", async () => {
    class FailingRunner implements SimulatorCommandRunner {
      async run(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
        throw new SimulatorCommandError(args, "No such file or directory");
      }
    }
    const controller = new XcrunSimulatorController(new FailingRunner());

    await expect(controller.appContainerPath("SIMULATOR", "dev.example.app")).resolves.toBeUndefined();
    await expect(controller.isAppInstalled("SIMULATOR", "dev.example.app")).resolves.toBe(false);
  });

  it("reports an installed app from a non-empty container path", async () => {
    class PathRunner implements SimulatorCommandRunner {
      async run(_args: readonly string[]) {
        return { stdout: "/simulators/containers/Example.app\n", stderr: "" };
      }
    }
    const controller = new XcrunSimulatorController(new PathRunner());

    await expect(controller.appContainerPath("SIMULATOR", "dev.example.app")).resolves.toBe(
      "/simulators/containers/Example.app"
    );
    await expect(controller.isAppInstalled("SIMULATOR", "dev.example.app")).resolves.toBe(true);
  });
});

describe("NotifyutilBiometricController", () => {
  it("drives BiometricKit over the simulator's Darwin notification bridge", async () => {
    const runner = new RecordingRunner();
    const controller = new NotifyutilBiometricController(runner);

    await controller.enroll("SIMULATOR");
    await controller.unenroll("SIMULATOR");
    await controller.match("SIMULATOR");
    await controller.nonMatch("SIMULATOR");

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["spawn", "SIMULATOR", "notifyutil", "-s", "com.apple.BiometricKit.enrollmentChanged", "1"],
      ["spawn", "SIMULATOR", "notifyutil", "-p", "com.apple.BiometricKit.enrollmentChanged"],
      ["spawn", "SIMULATOR", "notifyutil", "-s", "com.apple.BiometricKit.enrollmentChanged", "0"],
      ["spawn", "SIMULATOR", "notifyutil", "-p", "com.apple.BiometricKit.enrollmentChanged"],
      ["spawn", "SIMULATOR", "notifyutil", "-p", "com.apple.BiometricKit_Sim.pearl.match"],
      ["spawn", "SIMULATOR", "notifyutil", "-p", "com.apple.BiometricKit_Sim.pearl.nomatch"]
    ]);
  });
});
