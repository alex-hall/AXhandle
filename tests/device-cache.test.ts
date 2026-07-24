import { describe, expect, it } from "vitest";
import { Device } from "../src/index.js";
import type { AxeDriver, AxeTapTarget, Clock } from "../src/types.js";

const screenWith = (label: string): unknown => ({
  role_description: "button",
  role: "AXButton",
  AXUniqueId: "primary-action",
  AXLabel: label,
  enabled: true,
  children: [],
});

/** Serves a sequence of screens and counts every dump the device asks for. */
class CountingDriver implements AxeDriver {
  dumps = 0;

  constructor(private readonly screens: readonly unknown[]) {}

  async describeUi(): Promise<unknown> {
    const index = Math.min(this.dumps++, this.screens.length - 1);
    return this.screens[index];
  }

  async tap(_target: AxeTapTarget): Promise<void> {}
  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
}

const fakeClock = (): Clock => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
  };
};

describe("Device snapshot cache", () => {
  it("shares one dump across back-to-back reads inside the window", async () => {
    const driver = new CountingDriver([screenWith("Send")]);
    const device = new Device("primary", driver, { clock: fakeClock() });

    expect(await device.findByLabel("Send").isPresent()).toBe(true);
    expect(await device.findByLabel("Send").isPresent()).toBe(true);
    expect(await device.findByTestId("primary-action").isPresent()).toBe(true);

    expect(driver.dumps).toBe(1);
  });

  it("re-dumps once the window has elapsed", async () => {
    const driver = new CountingDriver([screenWith("Send")]);
    const clock = fakeClock();
    const device = new Device("primary", driver, { clock });

    await device.findByLabel("Send").isPresent();
    await clock.sleep(51); // default window: min(interval - 1, 50) = 50
    await device.findByLabel("Send").isPresent();

    expect(driver.dumps).toBe(2);
  });

  it("invalidates the cache the moment any action runs", async () => {
    const driver = new CountingDriver([
      screenWith("Send"),
      screenWith("Sent!"),
    ]);
    const device = new Device("primary", driver, { clock: fakeClock() });

    expect(await device.findByLabel("Send").isPresent()).toBe(true);
    await device.tapPoint(200, 500);
    // No clock time has passed, but the tap may have changed the screen.
    expect(await device.findByLabel("Sent!").isPresent()).toBe(true);
    expect(driver.dumps).toBe(2);
  });

  it("cacheWindowMs: 0 disables reuse entirely", async () => {
    const driver = new CountingDriver([screenWith("Send")]);
    const device = new Device("primary", driver, {
      clock: fakeClock(),
      cacheWindowMs: 0,
    });

    await device.findByLabel("Send").isPresent();
    await device.findByLabel("Send").isPresent();

    expect(driver.dumps).toBe(2);
  });

  it("clamps the window strictly below the poll interval", async () => {
    const clock = fakeClock();
    const device = new Device(
      "primary",
      new CountingDriver([screenWith("Send")]),
      { clock, timeouts: { interval: 5 }, cacheWindowMs: 500 },
    );

    expect(device.cacheWindowMs).toBe(4);
  });

  it("derives the default window from the poll interval", () => {
    const driver = new CountingDriver([screenWith("Send")]);
    const byInterval = (interval: number) =>
      new Device("primary", driver, { timeouts: { interval } }).cacheWindowMs;

    expect(byInterval(100)).toBe(50); // capped at 50
    expect(byInterval(20)).toBe(19); // interval - 1
    expect(byInterval(1)).toBe(0); // cache off — nothing fits below 1ms
  });

  it("re-dumps for poll intervals shorter than the cache window", async () => {
    // A per-call interval can undercut the device-level one the window is
    // clamped against. Every sleep on the device's clock invalidates the
    // cache, so the second iteration must see the new screen after only
    // 10ms — not keep re-reading the cached "Loading" dump until the
    // 50ms window expires.
    const driver = new CountingDriver([
      screenWith("Loading"),
      screenWith("Send"),
    ]);
    const clock = fakeClock();
    const device = new Device("primary", driver, { clock });

    await device
      .findByLabel("Send")
      .waitForPresent({ timeout: 1_000, interval: 10 });

    expect(driver.dumps).toBe(2);
    expect(device.clock.now()).toBe(10);
  });

  it("polled waits hit a fresh dump every iteration", async () => {
    // The button appears on the third dump. Poll iterations are one interval
    // apart — beyond the cache window — so the wait must observe every screen
    // rather than re-reading its first cached dump until timeout.
    const driver = new CountingDriver([
      screenWith("Loading"),
      screenWith("Loading"),
      screenWith("Send"),
    ]);
    const clock = fakeClock();
    const device = new Device("primary", driver, { clock });

    await device.findByLabel("Send").waitForPresent({ timeout: 1_000 });

    expect(driver.dumps).toBe(3);
  });
});
