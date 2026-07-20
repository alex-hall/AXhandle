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

  it("isPresent() answers presence without strictness", async () => {
    const device = new Device("primary", new FixtureAxeDriver(duplicated));

    await expect(device.findByLabel("Saved").isPresent()).resolves.toBe(true);
    await expect(device.findByLabel("Missing").isPresent()).resolves.toBe(false);
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

    await expect(device.findByLabel("ada lovelace", { exact: false }).isPresent()).resolves.toBe(true);
    await expect(device.findByText("room", { exact: false }).isPresent()).resolves.toBe(true);
    // The exact query keeps its trap: an ASCII space never equals U+00A0.
    await expect(device.findByLabel("Ada Lovelace").isPresent()).resolves.toBe(false);
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

describe("waitForPresent", () => {
  it("resolves when a match appears and reports absence on timeout", async () => {
    const empty = { role_description: "application", children: [] };
    const withBanner = {
      role_description: "application",
      children: [text("Connected")],
    };
    const device = new Device(
      "primary",
      new SequenceDriver([empty, empty, withBanner]),
      { clock: fakeClock() },
    );

    await expect(
      device.findByLabel("Connected").waitForPresent(),
    ).resolves.toBeUndefined();

    const never = new Device("primary", new SequenceDriver([empty]), {
      clock: fakeClock(),
    });
    await expect(
      never.findByLabel("Connected").waitForPresent({ timeout: 300 }),
    ).rejects.toThrow(/never appeared within 300ms/);
  });
});

describe("non-strict reads", () => {
  const roster = {
    role_description: "application",
    children: [
      text("AB, Ada Lovelace, View Profile, Forward"),
      text("GH, Grace Hopper, View Profile, Forward"),
    ],
  };

  it("presentNodes() returns matched content without strictness", async () => {
    const device = new Device("primary", new FixtureAxeDriver(roster));

    const rows = await device
      .findByLabel("View Profile", { exact: false })
      .presentNodes();

    expect(rows.map((row) => row.label)).toEqual([
      "AB, Ada Lovelace, View Profile, Forward",
      "GH, Grace Hopper, View Profile, Forward",
    ]);
    await expect(
      device.findByLabel("Missing", { exact: false }).presentNodes(),
    ).resolves.toEqual([]);
  });

  it("matchesIn() answers many queries from one snapshot fetch", async () => {
    const keypad = {
      role_description: "application",
      children: ["1", "2", "3"].map((digit) => ({
        role_description: "button",
        AXLabel: digit,
        frame: { x: Number(digit) * 100, y: 600, width: 80, height: 80 },
        children: [],
      })),
    };
    const driver = new SequenceDriver([keypad]);
    const device = new Device("primary", driver);

    const { tree } = await device.uiSnapshot();
    const frames = ["3", "1", "2"].map(
      (digit) => device.findByLabel(digit).matchesIn(tree)[0]?.frame?.x,
    );

    expect(frames).toEqual([300, 100, 200]);
    expect(driver.reads).toBe(1);
  });
});

describe("named raw actions and reentrancy", () => {
  class GestureDriver implements AxeDriver {
    readonly tapTargets: AxeTapTarget[] = [];
    readonly longPresses: Array<{ x: number; y: number; holdMs?: number }> = [];

    async describeUi(): Promise<unknown> {
      return { role_description: "application", children: [] };
    }

    async tap(target: AxeTapTarget): Promise<void> {
      this.tapTargets.push(target);
    }

    async longPress(x: number, y: number, holdMs?: number): Promise<void> {
      this.longPresses.push({ x, y, holdMs });
    }

    async type(_text: string): Promise<void> {}
    async keyCombo(_modifiers: readonly number[], _key: number): Promise<void> {}
  }

  it("tags coordinate gestures with caller-chosen log names", async () => {
    const driver = new GestureDriver();
    const device = new Device("primary", driver);

    await device.tapPoint(150, 620, { command: "numpad-7" });
    await device.longPress(200, 420, { holdMs: 900, command: "copy-link" });

    expect(driver.longPresses).toEqual([{ x: 200, y: 420, holdMs: 900 }]);
    const commands = device.commandLog().map((entry) => entry.command);
    expect(commands).toEqual(["numpad-7", "copy-link"]);
  });

  it("fails explicitly when the driver lacks long-press", async () => {
    const device = new Device("primary", new FixtureAxeDriver({ children: [] }));

    await expect(device.longPress(0, 0)).rejects.toThrow(
      "does not support long-presses",
    );
  });

  it("allows device calls nested inside recordAction without deadlock", async () => {
    const driver = new GestureDriver();
    const device = new Device("primary", driver);

    await device.recordAction("enter-passcode", async () => {
      await device.tapPoint(100, 600, { command: "numpad-1" });
      await device.tapPoint(200, 600, { command: "numpad-2" });
    });

    expect(driver.tapTargets).toHaveLength(2);
    const commands = device.commandLog().map((entry) => entry.command);
    expect(commands).toEqual(["numpad-1", "numpad-2", "enter-passcode"]);
  });

  it("still serializes concurrent recordAction calls against queued commands", async () => {
    const driver = new GestureDriver();
    const device = new Device("primary", driver);
    const order: string[] = [];

    await Promise.all([
      device.recordAction("first", async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first-end");
      }),
      device.recordAction("second", async () => {
        order.push("second");
      }),
    ]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("matchesIn strictness", () => {
  it("defaults to presence semantics and matches resolve() under { strict: true }", async () => {
    const duplicated = {
      role_description: "application",
      children: [text("Saved"), text("Saved")]
    };
    const device = new Device("primary", new FixtureAxeDriver(duplicated));
    const { tree } = await device.uiSnapshot();
    const saved = device.findByLabel("Saved");

    expect(saved.matchesIn(tree)).toHaveLength(2);
    // Strict keeps interaction-grade behavior: a duplicated FINAL segment
    // returns all matches (strictness applies to intermediate scopes)...
    expect(saved.matchesIn(tree, { strict: true })).toHaveLength(2);
    // ...but a scoped query under an ambiguous intermediate scope throws.
    expect(() =>
      saved.findByText("anything").matchesIn(tree, { strict: true })
    ).toThrow("expected one matching accessible element");
    expect(saved.findByText("anything").matchesIn(tree)).toEqual([]);
    // The 0.1.x-era alias keeps strict behavior until 1.0.
    expect(saved.matchesFrom(tree)).toHaveLength(2);
  });
});
