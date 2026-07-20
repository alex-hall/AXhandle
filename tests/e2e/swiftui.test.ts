import { describe, expect } from "vitest";
import { AxeCliDriver, Device } from "../../src/index.js";
import { axeMatchers, createAxeTest } from "../../src/vitest.js";

expect.extend(axeMatchers);

const udid = process.env.AXE_E2E_SWIFTUI_UDID;
const enabled = process.env.AXE_E2E === "1" && udid !== undefined;

describe.skipIf(!enabled)("SwiftUI AXe e2e", () => {
  const test = createAxeTest({
    createDevices: () => ({
      primary: new Device("swiftui-sample", new AxeCliDriver({ udid: udid! }))
    })
  });

  test("drives native SwiftUI controls through accessibility semantics", async ({ devices }) => {
    const device = devices.primary;
    const message = device.findByRole("text field", { name: "Message" });
    const send = device.findByRole("button", { name: "Send" });
    const notifications = device.findByRole("switch", { name: "Notifications" });

    await expect(send).toBeVisible({ timeout: 10_000 });

    // Reset the public sample's form state without assuming a fresh simulator.
    await message.fill(" ", { timeout: 10_000 });
    await expect(send).toBeDisabled();

    await notifications.check();
    await expect(notifications).toBeChecked();
    await notifications.uncheck();
    await expect(notifications).toBeUnchecked();

    await message.fill("Hello from SwiftUI", { timeout: 10_000 });
    await expect(message).toHaveValue("Hello from SwiftUI");
    await expect(send).toBeEnabled();
    await send.tap();
    await expect(device.findByLabel("Delivery status: Delivered")).toBeVisible();
  }, 45_000);
});
