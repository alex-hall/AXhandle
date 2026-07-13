import { afterAll, beforeAll, describe, expect } from "vitest";
import { AxeCliDriver, Device } from "../../src/index.js";
import { axeMatchers, createAxeTest } from "../../src/vitest.js";
import { startLocalRelay } from "../support/local-relay.js";
import type { LocalRelay } from "../support/local-relay.js";

expect.extend(axeMatchers);

const udid = process.env.AXE_CONFORMANCE_UDID;
const hasPairConfiguration =
  process.env.AXE_CONFORMANCE_ALICE_UDID !== undefined ||
  process.env.AXE_CONFORMANCE_BOB_UDID !== undefined;
const enabled =
  process.env.AXE_CONFORMANCE === "1" && udid !== undefined && !hasPairConfiguration;
const returnToMainScreen = async (device: Device): Promise<void> => {
  const back = device.findByRole("button", { name: "Back" });
  if (await back.count() > 0) await back.click();
};

describe.skipIf(!enabled)("React Native AXe conformance", () => {
  let relay: LocalRelay;
  beforeAll(async () => {
    relay = await startLocalRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  const test = createAxeTest({
    createDevices: () => ({
      primary: new Device("react-native-sample", new AxeCliDriver({ udid: udid! }))
    }),
    beforeTest: async ({ devices }) => {
      await relay.reset();
      await returnToMainScreen(devices.primary);
    },
    reset: async ({ devices }) => returnToMainScreen(devices.primary)
  });

  test("drives the sample through human-facing accessibility semantics", async ({ devices }) => {
    const device = devices.primary;
    const input = device.findByRole("text field", { name: "Message" });
    const send = device.findByRole("button", { name: "Send" });

    // Readiness is expressed as a retried accessibility assertion, never a sleep.
    await expect(send).toBeVisible({ timeout: 10_000 });

    await device.findByRole("button", { name: "Use Alice" }).click();
    await expect(device.findByLabel("Identity: Alice")).toBeVisible();

    // A whitespace-only value is a portable way to return this public sample to
    // its disabled state on every run, including a rerun after a prior failure.
    await input.fill(" ", { timeout: 10_000 });
    await expect(send).toBeDisabled();

    await input.fill("Hello from AXe", { timeout: 10_000 });
    await expect(input).toHaveValue("Hello from AXe");
    await expect(send).toBeEnabled();

    await send.click();
    await expect(device.findByLabel("Delivery status: Delivered")).toBeVisible();

    await device.findByRole("link", { name: "Details" }).click();
    await expect(device.findByRole("button", { name: "Back" })).toBeVisible();
  }, 45_000);
});
