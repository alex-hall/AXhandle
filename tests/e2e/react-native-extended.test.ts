import { describe, expect } from "vitest";
import { AxeCliDriver, Device } from "../../src/index.js";
import { axeMatchers, createAxeTest } from "../../src/vitest.js";

expect.extend(axeMatchers);

const udid = process.env.AXE_E2E_UDID;
const hasPairConfiguration =
  process.env.AXE_E2E_ALICE_UDID !== undefined ||
  process.env.AXE_E2E_BOB_UDID !== undefined;
const enabled =
  process.env.AXE_E2E === "1" && udid !== undefined && !hasPairConfiguration;

/**
 * React Native parity for the extended-surface areas that behave differently
 * on the RN accessibility bridge: native Alert buttons via label taps, and
 * swiping a ScrollView to reach off-screen rows.
 */
describe.skipIf(!enabled)("React Native AXe e2e — extended surface", () => {
  const test = createAxeTest({
    createDevices: () => ({
      primary: new Device("rn-sample", new AxeCliDriver({ udid: udid! })),
    }),
  });

  test("drives the exercises screen: alert label taps and list swipes", async ({
    devices,
  }) => {
    const device = devices.primary;

    await device.findByTestId("exercises-link").tap({
      until: device.findByTestId("exercises-screen"),
      settleTimeout: 5_000,
    });

    // Native Alert buttons via the label-tap escape hatch.
    await device.findByTestId("rn-show-alert").tap();
    expect(await device.tapLabel("Confirm", { waitTimeout: 5_000 })).toBe(true);
    await expect(device.findByLabel("Alert choice: confirmed")).toBeVisible({
      timeout: 5_000,
    });

    // Swipe the list until a deep row surfaces.
    const deepRow = device.findByTestId("rn-row-25");
    const list = await device.inspect(device.findByTestId("rn-exercise-list"));
    if (!list.frame)
      throw new Error("rn-exercise-list resolved without a frame");
    const centerX = list.frame.x + list.frame.width / 2;
    for (
      let attempt = 0;
      attempt < 12 && !(await deepRow.isPresent());
      attempt++
    ) {
      await device.swipe({
        startX: centerX,
        startY: list.frame.y + list.frame.height * 0.8,
        endX: centerX,
        endY: list.frame.y + list.frame.height * 0.2,
        durationMs: 250,
      });
    }
    await deepRow.waitForVisible({ timeout: 5_000 });

    // Return to the root so the original single-device spec stays isolated.
    await device.findByTestId("exercises-back").tap({
      until: device.findByTestId("sample-root"),
      settleTimeout: 5_000,
    });
  }, 120_000);
});
