import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SimulatorVideoRecorder,
  XcrunSimulatorController,
} from "../../src/index.js";

const udid = process.env.AXE_E2E_SWIFTUI_UDID;
const enabled = process.env.AXE_E2E === "1" && udid !== undefined;

const BUNDLE_ID = "dev.axhandle.integration-sample-app";

/**
 * Exercises the simulator-control surface against a real booted simulator
 * with the integration sample installed. No UI driving here — this is the
 * app-lifecycle / privacy / recording half of the API.
 */
describe.skipIf(!enabled)("XcrunSimulatorController e2e", () => {
  const controller = new XcrunSimulatorController();

  it("sees the installed sample app and resolves its containers", async () => {
    expect(await controller.isAppInstalled(udid!, BUNDLE_ID)).toBe(true);
    expect(await controller.isAppInstalled(udid!, "dev.axhandle.absent")).toBe(
      false,
    );

    const appContainer = await controller.appContainerPath(udid!, BUNDLE_ID);
    expect(appContainer).toMatch(/\.app$/);
    const dataContainer = await controller.appContainerPath(
      udid!,
      BUNDLE_ID,
      "data",
    );
    expect(dataContainer).toBeTruthy();
    expect(dataContainer).not.toBe(appContainer);
  }, 30_000);

  it("grants, revokes, and resets privacy permissions", async () => {
    // simctl gives no read API for privacy state; the contract under test is
    // that each transition is accepted (a bad service or bundle id errors).
    // "contacts" is used because some services (notifications among them)
    // reject grant on recent runtimes with "Operation not permitted".
    await controller.grantPermission(udid!, "contacts", BUNDLE_ID);
    await controller.revokePermission(udid!, "contacts", BUNDLE_ID);
    await controller.resetPermissions(udid!, "contacts", BUNDLE_ID);
    await controller.resetPermissions(udid!, "all", BUNDLE_ID);
  }, 30_000);

  it("terminates and relaunches the sample app with a fresh pid", async () => {
    const first = await controller.launch({
      udid: udid!,
      bundleId: BUNDLE_ID,
      terminateRunning: true,
    });
    expect(first.pid).toBeGreaterThan(0);

    await controller.terminate(udid!, BUNDLE_ID);
    const second = await controller.launch({
      udid: udid!,
      bundleId: BUNDLE_ID,
    });
    expect(second.pid).toBeGreaterThan(0);
    expect(second.pid).not.toBe(first.pid);
  }, 60_000);

  it("records a playable screen video via SIGINT finalization", async () => {
    const output = join(tmpdir(), `axhandle-e2e-video-${Date.now()}.mp4`);
    const recorder = new SimulatorVideoRecorder(udid!, output);

    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await recorder.stop();

    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(0);
    rmSync(output, { force: true });
  }, 45_000);
});
