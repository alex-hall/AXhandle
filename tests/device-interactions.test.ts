import { describe, expect, it } from "vitest";
import { Device, LocatorTimeoutError } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";
import type { AxeDriver, AxeSwipeGesture, AxeTapTarget, Clock } from "../src/types.js";

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

const button = (label: string, id: string) => ({
  role_description: "button",
  AXUniqueId: id,
  AXLabel: label,
  AXEnabled: true,
  frame: { x: 0, y: 0, width: 100, height: 44 },
  children: []
});

const text = (label: string) => ({
  role_description: "statictext",
  AXLabel: label,
  children: []
});

/** A screen whose arrival marker only appears after N taps have landed. */
class FlakyButtonDriver implements AxeDriver {
  taps = 0;

  constructor(private readonly tapsRequired: number) {}

  async describeUi(): Promise<unknown> {
    return {
      role_description: "application",
      children: [
        button("Continue", "continue"),
        ...(this.taps >= this.tapsRequired ? [text("Welcome")] : [])
      ]
    };
  }

  async tap(_target: AxeTapTarget): Promise<void> {
    this.taps += 1;
  }

  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
}

class SequenceDriver implements AxeDriver {
  reads = 0;

  constructor(private readonly snapshots: readonly unknown[]) {}

  async describeUi(): Promise<unknown> {
    const index = Math.min(this.reads++, this.snapshots.length - 1);
    return this.snapshots[index];
  }

  async tap(_target: AxeTapTarget): Promise<void> {}
  async type(_text: string): Promise<void> {}
  async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
}

describe("tap({ until })", () => {
  it("retaps until the arrival locator is present", async () => {
    const driver = new FlakyButtonDriver(2);
    const device = new Device("primary", driver, { clock: fakeClock() });

    await device
      .findByLabel("Continue")
      .tap({ until: device.findByLabel("Welcome"), settleTimeout: 300 });

    expect(driver.taps).toBe(2);
  });

  it("fails loudly when the arrival locator never appears", async () => {
    const driver = new FlakyButtonDriver(Number.MAX_SAFE_INTEGER);
    const device = new Device("primary", driver, { clock: fakeClock() });

    await expect(
      device
        .findByLabel("Continue")
        .tap({ until: device.findByLabel("Welcome"), attempts: 2, settleTimeout: 300 })
    ).rejects.toThrow(/Tapped .* 2 times, but .* never appeared/);
    expect(driver.taps).toBe(2);
  });
});

describe("presence primitives", () => {
  const duplicated = {
    role_description: "application",
    children: [text("Saved"), text("Saved")]
  };

  it("exists() answers presence without strictness", async () => {
    const device = new Device("primary", new FixtureAxeDriver(duplicated));

    await expect(device.findByLabel("Saved").exists()).resolves.toBe(true);
    await expect(device.findByLabel("Missing").exists()).resolves.toBe(false);
    // The same ambiguous query is an error for interaction-grade resolution.
    await expect(device.findByLabel("Saved").resolve()).rejects.toThrow(
      "expected one matching accessible element"
    );
  });

  it("waitForGone() resolves when the last match leaves the tree", async () => {
    const withToast = { role_description: "application", children: [text("Uploading")] };
    const without = { role_description: "application", children: [] };
    const device = new Device(
      "primary",
      new SequenceDriver([withToast, withToast, without]),
      { clock: fakeClock() }
    );

    await expect(device.findByLabel("Uploading").waitForGone()).resolves.toBeUndefined();
  });

  it("waitForGone() reports the surviving matches on timeout", async () => {
    const withToast = { role_description: "application", children: [text("Uploading")] };
    const device = new Device("primary", new FixtureAxeDriver(withToast), {
      clock: fakeClock()
    });

    await expect(
      device.findByLabel("Uploading").waitForGone({ timeout: 300 })
    ).rejects.toThrow(LocatorTimeoutError);
  });

  it("firstPresent() races locators against one snapshot", async () => {
    const driver = new SequenceDriver([
      { role_description: "application", children: [text("Home")] }
    ]);
    const device = new Device("primary", driver);
    const signIn = device.findByLabel("Sign in");
    const home = device.findByLabel("Home");

    await expect(device.firstPresent(signIn, home)).resolves.toBe(home);
    expect(driver.reads).toBe(1);

    await expect(device.firstPresent(signIn)).resolves.toBeUndefined();
  });
});

describe("substring queries", () => {
  // Composite labels are frequently joined with no-break spaces on iOS, so a
  // query typed with an ordinary space must still match.
  const screen = {
    role_description: "application",
    children: [text("Ada\u00a0Lovelace"), { role_description: "statictext", AXValue: "Room 42", children: [] }]
  };

  it("matches labels case-insensitively across no-break spaces", async () => {
    const device = new Device("primary", new FixtureAxeDriver(screen));

    await expect(device.findByLabel("ada lovelace", { exact: false }).exists()).resolves.toBe(true);
    await expect(device.findByText("room", { exact: false }).exists()).resolves.toBe(true);
    // The exact query keeps its trap: an ASCII space never equals U+00A0.
    await expect(device.findByLabel("Ada Lovelace").exists()).resolves.toBe(false);
  });

  it("describes non-exact queries distinctly", () => {
    const device = new Device("primary", new FixtureAxeDriver(screen));

    expect(device.findByLabel("ada", { exact: false }).describe()).toBe(
      'findByLabel("ada", { exact: false })'
    );
  });
});

describe("device-level driver actions", () => {
  class RecordingDriver implements AxeDriver {
    readonly tapTargets: AxeTapTarget[] = [];
    readonly labelTaps: Array<{ label: string; waitTimeoutMs?: number }> = [];
    readonly swipes: AxeSwipeGesture[] = [];

    async describeUi(): Promise<unknown> {
      return { role_description: "application", children: [] };
    }

    async tap(target: AxeTapTarget): Promise<void> {
      this.tapTargets.push(target);
    }

    async tapLabel(label: string, waitTimeoutMs?: number): Promise<void> {
      this.labelTaps.push({ label, waitTimeoutMs });
      if (label === "Never Appears") throw new Error("No matches found for label");
    }

    async swipe(gesture: AxeSwipeGesture): Promise<void> {
      this.swipes.push(gesture);
    }

    async type(_text: string): Promise<void> {}
    async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
  }

  it("taps coordinates through the queue and log", async () => {
    const driver = new RecordingDriver();
    const device = new Device("primary", driver);

    await device.tapPoint(200, 500);

    expect(driver.tapTargets).toEqual([{ kind: "point", x: 200, y: 500 }]);
    expect(device.commandLog()).toContainEqual(
      expect.objectContaining({ command: "tap-point", status: "passed" })
    );
  });

  it("passes label taps through and reports optional misses as false", async () => {
    const driver = new RecordingDriver();
    const device = new Device("primary", driver);

    await expect(device.tapLabel("Allow", { waitTimeout: 5_000 })).resolves.toBe(true);
    await expect(
      device.tapLabel("Never Appears", { optional: true })
    ).resolves.toBe(false);
    await expect(device.tapLabel("Never Appears")).rejects.toThrow("No matches found");

    expect(driver.labelTaps[0]).toEqual({ label: "Allow", waitTimeoutMs: 5_000 });
  });

  it("swipes through the queue and log", async () => {
    const driver = new RecordingDriver();
    const device = new Device("primary", driver);

    await device.swipe({ startX: 200, startY: 650, endX: 200, endY: 250, durationMs: 400 });

    expect(driver.swipes).toHaveLength(1);
    expect(device.commandLog()).toContainEqual(
      expect.objectContaining({ command: "swipe", status: "passed" })
    );
  });

  it("fails explicitly when the driver lacks an optional capability", async () => {
    const device = new Device("primary", new FixtureAxeDriver({ children: [] }));

    await expect(device.tapLabel("Allow")).rejects.toThrow("does not support label taps");
    await expect(
      device.swipe({ startX: 0, startY: 0, endX: 0, endY: 100 })
    ).rejects.toThrow("does not support swipes");
  });
});

describe("recordAction and log windowing", () => {
  it("serializes out-of-band work into the shared command log", async () => {
    const device = new Device("primary", new FixtureAxeDriver({ children: [] }));

    await expect(device.recordAction("biometric.match", async () => 42)).resolves.toBe(42);
    await expect(
      device.recordAction("app.launch", async () => {
        throw new Error("boot failed");
      })
    ).rejects.toThrow("boot failed");

    const log = device.commandLog();
    expect(log).toContainEqual(
      expect.objectContaining({ command: "biometric.match", status: "passed" })
    );
    expect(log).toContainEqual(
      expect.objectContaining({ command: "app.launch", status: "failed", error: "boot failed" })
    );
  });

  it("windows the log by a mark for step attribution", async () => {
    const device = new Device("primary", new FixtureAxeDriver({ children: [] }));

    await device.recordAction("before", async () => undefined);
    const mark = device.commandMark();
    await device.recordAction("inside", async () => undefined);

    const window = device.commandLog({ after: mark });
    expect(window).toHaveLength(1);
    expect(window[0]).toMatchObject({ command: "inside" });
    expect(device.commandLog()).toHaveLength(2);
  });
});
