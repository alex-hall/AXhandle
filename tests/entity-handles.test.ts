import { describe, expect, it } from "vitest";
import { Device, LocatorTimeoutError } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";
import type { AxeDriver, AxeTapTarget, Clock } from "../src/types.js";

const fakeClock = (): Clock => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
  };
};

const hud = (id: string, y: number) => ({
  role_description: "button",
  AXUniqueId: id,
  AXLabel: `Proposal ${id}`,
  AXEnabled: true,
  frame: { x: 20, y, width: 360, height: 60 },
  children: [],
});

describe("findByTestId with startsWith", () => {
  const screen = {
    role_description: "application",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      hud("approval-hud-b31", 300),
      hud("approval-hud-a07", 100),
      { role_description: "button", AXUniqueId: "send", children: [] },
    ],
  };

  it("matches ids by prefix while the default stays exact", async () => {
    const device = new Device("primary", new FixtureAxeDriver(screen));

    await expect(
      device.findByTestId("approval-hud-", { startsWith: true }).count(),
    ).resolves.toBe(2);
    await expect(
      device.findByTestId("approval-hud-").isPresent(),
    ).resolves.toBe(false);
    await expect(device.findByTestId("send").count()).resolves.toBe(1);
  });

  it("stays strict for interactions and describes itself distinctly", async () => {
    const device = new Device("primary", new FixtureAxeDriver(screen));
    const hudLocator = device.findByTestId("approval-hud-", {
      startsWith: true,
    });

    await expect(hudLocator.resolve()).rejects.toThrow(
      'findByTestId("approval-hud-", { startsWith: true })',
    );
    await expect(hudLocator.first().resolve()).resolves.toMatchObject({
      id: "approval-hud-b31",
    });
  });

  it("lists distinct present ids in visual top-to-bottom order", async () => {
    const device = new Device("primary", new FixtureAxeDriver(screen));

    // b31 precedes a07 in the tree, but a07 renders higher on screen.
    await expect(
      device.findByTestId("approval-hud-", { startsWith: true }).presentIds(),
    ).resolves.toEqual(["approval-hud-a07", "approval-hud-b31"]);
  });

  it("collapses duplicate-node ids to one entity", async () => {
    // RNGH's createNativeWrapper mounts the same id on the handler view and
    // the button beneath — two nodes, one control.
    const doubled = {
      role_description: "application",
      children: [
        {
          role_description: "group",
          AXUniqueId: "vote-yes-p1",
          frame: { x: 0, y: 100, width: 400, height: 60 },
          children: [hud("vote-yes-p1", 100)],
        },
      ],
    };
    const device = new Device("primary", new FixtureAxeDriver(doubled));
    const votes = device.findByTestId("vote-yes-", { startsWith: true });

    await expect(votes.presentNodes()).resolves.toHaveLength(2);
    await expect(votes.presentIds()).resolves.toEqual(["vote-yes-p1"]);
  });

  it("skips id-less nodes when a non-id query feeds presentIds", async () => {
    const device = new Device(
      "primary",
      new FixtureAxeDriver({
        role_description: "application",
        children: [
          hud("approval-hud-a07", 100),
          {
            role_description: "button",
            AXLabel: "Proposal untagged",
            children: [],
          },
        ],
      }),
    );

    await expect(
      device.findByLabel("Proposal", { exact: false }).presentIds(),
    ).resolves.toEqual(["approval-hud-a07"]);
  });
});

describe("waitForForeground", () => {
  const appIconLabel = "Example App";
  const springboard = {
    role_description: "application",
    children: [
      // The home screen shows the app's ICON with the app's own label —
      // which is why the marker alone cannot prove foregroundness.
      { role_description: "icon", AXLabel: appIconLabel, children: [] },
      { role_description: "group", AXLabel: "Dock", children: [] },
    ],
  };
  const appScreen = {
    role_description: "application",
    children: [
      { role_description: "statictext", AXLabel: appIconLabel, children: [] },
    ],
  };

  class SequenceDriver implements AxeDriver {
    reads = 0;

    constructor(private readonly snapshots: readonly unknown[]) {}

    async describeUi(): Promise<unknown> {
      const index = Math.min(this.reads++, this.snapshots.length - 1);
      return this.snapshots[index];
    }

    async tap(_target: AxeTapTarget): Promise<void> {}
    async type(_text: string): Promise<void> {}
    async keyCombo(
      _modifiers: readonly number[],
      _key: number,
    ): Promise<void> {}
  }

  it("resolves once the marker is up and the springboard is gone", async () => {
    const device = new Device(
      "primary",
      new SequenceDriver([springboard, springboard, appScreen]),
      { clock: fakeClock() },
    );

    await expect(
      device.waitForForeground({ marker: device.findByLabel(appIconLabel) }),
    ).resolves.toBeUndefined();
  });

  it("is not fooled by the app icon on the home screen", async () => {
    const device = new Device("primary", new FixtureAxeDriver(springboard), {
      clock: fakeClock(),
    });

    await expect(
      device.waitForForeground({
        marker: device.findByLabel(appIconLabel),
        timeout: 3_000,
      }),
    ).rejects.toThrow(LocatorTimeoutError);
  });

  it("reports a suspected crash with the device name", async () => {
    const empty = {
      role_description: "application",
      children: [],
    };
    const device = new Device("crash-sim", new FixtureAxeDriver(empty), {
      clock: fakeClock(),
    });

    await expect(
      device.waitForForeground({
        marker: device.findByLabel(appIconLabel),
        timeout: 3_000,
      }),
    ).rejects.toThrow("did it crash? [crash-sim]");
  });
});
