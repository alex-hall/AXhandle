import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Device, LocatorResolutionError } from "../src/index.js";
import { FixtureAxeDriver, fixtureTree } from "../src/testing.js";
import { axeMatchers } from "../src/vitest.js";
import type { AxeDriver, AxeTapTarget, Clock } from "../src/types.js";

expect.extend(axeMatchers);

const fixturePath = fileURLToPath(new URL("./fixtures/message-screen.json", import.meta.url));
const messageFixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  formatVersion: 1;
  metadata: { source: "synthetic" };
  tree: unknown;
};
const messageScreen = fixtureTree(messageFixture);

class SequenceDriver implements AxeDriver {
  private reads = 0;

  constructor(private readonly snapshots: readonly unknown[]) {}

  async describeUi(): Promise<unknown> {
    const index = Math.min(this.reads++, this.snapshots.length - 1);
    return this.snapshots[index];
  }

  async tap(_target: AxeTapTarget): Promise<void> {}
  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
}

const fakeClock = (): Clock & { elapsed(): number } => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
    elapsed: () => time
  };
};

describe("Device locators", () => {
  it("prefers AXe's semantic role description over its low-level AX role", async () => {
    const device = new Device("primary", new FixtureAxeDriver({
      role_description: "button",
      role: "AXButton",
      AXUniqueId: "send",
      AXLabel: "Send",
      enabled: true,
      children: []
    }));

    await expect(device.findByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("scopes findBy queries to an accessibility fragment", async () => {
    const device = new Device("primary", new FixtureAxeDriver(messageScreen));
    const aliceThread = device.findByTestId("thread-a");

    await expect(aliceThread.findByText("Hello")).toBeVisible();
    await expect(aliceThread.findByRole("button", { name: "Send" })).toBeEnabled();
    await expect(device.findByTestId("thread-b").findByRole("button", { name: "Send" })).toBeDisabled();
    await expect(aliceThread.findByRole("button", { name: "Send" })).not.toBeDisabled();
  });

  it("requires an explicit positional choice for duplicate matches", async () => {
    const device = new Device("primary", new FixtureAxeDriver(messageScreen));

    await expect(device.findByText("Hello").resolve()).rejects.toThrow(
      'application > group#thread-a > statictext["Hello"]'
    );
    await expect(device.findByText("Hello").second().resolve()).resolves.toMatchObject({
      label: "Hello"
    });
    await expect(device.findByText("Hello")).toHaveCount(2);

    expect(device.commandLog()).toContainEqual(
      expect.objectContaining({ command: "inspect", status: "failed" })
    );
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

  it("checks and unchecks AXe switch values without redundant taps", async () => {
    const unchecked = {
      AXRole: "Application",
      AXChildren: [{
        AXRole: "CheckBox",
        AXUniqueId: "notifications",
        AXLabel: "Notifications",
        AXValue: "0",
        AXEnabled: true,
        frame: { x: 300, y: 16, width: 60, height: 28 }
      }]
    };
    const checked = structuredClone(unchecked) as typeof unchecked;
    checked.AXChildren[0]!.AXValue = "1";

    const driver = new FixtureAxeDriver(unchecked, [{
      when: (call) => call.kind === "tap",
      nextUi: checked
    }]);
    const device = new Device("primary", driver);
    const notifications = device.findByTestId("notifications");

    await expect(notifications).toBeUnchecked();
    await notifications.check();
    await expect(notifications).toBeChecked();
    await notifications.check();

    expect(driver.calls.filter((call) => call.kind === "tap")).toHaveLength(1);
    expect(device.commandLog()).toContainEqual(expect.objectContaining({ command: "check" }));
  });

  it("unchecks an already checked control", async () => {
    const checked = {
      AXRole: "Application",
      AXChildren: [{
        AXRole: "CheckBox",
        AXUniqueId: "notifications",
        AXLabel: "Notifications",
        AXValue: true,
        AXEnabled: true,
        frame: { x: 300, y: 16, width: 60, height: 28 }
      }]
    };
    const unchecked = structuredClone(checked) as typeof checked;
    unchecked.AXChildren[0]!.AXValue = false;
    const driver = new FixtureAxeDriver(checked, [{
      when: (call) => call.kind === "tap",
      nextUi: unchecked
    }]);
    const device = new Device("primary", driver);

    await device.findByTestId("notifications").uncheck();
    await expect(device.findByTestId("notifications")).toBeUnchecked();
  });

  it("retries asynchronous assertions against sequenced fixture trees", async () => {
    const hidden = {
      AXRole: "Application",
      AXChildren: [
        { AXRole: "StaticText", AXUniqueId: "status", AXLabel: "Connecting", AXVisible: false }
      ]
    };
    const ready = {
      AXRole: "Application",
      AXChildren: [
        { AXRole: "StaticText", AXUniqueId: "status", AXLabel: "Ready", AXVisible: true }
      ]
    };
    const clock = fakeClock();
    const device = new Device("primary", new SequenceDriver([hidden, ready]), { clock });
    const status = device.findByTestId("status");

    await expect(status).toBeVisible({ timeout: 100, interval: 25 });
    await expect(status).toHaveText("Ready");

    expect(clock.elapsed()).toBe(25);
  });

  it("asserts hidden accessibility state", async () => {
    const device = new Device("primary", new SequenceDriver([{
      AXRole: "Application",
      AXChildren: [
        { AXRole: "StaticText", AXUniqueId: "status", AXLabel: "Connecting", AXVisible: false }
      ]
    }]));

    await expect(device.findByTestId("status")).toBeHidden();
  });

  it("waits for an action target before dispatching input", async () => {
    const missing = { AXRole: "Application", AXChildren: [] };
    const driver = new SequenceDriver([missing, messageScreen]);
    const clock = fakeClock();
    const device = new Device("primary", driver, { clock });

    await device.findByTestId("send-a").click({ timeout: 100, interval: 25 });

    expect(clock.elapsed()).toBe(25);
  });

  it("records an unsupported screenshot attempt as a failed command", async () => {
    const device = new Device("primary", new FixtureAxeDriver(messageScreen));

    await expect(device.screenshot("artifacts/primary.png")).rejects.toThrow(
      "does not support screenshots"
    );
    expect(device.commandLog()).toContainEqual(
      expect.objectContaining({ command: "screenshot", status: "failed" })
    );
  });
});
