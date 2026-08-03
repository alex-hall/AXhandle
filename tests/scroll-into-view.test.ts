import { describe, expect, it } from "vitest";
import { Device, LocatorTimeoutError } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";
import type { AxeDriver, AxeSwipeGesture, AxeTapTarget } from "../src/types.js";

/**
 * A scrollable screen: one target row at a logical position in a long
 * list, inside a 400x800 viewport. Swipes shift the scroll offset by the
 * gesture's vertical delta (drag up = content moves up = offset grows),
 * exactly as a real list would.
 */
class ScrollingDriver implements AxeDriver {
  offset = 0;
  readonly swipes: AxeSwipeGesture[] = [];
  /** Set false to model a list that ignores swipes (frozen screen). */
  scrolls = true;

  constructor(private readonly targetY: number) {}

  async describeUi(): Promise<unknown> {
    return {
      role_description: "application",
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        {
          role_description: "button",
          AXLabel: "Target Row",
          AXEnabled: true,
          frame: {
            x: 20,
            y: this.targetY - this.offset,
            width: 360,
            height: 40,
          },
          children: [],
        },
      ],
    };
  }

  async swipe(gesture: AxeSwipeGesture): Promise<void> {
    this.swipes.push(gesture);
    if (this.scrolls) this.offset += gesture.startY - gesture.endY;
  }

  async tap(_target: AxeTapTarget): Promise<void> {}
  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
}

const deviceFor = (driver: AxeDriver) => new Device("primary", driver);

/** A fixture screen that accepts (and ignores) swipes. */
const swipeableFixture = (ui: unknown): AxeDriver =>
  Object.assign(new FixtureAxeDriver(ui), {
    swipe: async (_gesture: AxeSwipeGesture) => {},
  });

describe("scrollIntoView", () => {
  it("does nothing when the element is already fully in view", async () => {
    const driver = new ScrollingDriver(300);
    await deviceFor(driver)
      .findByLabel("Target Row")
      .scrollIntoView({ settleMs: 0 });

    expect(driver.swipes).toHaveLength(0);
  });

  it("swipes up until an element below the fold is fully inside", async () => {
    const driver = new ScrollingDriver(1500);
    await deviceFor(driver)
      .findByLabel("Target Row")
      .scrollIntoView({ settleMs: 0 });

    const finalY = 1500 - driver.offset;
    expect(finalY).toBeGreaterThanOrEqual(0);
    expect(finalY + 40).toBeLessThanOrEqual(800);
    // Drag direction: up (finger travels toward the top of the screen).
    expect(driver.swipes[0]!.startY).toBeGreaterThan(driver.swipes[0]!.endY);
    // In the element's own column.
    expect(driver.swipes[0]!.startX).toBe(200);
  });

  it("swipes down for an element scrolled off the top", async () => {
    const driver = new ScrollingDriver(300);
    driver.offset = 500; // the row sits at y=-200
    await deviceFor(driver)
      .findByLabel("Target Row")
      .scrollIntoView({ settleMs: 0 });

    expect(driver.swipes[0]!.endY).toBeGreaterThan(driver.swipes[0]!.startY);
    const finalY = 300 - driver.offset;
    expect(finalY).toBeGreaterThanOrEqual(0);
    expect(finalY + 40).toBeLessThanOrEqual(800);
  });

  it("treats a row behind a pinned footer as not yet in view", async () => {
    // Fully on the 800pt screen (y=740..780), but the bottom 100pt strip
    // belongs to a pinned footer — a plain on-screen check would pass and
    // every tap would press the footer.
    const driver = new ScrollingDriver(740);
    await deviceFor(driver)
      .findByLabel("Target Row")
      .scrollIntoView({ settleMs: 0, bottomInset: 100 });

    expect(driver.swipes.length).toBeGreaterThan(0);
    const finalY = 740 - driver.offset;
    expect(finalY + 40).toBeLessThanOrEqual(700);
  });

  it("fails loudly, naming the device, when the list never moves", async () => {
    const driver = new ScrollingDriver(1500);
    driver.scrolls = false;

    await expect(
      deviceFor(driver)
        .findByLabel("Target Row")
        .scrollIntoView({ settleMs: 0, maxSwipes: 2 }),
    ).rejects.toThrow(LocatorTimeoutError);
    await expect(
      deviceFor(driver)
        .findByLabel("Target Row")
        .scrollIntoView({ settleMs: 0, maxSwipes: 2 }),
    ).rejects.toThrow("after 2 swipes");
    await expect(
      deviceFor(driver)
        .findByLabel("Target Row")
        .scrollIntoView({ settleMs: 0, maxSwipes: 2 }),
    ).rejects.toThrow("[primary]");
  });

  it("is strict about the target and frames like every interaction", async () => {
    const frameless = swipeableFixture({
      role_description: "application",
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        { role_description: "statictext", AXLabel: "Ghost", children: [] },
      ],
    });
    await expect(
      deviceFor(frameless).findByLabel("Ghost").scrollIntoView({ settleMs: 0 }),
    ).rejects.toThrow("no frame to scroll to");

    const duplicated = swipeableFixture({
      role_description: "application",
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        {
          role_description: "button",
          AXLabel: "Row",
          frame: { x: 0, y: 900, width: 400, height: 40 },
          children: [],
        },
        {
          role_description: "button",
          AXLabel: "Row",
          frame: { x: 0, y: 950, width: 400, height: 40 },
          children: [],
        },
      ],
    });
    await expect(
      deviceFor(duplicated).findByLabel("Row").scrollIntoView({ settleMs: 0 }),
    ).rejects.toThrow("[primary]");
  });

  it("requires a viewport: root frame or an explicit height", async () => {
    const noRootFrame = () =>
      swipeableFixture({
        role_description: "application",
        children: [
          {
            role_description: "button",
            AXLabel: "Row",
            frame: { x: 0, y: 900, width: 400, height: 40 },
            children: [],
          },
        ],
      });

    await expect(
      deviceFor(noRootFrame())
        .findByLabel("Row")
        .scrollIntoView({ settleMs: 0 }),
    ).rejects.toThrow("root reports no frame");

    // The escape hatch: an explicit height, with swipes still attempted.
    await expect(
      deviceFor(noRootFrame())
        .findByLabel("Row")
        .scrollIntoView({ settleMs: 0, viewportHeight: 800, maxSwipes: 1 }),
    ).rejects.toThrow(LocatorTimeoutError);
  });

  it("fails explicitly when the driver lacks swipes", async () => {
    const device = deviceFor(new FixtureAxeDriver({ children: [] }));
    await expect(
      device.findByLabel("Row").scrollIntoView({ settleMs: 0 }),
    ).rejects.toThrow("does not support swipes");
  });
});
