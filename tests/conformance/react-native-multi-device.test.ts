import { afterAll, beforeAll, describe, expect } from "vitest";
import { AxeCliDriver, Device } from "../../src/index.js";
import { axeMatchers, createAxeTest } from "../../src/vitest.js";
import { startLocalRelay } from "../support/local-relay.js";
import type { LocalRelay } from "../support/local-relay.js";

expect.extend(axeMatchers);

const aliceUdid = process.env.AXE_CONFORMANCE_ALICE_UDID;
const bobUdid = process.env.AXE_CONFORMANCE_BOB_UDID;
const enabled =
  process.env.AXE_CONFORMANCE === "1" && aliceUdid !== undefined && bobUdid !== undefined;

describe.skipIf(!enabled)("React Native multi-device AXe conformance", () => {
  let relay: LocalRelay;
  beforeAll(async () => {
    relay = await startLocalRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  const test = createAxeTest({
    deviceProvider: {
      allocate: () => ({
        alice: new Device("alice", new AxeCliDriver({ udid: aliceUdid! })),
        bob: new Device("bob", new AxeCliDriver({ udid: bobUdid! }))
      })
    },
    beforeTest: async () => {
      await relay.reset();
    }
  });

  test("delivers Alice's message to Bob on a separate simulator", async ({ devices }) => {
    const aliceInput = devices.alice.findByRole("text field", { name: "Message" });
    const aliceSend = devices.alice.findByRole("button", { name: "Send" });

    await Promise.all([
      expect(aliceSend).toBeVisible({ timeout: 10_000 }),
      expect(devices.bob.findByRole("button", { name: "Send" })).toBeVisible({ timeout: 10_000 })
    ]);

    await Promise.all([
      devices.alice.findByRole("button", { name: "Use Alice" }).click(),
      devices.bob.findByRole("button", { name: "Use Bob" }).click()
    ]);
    await Promise.all([
      expect(devices.alice.findByLabel("Identity: Alice")).toBeVisible(),
      expect(devices.bob.findByLabel("Identity: Bob")).toBeVisible()
    ]);

    await aliceInput.fill("Hello Bob", { timeout: 10_000 });
    await expect(aliceSend).toBeEnabled();
    await aliceSend.click();
    await expect(devices.alice.findByLabel("Delivery status: Delivered")).toBeVisible();

    await expect(
      devices.bob.findByLabel("Incoming message from Alice: Hello Bob")
    ).toBeVisible({ timeout: 15_000 });
  }, 45_000);
});
