import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { AxeCliDriver, Device, type Locator } from "../../src/index.js";
import { axeMatchers, createAxeTest } from "../../src/vitest.js";

expect.extend(axeMatchers);

const udid = process.env.AXE_E2E_SWIFTUI_UDID;
const enabled = process.env.AXE_E2E === "1" && udid !== undefined;

/**
 * Exercises the API areas the original compose-form spec cannot reach:
 * swipe, dynamic list counts, native alert label taps, raw coordinate taps,
 * screenshots, and command-log windowing — against the sample app's List,
 * Alerts, and Canvas tabs.
 */
describe.skipIf(!enabled)("SwiftUI AXe e2e — extended surface", () => {
  const test = createAxeTest({
    createDevices: () => ({
      primary: new Device("swiftui-sample", new AxeCliDriver({ udid: udid! })),
    }),
  });

  async function openTab(device: Device, label: string, marker: Locator) {
    // A tab bar item and its symbol image share the label — take the tab.
    await device
      .findByLabel(label)
      .first()
      .tap({ until: marker, settleTimeout: 5_000 });
  }

  test("swipes to deep list rows and observes dynamic row counts", async ({
    devices,
  }) => {
    const device = devices.primary;
    await openTab(device, "List", device.findByTestId("add-row"));

    const firstRow = device.findByTestId("row-1");
    const deepRow = device.findByTestId("row-40");
    await firstRow.waitForVisible({ timeout: 10_000 });

    // One snapshot, many candidates: the top of the list is present, the
    // bottom is not.
    expect(await device.firstPresent(deepRow, firstRow)).toBe(firstRow);

    // Swipe up inside the list frame until the deep row surfaces.
    const list = await device.inspect(device.findByTestId("exercise-list"));
    const frame = list.frame;
    if (!frame) throw new Error("exercise-list resolved without a frame");
    const centerX = frame.x + frame.width / 2;
    for (
      let attempt = 0;
      attempt < 12 && !(await deepRow.isPresent());
      attempt++
    ) {
      await device.swipe({
        startX: centerX,
        startY: frame.y + frame.height * 0.8,
        endX: centerX,
        endY: frame.y + frame.height * 0.2,
        durationMs: 250,
      });
    }
    await deepRow.waitForVisible({ timeout: 5_000 });
    expect(await deepRow.count()).toBe(1);

    // Shrinking the list removes the deep row; growing it brings it back.
    await device.findByTestId("remove-row").tap();
    await deepRow.waitForGone({ timeout: 5_000 });
    await device.findByTestId("add-row").tap();
    await deepRow.waitForVisible({ timeout: 5_000 });
  }, 90_000);

  test("presses native alert buttons through label taps", async ({
    devices,
  }) => {
    const device = devices.primary;
    await openTab(device, "Alerts", device.findByTestId("show-alert"));

    await device.findByTestId("show-alert").tap();
    expect(await device.tapLabel("Confirm", { waitTimeout: 5_000 })).toBe(true);
    await expect(device.findByLabel("Alert choice: confirmed")).toBeVisible({
      timeout: 5_000,
    });

    await device.findByTestId("show-alert").tap();
    expect(await device.tapLabel("Cancel", { waitTimeout: 5_000 })).toBe(true);
    await expect(device.findByLabel("Alert choice: cancelled")).toBeVisible({
      timeout: 5_000,
    });

    // The optional form reports a miss instead of throwing.
    expect(
      await device.tapLabel("No Such Button", {
        optional: true,
        waitTimeout: 500,
      }),
    ).toBe(false);
  }, 60_000);

  test("raw coordinate taps land and are attributed in the command log", async ({
    devices,
  }) => {
    const device = devices.primary;
    await openTab(device, "Canvas", device.findByTestId("canvas-target"));

    const target = await device.inspect(device.findByTestId("canvas-target"));
    if (!target.frame)
      throw new Error("canvas-target resolved without a frame");

    const mark = device.commandMark();
    await device.tapPoint(
      target.frame.x + target.frame.width / 2,
      target.frame.y + target.frame.height / 2,
    );
    await expect(device.findByLabel("Tap status: recorded")).toBeVisible({
      timeout: 5_000,
    });

    // commandLog({ after }) windows to just the commands since the mark.
    const windowed = device.commandLog({ after: mark });
    expect(windowed.some((entry) => entry.command === "tap-point")).toBe(true);
    expect(windowed.some((entry) => entry.command === "inspect")).toBe(true);
  }, 60_000);

  test("captures a screenshot artifact", async ({ devices }) => {
    const device = devices.primary;
    const output = join(tmpdir(), `axhandle-e2e-${Date.now()}.png`);

    await device.screenshot(output);

    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(0);
  }, 30_000);

  test("fill replaces field contents where type appends", async ({
    devices,
  }) => {
    const device = devices.primary;
    await openTab(device, "Compose", device.findByTestId("message-input"));

    const message = device.findByTestId("message-input");
    await message.fill("Hello", { timeout: 10_000 });
    await expect(message).toHaveValue("Hello");

    await message.type(" again");
    await expect(message).toHaveValue("Hello again");

    await message.fill("replaced", { timeout: 10_000 });
    await expect(message).toHaveValue("replaced");
  }, 60_000);
});
