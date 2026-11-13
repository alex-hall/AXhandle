import { describe, expect, it } from "vitest";
import { AxeEventCachedDriver, Device, framesAgree } from "../src/index.js";
import type { UiChangeSignal } from "../src/index.js";
import type {
  AxeDriver,
  AxeSwipeGesture,
  AxeTapTarget,
  Clock,
  DescribeUiOptions,
} from "../src/types.js";

const DUMP_MS = 60;

const fakeClock = (): Clock & { advance(milliseconds: number): void } => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
    advance: (milliseconds) => {
      time += milliseconds;
    },
  };
};

/**
 * One row with no accessibility id (so taps land on its frame's center, and
 * the test can see exactly where) inside a 400x800 viewport. Each dump
 * reads the next y from `ys` and holds the last one; each dump costs
 * DUMP_MS on the fake clock, as a real serve read costs ~60ms.
 */
class MovingRowDriver implements AxeDriver {
  dumps = 0;
  freshDumps = 0;
  readonly taps: AxeTapTarget[] = [];
  readonly swipes: AxeSwipeGesture[] = [];
  private next = 0;

  constructor(
    private ys: readonly number[],
    private readonly clock?: { advance(milliseconds: number): void },
  ) {}

  /** Replace the motion still to come (the next dumps read these). */
  moveThrough(ys: readonly number[]): void {
    this.ys = ys;
    this.next = 0;
  }

  async describeUi(options?: DescribeUiOptions): Promise<unknown> {
    this.dumps += 1;
    if (options?.fresh) this.freshDumps += 1;
    this.clock?.advance(DUMP_MS);
    const y = this.ys[Math.min(this.next++, this.ys.length - 1)];
    return {
      role_description: "application",
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        {
          role_description: "button",
          AXLabel: "Delete Account",
          AXEnabled: true,
          frame: { x: 0, y, width: 400, height: 40 },
          children: [],
        },
      ],
    };
  }

  async tap(target: AxeTapTarget): Promise<void> {
    this.taps.push(target);
  }

  async swipe(gesture: AxeSwipeGesture): Promise<void> {
    this.swipes.push(gesture);
  }

  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
}

const centerOf = (y: number): AxeTapTarget => ({
  kind: "point",
  x: 200,
  y: y + 20,
});

const flick: AxeSwipeGesture = {
  startX: 200,
  startY: 600,
  endX: 200,
  endY: 300,
};

const setup = (ys: readonly number[], motionSettleTimeout?: number) => {
  const clock = fakeClock();
  const driver = new MovingRowDriver(ys, clock);
  const device = new Device("primary", driver, {
    clock,
    ...(motionSettleTimeout === undefined ? {} : { motionSettleTimeout }),
  });
  return { clock, driver, device, row: device.findByLabel("Delete Account") };
};

describe("framesAgree", () => {
  const frame = { x: 0, y: 100, width: 400, height: 40 };

  it("treats frames within a point of each other as the same", () => {
    expect(framesAgree(frame, { ...frame, y: 100.6 })).toBe(true);
    expect(framesAgree(frame, { ...frame, width: 399.5 })).toBe(true);
  });

  it("treats a move of more than a point as motion", () => {
    expect(framesAgree(frame, { ...frame, y: 101.5 })).toBe(false);
  });

  it("agrees when neither read has a frame, and not when only one does", () => {
    expect(framesAgree(undefined, undefined)).toBe(true);
    expect(framesAgree(frame, undefined)).toBe(false);
  });
});

describe("settle check after motion", () => {
  it("taps where the row stops, not where it was mid-coast", async () => {
    const { driver, device, row } = setup([500, 420, 380, 380]);

    await device.swipe(flick);
    await row.tap();

    expect(driver.taps).toEqual([centerOf(380)]);
    expect(driver.dumps).toBe(4);
  });

  it("costs one extra read when the row was already still", async () => {
    const { driver, device, row } = setup([380]);

    await device.swipe(flick);
    await row.tap();

    expect(driver.taps).toEqual([centerOf(380)]);
    expect(driver.dumps).toBe(2);
  });

  it("costs no extra read when nothing has moved the screen", async () => {
    const { driver, row } = setup([500, 420, 380]);

    await row.tap();

    expect(driver.taps).toEqual([centerOf(500)]);
    expect(driver.dumps).toBe(1);
  });

  it("treats a tap as motion: the next locator tap confirms its target", async () => {
    const { driver, row } = setup([380]);

    await row.tap();
    await row.tap();

    expect(driver.dumps).toBe(3);
  });

  it("counts an earlier read since the motion as the confirming read", async () => {
    const { clock, driver, device, row } = setup([380]);

    await device.swipe(flick);
    expect(await row.isPresent()).toBe(true);
    clock.advance(500); // the flow waited on something else meanwhile
    await row.tap();

    expect(driver.taps).toEqual([centerOf(380)]);
    expect(driver.dumps).toBe(2);
  });

  it("does not count a read from before the motion", async () => {
    const { driver, device, row } = setup([380]);

    expect(await row.isPresent()).toBe(true);
    await device.swipe(flick);
    // The first read after the swipe comes before the list starts moving,
    // so it matches the read from before the swipe by coincidence.
    driver.moveThrough([380, 300, 300]);
    await row.tap();

    expect(driver.taps).toEqual([centerOf(300)]);
  });

  it("acts on the latest read once the cap is spent", async () => {
    const ys = Array.from({ length: 100 }, (_, index) => 700 - index * 5);
    const { clock, driver, device, row } = setup(ys, 300);

    await device.swipe(flick);
    const started = clock.now();
    await row.tap();

    // Each read costs 60ms: the check stops at the first read past 300ms
    // rather than failing a tap that would have gone ahead before.
    expect(clock.now() - started).toBeGreaterThanOrEqual(300);
    expect(clock.now() - started).toBeLessThan(300 + 2 * DUMP_MS);
    expect(driver.taps).toHaveLength(1);
    const last = 700 - (driver.dumps - 1) * 5;
    expect(driver.taps[0]).toEqual(centerOf(last));
  });

  it("is off when motionSettleTimeout is 0", async () => {
    const { driver, device, row } = setup([500, 420, 380], 0);

    await device.swipe(flick);
    await row.tap();

    expect(driver.taps).toEqual([centerOf(500)]);
    expect(driver.dumps).toBe(1);
  });

  it("leaves point taps alone", async () => {
    const { driver, device } = setup([500, 420, 380]);

    await device.swipe(flick);
    await device.tapPoint(200, 520);

    expect(driver.dumps).toBe(0);
  });

  it("checks the frame scrollIntoView measures after motion", async () => {
    // Mid-coast the row reads inside the 800pt viewport; it then coasts on
    // to rest below it, so scrollIntoView must swipe instead of returning.
    const { driver, device, row } = setup([700, 900, 900]);

    await device.swipe(flick);
    driver.swipes.length = 0;
    driver.moveThrough([700, 900, 900, 400, 400]);
    await row.scrollIntoView({ settleMs: 0 });

    expect(driver.swipes).toHaveLength(1);
  });

  it("asks the driver for a fresh read when it confirms", async () => {
    const { driver, device, row } = setup([380]);

    await device.swipe(flick);
    await row.tap();

    expect(driver.freshDumps).toBe(1);
  });
});

describe("settle check over the event cache", () => {
  /** A beacon that never fires — what native scroll inertia looks like. */
  const silentSignal: UiChangeSignal = {
    subscribe: () => () => {},
    ensureWatching: () => {},
    dispose: () => {},
  };

  it("sees a coasting list the change beacon cannot", async () => {
    const clock = fakeClock();
    const inner = new MovingRowDriver([500, 420, 380, 380], clock);
    const cached = new AxeEventCachedDriver(inner, { signal: silentSignal });
    const device = new Device("primary", cached, { clock });

    await device.swipe(flick);
    await device.findByLabel("Delete Account").tap();

    expect(inner.taps).toEqual([centerOf(380)]);
  });

  it("serves a fresh read past a clean cache", async () => {
    const inner = new MovingRowDriver([500, 420]);
    const cached = new AxeEventCachedDriver(inner, { signal: silentSignal });

    await cached.describeUi();
    await cached.describeUi();
    expect(inner.dumps).toBe(1);

    await cached.describeUi({ fresh: true });
    expect(inner.dumps).toBe(2);
  });
});
