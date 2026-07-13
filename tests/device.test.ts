import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Device, LocatorResolutionError } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";
import { axeMatchers } from "../src/vitest.js";

expect.extend(axeMatchers);

const fixturePath = fileURLToPath(new URL("./fixtures/message-screen.json", import.meta.url));
const messageScreen = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;

describe("Device locators", () => {
  it("scopes findBy queries to an accessibility fragment", async () => {
    const device = new Device("primary", new FixtureAxeDriver(messageScreen));
    const aliceThread = device.findByTestId("thread-a");

    await expect(aliceThread.findByText("Hello")).toBeVisible();
    await expect(aliceThread.findByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("requires an explicit positional choice for duplicate matches", async () => {
    const device = new Device("primary", new FixtureAxeDriver(messageScreen));

    await expect(device.findByText("Hello").resolve()).rejects.toBeInstanceOf(
      LocatorResolutionError
    );
    await expect(device.findByText("Hello").second().resolve()).resolves.toMatchObject({
      label: "Hello"
    });
  });

  it("uses a unique id when tapping a scoped locator", async () => {
    const driver = new FixtureAxeDriver(messageScreen);
    const device = new Device("primary", driver);

    await device
      .findByTestId("thread-a")
      .findByRole("button", { name: "Send" })
      .click();

    expect(driver.calls).toContainEqual({
      kind: "tap",
      target: { kind: "id", id: "send-a" }
    });
  });

  it("drives a fixture transition through the real public API", async () => {
    const deliveredScreen = structuredClone(messageScreen) as {
      AXChildren: Array<{ AXUniqueId?: string; AXChildren?: unknown[] }>;
    };
    const alice = deliveredScreen.AXChildren[0];
    if (!alice?.AXChildren) throw new Error("Fixture shape changed unexpectedly.");
    alice.AXChildren.push({
      AXRole: "StaticText",
      AXLabel: "Delivered",
      frame: { x: 16, y: 64, width: 100, height: 30 }
    });

    const device = new Device(
      "primary",
      new FixtureAxeDriver(messageScreen, [
        {
          when: (call) =>
            call.kind === "tap" &&
            call.target.kind === "id" &&
            call.target.id === "send-a",
          nextUi: deliveredScreen
        }
      ])
    );

    const thread = device.findByTestId("thread-a");
    await thread.findByTestId("send-a").click();
    await expect(thread.findByText("Delivered")).toBeVisible();
  });

  it("fills a field with select-all, type, and AXValue verification", async () => {
    const filledScreen = structuredClone(messageScreen) as {
      AXChildren: Array<{ AXUniqueId?: string; AXChildren?: Array<Record<string, unknown>> }>;
    };
    const alice = filledScreen.AXChildren[0];
    if (!alice?.AXChildren) throw new Error("Fixture shape changed unexpectedly.");
    alice.AXChildren.push({
      AXRole: "TextField",
      AXUniqueId: "message-input",
      AXLabel: "Message",
      AXValue: "Hello",
      AXEnabled: true,
      frame: { x: 16, y: 96, width: 300, height: 44 }
    });

    const initialScreen = structuredClone(filledScreen) as typeof filledScreen;
    const initialAlice = initialScreen.AXChildren[0];
    const input = initialAlice?.AXChildren?.find(
      (node) => node.AXUniqueId === "message-input"
    );
    if (!input) throw new Error("Fixture shape changed unexpectedly.");
    input.AXValue = "Existing value";

    const driver = new FixtureAxeDriver(initialScreen, [
      { when: (call) => call.kind === "type" && call.text === "Hello", nextUi: filledScreen }
    ]);
    const device = new Device("primary", driver);

    await device.findByTestId("message-input").fill("Hello");

    expect(driver.calls).toContainEqual({ kind: "keyCombo", modifiers: [227], key: 4 });
    await expect(device.findByTestId("message-input")).toHaveValue("Hello");
    await expect(device.findByTestId("message-input")).toHaveText("Message");
  });
});
