import { afterAll, describe, expect } from "vitest";
import {
  AxeCliDriver,
  AxeEventCachedDriver,
  Device,
  NodeSimulatorCommandRunner,
  NotifyutilChangeSignal,
  XcrunSimulatorController,
  type Locator,
} from "../../src/index.js";
import { axeMatchers, createAxeTest } from "../../src/vitest.js";
import type { AxeDriver } from "../../src/types.js";

expect.extend(axeMatchers);

const udid = process.env.AXE_E2E_SWIFTUI_UDID;
const enabled = process.env.AXE_E2E === "1" && udid !== undefined;
const BUNDLE_ID = "dev.axhandle.integration-sample-app";

/**
 * On-device proof for the viewport/entity/signal surface: waitForForeground
 * after a real relaunch, prefix testIDs + presentIds against the List tab's
 * per-entity rows, scrollIntoView reaching a below-the-fold row, and the
 * Darwin-notification change signal wired through a real notifyutil watcher.
 */
describe.skipIf(!enabled)("SwiftUI AXe e2e — viewport and signals", () => {
  const simulator = new XcrunSimulatorController();
  const runner = new NodeSimulatorCommandRunner();

  const test = createAxeTest({
    createDevices: () => ({
      primary: new Device("swiftui-sample", new AxeCliDriver({ udid: udid! })),
    }),
  });

  // This spec drives the app deep into the List tab; the sibling specs
  // assume the freshly-launched entry state and never relaunch. Hand the
  // next file a fresh app.
  afterAll(async () => {
    await simulator.launch({
      udid: udid!,
      bundleId: BUNDLE_ID,
      terminateRunning: true,
    });
  });

  async function openTab(device: Device, label: string, marker: Locator) {
    await device
      .findByLabel(label)
      .first()
      .tap({ until: marker, settleTimeout: 5_000 });
  }

  test("waitForForeground proves the app is up after a real relaunch", async ({
    devices,
  }) => {
    const device = devices.primary;
    await simulator.launch({
      udid: udid!,
      bundleId: BUNDLE_ID,
      terminateRunning: true,
    });

    // The tab bar is the app's stable entry-screen furniture.
    await device.waitForForeground({
      marker: device.findByLabel("List").first(),
    });
  }, 60_000);

  test("prefix testIDs list the on-screen row entities top to bottom", async ({
    devices,
  }) => {
    const device = devices.primary;
    await simulator.launch({
      udid: udid!,
      bundleId: BUNDLE_ID,
      terminateRunning: true,
    });
    await openTab(device, "List", device.findByTestId("add-row"));
    await device.findByTestId("row-1").waitForVisible({ timeout: 10_000 });

    const rows = device.findByTestId("row-", { startsWith: true });
    const ids = await rows.presentIds();

    expect(ids.length).toBeGreaterThan(2);
    expect(ids[0]).toBe("row-1");
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("row-")).toBe(true);

    // The prefix locator composes with positional selection.
    await expect(rows.first().resolve()).resolves.toMatchObject({
      id: "row-1",
    });
  }, 90_000);

  test("scrollIntoView surfaces a row far below the fold", async ({
    devices,
  }) => {
    const device = devices.primary;
    await simulator.launch({
      udid: udid!,
      bundleId: BUNDLE_ID,
      terminateRunning: true,
    });
    await openTab(device, "List", device.findByTestId("add-row"));
    await device.findByTestId("row-1").waitForVisible({ timeout: 10_000 });

    const deepRow = device.findByTestId("row-40");
    expect(await deepRow.isPresent()).toBe(false);

    // SwiftUI's List virtualizes: the deep row is not in the tree at all
    // until real scrolling materializes it. scrollIntoView is strict (the
    // element must exist), so first swipe until the row is present — the
    // documented pattern for virtualized lists — typically leaving it
    // partially visible at the bottom edge.
    const list = await device.inspect(device.findByTestId("exercise-list"));
    if (!list.frame) throw new Error("exercise-list resolved without a frame");
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
        endY: list.frame.y + list.frame.height * 0.5,
        durationMs: 250,
      });
    }

    // Now the real subject: finish the job with scrollIntoView, excluding
    // the tab-bar strip so "in view" also means tappable, and verify the
    // final frame really sits inside the reduced viewport.
    await deepRow.scrollIntoView({ bottomInset: 100 });
    const frame = await deepRow.frame();
    const viewport = (await device.uiSnapshot()).tree.root.frame;
    if (!frame || !viewport) throw new Error("frames missing after scroll");
    expect(frame.y).toBeGreaterThanOrEqual(viewport.y);
    expect(frame.y + frame.height).toBeLessThanOrEqual(
      viewport.y + viewport.height - 100,
    );
    await deepRow.waitForVisible({ timeout: 5_000 });
    expect(await deepRow.count()).toBe(1);
  }, 120_000);

  test("a posted Darwin notification invalidates the event cache and wakes sleeps", async ({
    devices,
  }) => {
    const inner = new AxeCliDriver({ udid: udid! });
    let dumps = 0;
    const counting: AxeDriver = {
      describeUi: () => {
        dumps += 1;
        return inner.describeUi();
      },
      tap: (target) => inner.tap(target),
      type: (text) => inner.type(text),
      keyCombo: (modifiers, key) => inner.keyCombo(modifiers, key),
    };
    const notification = "dev.axhandle.e2e.uichange";
    const cached = new AxeEventCachedDriver(counting, {
      signal: new NotifyutilChangeSignal({ udid: udid!, notification }),
      // The sample app posts no beacon, so disable the staleness fallback:
      // only the posted notification may invalidate.
      maxStalenessMs: 60_000,
    });
    const device = new Device("event-cache", cached);

    const post = () =>
      runner.run(["spawn", udid!, "notifyutil", "-p", notification]);

    try {
      // Give devices.primary a moment of use so the fixture stays honest.
      await devices.primary.uiSnapshot();

      await device.uiSnapshot();
      await device.uiSnapshot();
      expect(dumps).toBe(1);

      // The watcher registers asynchronously after the first read spawned
      // it; post until the fire lands rather than guessing the latency.
      let woke = false;
      const sleep = cached.sleepUntilChange(20_000).then(() => {
        woke = true;
      });
      const deadline = Date.now() + 10_000;
      while (!woke && Date.now() < deadline) {
        await post();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await sleep;
      expect(woke).toBe(true);

      // The same fire marked the cache dirty: the next read re-dumps.
      await device.uiSnapshot();
      expect(dumps).toBe(2);
    } finally {
      device.dispose();
    }
  }, 60_000);
});
