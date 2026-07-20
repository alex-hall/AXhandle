import {
  Locator,
  LocatorResolutionError,
  LocatorTimeoutError,
} from "./locator.js";
import type { TapOptions, TextQueryOptions } from "./locator.js";
import { poll, PollTimeoutError } from "./poll.js";
import { checkedState } from "./state.js";
import { normalizeAxeTree } from "./tree.js";
import type {
  AccessibilityNode,
  AccessibilityTree,
  AxeDriver,
  AxeSwipeGesture,
  AxeTapTarget,
  Clock,
  FillOptions,
  WaitOptions,
} from "./types.js";
import { systemClock } from "./types.js";

export interface DeviceTimeouts {
  action: number;
  assertion: number;
  interval: number;
}

export interface DeviceOptions {
  clock?: Clock;
  timeouts?: Partial<DeviceTimeouts>;
}

export type DeviceCommandStatus = "passed" | "failed";

/**
 * Built-in command names, plus any name given to recordAction() — every
 * timed operation on a device shares this one log.
 */
export type DeviceCommandName =
  | "inspect"
  | "tap"
  | "tap-point"
  | "tap-label"
  | "swipe"
  | "type"
  | "fill"
  | "check"
  | "uncheck"
  | "screenshot"
  | (string & {});

export interface DeviceCommandLogEntry {
  sequence: number;
  command: DeviceCommandName;
  startedAt: number;
  finishedAt: number;
  status: DeviceCommandStatus;
  error?: string;
}

export interface TapLabelOptions {
  /** How long AXe should wait for the label to exist before tapping. */
  waitTimeout?: number;
  /**
   * `optional: true` returns false instead of throwing when the tap fails —
   * the standard way to drain a system alert whose arrival races the flow.
   */
  optional?: boolean;
}

export interface UiSnapshot {
  raw: unknown;
  tree: AccessibilityTree;
}

const defaultTimeouts: DeviceTimeouts = {
  action: 3_000,
  assertion: 5_000,
  interval: 100,
};

/**
 * A named iOS Simulator facade. Commands on one device are serialised, while
 * separate Device instances remain ordinary, independently composable promises.
 */
export class Device {
  readonly clock: Clock;
  readonly timeouts: DeviceTimeouts;
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly log: DeviceCommandLogEntry[] = [];

  constructor(
    readonly name: string,
    private readonly driver: AxeDriver,
    options: DeviceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.timeouts = { ...defaultTimeouts, ...options.timeouts };
  }

  findByTestId(value: string): Locator {
    return Locator.from(this, { kind: "testId", value });
  }

  findByText(value: string, options: TextQueryOptions = {}): Locator {
    return Locator.from(
      this,
      options.exact === false
        ? { kind: "text", value, exact: false }
        : { kind: "text", value },
    );
  }

  findByLabel(value: string, options: TextQueryOptions = {}): Locator {
    return Locator.from(
      this,
      options.exact === false
        ? { kind: "label", value, exact: false }
        : { kind: "label", value },
    );
  }

  findByRole(role: string, options: { name?: string } = {}): Locator {
    return Locator.from(this, { kind: "role", role, name: options.name });
  }

  async inspect(locator: Locator): Promise<AccessibilityNode> {
    return this.enqueue("inspect", async () =>
      locator.resolveFrom(normalizeAxeTree(await this.driver.describeUi())),
    );
  }

  async accessibilityTree(): Promise<AccessibilityTree> {
    return (await this.uiSnapshot()).tree;
  }

  async uiSnapshot(): Promise<UiSnapshot> {
    return this.enqueue("inspect", async () => {
      const raw = await this.driver.describeUi();
      return { raw, tree: normalizeAxeTree(raw) };
    });
  }

  async count(locator: Locator): Promise<number> {
    return this.enqueue(
      "inspect",
      async () =>
        locator.matchesFrom(normalizeAxeTree(await this.driver.describeUi()))
          .length,
    );
  }

  /** Non-strict match count for presence checks; see Locator.exists(). */
  async presenceCount(locator: Locator): Promise<number> {
    return this.enqueue(
      "inspect",
      async () =>
        locator.presenceMatches(
          normalizeAxeTree(await this.driver.describeUi()),
        ).length,
    );
  }

  /**
   * Which of these is on screen? Evaluates every candidate against ONE
   * accessibility snapshot and returns the first present (in argument order),
   * or undefined. Prefer this over consecutive exists() calls — each of those
   * is a full tree fetch.
   */
  async firstPresent(
    ...locators: readonly Locator[]
  ): Promise<Locator | undefined> {
    return this.enqueue("inspect", async () => {
      const tree = normalizeAxeTree(await this.driver.describeUi());
      return locators.find(
        (locator) => locator.presenceMatches(tree).length > 0,
      );
    });
  }

  /** @deprecated Use {@link tap} — iOS has taps, not clicks. Removed in 1.0. */
  async click(locator: Locator, options: TapOptions = {}): Promise<void> {
    await this.tap(locator, options);
  }

  async tap(locator: Locator, options: TapOptions = {}): Promise<void> {
    const until = options.until;
    if (until === undefined) {
      await this.enqueue("tap", () => this.tapOnce(locator, options));
      return;
    }

    // Tap-until-arrival: one successful tap is not proof of navigation (a
    // control can render before its touch handler attaches, or an overlay can
    // swallow the tap), so retap until the arrival locator is present.
    const attempts = options.attempts ?? 3;
    const settleTimeout = options.settleTimeout ?? this.timeouts.action;
    const interval = options.interval ?? this.timeouts.interval;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.enqueue("tap", () => this.tapOnce(locator, options));
      } catch (error) {
        // The control may be gone precisely because an earlier tap landed.
        if (await until.exists()) return;
        throw error;
      }

      try {
        await poll(() => until.exists(), {
          timeout: settleTimeout,
          interval,
          clock: this.clock,
        });
        return;
      } catch (error) {
        if (!(error instanceof PollTimeoutError)) throw error;
        // Arrival marker not up yet — the tap may have been swallowed; retap.
      }
    }

    throw new LocatorTimeoutError(
      `Tapped ${locator.describe()} ${attempts} times, but ${until.describe()} never appeared.`,
    );
  }

  /** Coordinate tap through the device queue and command log. */
  async tapPoint(x: number, y: number): Promise<void> {
    await this.enqueue("tap-point", () =>
      this.driver.tap({ kind: "point", x, y }),
    );
  }

  /**
   * Tap by exact accessibility label WITHOUT resolving the tree — the escape
   * hatch for elements `describe-ui` never reports, native alert buttons
   * above all, and a one-CLI-call fast path where the next wait in the flow
   * verifies the outcome anyway. No actionability check happens. Returns
   * whether the tap landed; failures only throw when `optional` is unset.
   */
  async tapLabel(
    label: string,
    options: TapLabelOptions = {},
  ): Promise<boolean> {
    const tapLabel = this.driver.tapLabel?.bind(this.driver);
    if (!tapLabel) {
      throw new Error("The configured AXe driver does not support label taps.");
    }

    return this.enqueue("tap-label", async () => {
      try {
        await tapLabel(label, options.waitTimeout);
        return true;
      } catch (error) {
        if (options.optional) return false;
        throw error;
      }
    });
  }

  async swipe(gesture: AxeSwipeGesture): Promise<void> {
    const swipe = this.driver.swipe?.bind(this.driver);
    if (!swipe) {
      throw new Error("The configured AXe driver does not support swipes.");
    }
    await this.enqueue("swipe", () => swipe(gesture));
  }

  /**
   * Runs an out-of-band operation inside the device's command queue and log,
   * so work that bypasses the typed surface (biometric triggers, app
   * lifecycle, raw driver calls) still serializes with queued commands and
   * shows up in commandLog() with real timings.
   */
  async recordAction<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(name, operation);
  }

  async typeInto(
    locator: Locator,
    text: string,
    options: WaitOptions = {},
  ): Promise<void> {
    await this.enqueue("type", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      await this.driver.tap(this.tapTargetFor(node, tree));
      await this.driver.type(text);
    });
  }

  async fill(
    locator: Locator,
    text: string,
    options: FillOptions = {},
  ): Promise<void> {
    await this.enqueue("fill", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      await this.driver.tap(this.tapTargetFor(node, tree));
      // HID 227 is Left Command and 4 is the "A" key.
      await this.driver.keyCombo([227], 4);
      await this.driver.type(text);
    });

    if (options.verify ?? true) {
      await locator.waitFor((node) => node.value === text, {
        timeout: options.timeout ?? this.timeouts.action,
        interval: options.interval,
      });
    }
  }

  async setChecked(
    locator: Locator,
    expected: boolean,
    options: WaitOptions = {},
  ): Promise<void> {
    await this.enqueue(expected ? "check" : "uncheck", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      const current = checkedState(node);
      if (current === undefined) {
        throw new Error(
          `Cannot ${expected ? "check" : "uncheck"} ${locator.describe()}: AXe did not report a switch state.`,
        );
      }
      if (current !== expected)
        await this.driver.tap(this.tapTargetFor(node, tree));
    });

    await locator.waitFor((node) => checkedState(node) === expected, {
      timeout: options.timeout ?? this.timeouts.action,
      interval: options.interval,
    });
  }

  async screenshot(output: string): Promise<string> {
    return this.enqueue("screenshot", async () => {
      if (!this.driver.screenshot) {
        throw new Error(
          "The configured AXe driver does not support screenshots.",
        );
      }
      return this.driver.screenshot(output);
    });
  }

  /**
   * A copy of the structured command history for reporters and artifact
   * sinks. Pass `after` (a value from commandMark()) to window the log to the
   * commands issued since — the primitive for per-step timing attribution.
   */
  commandLog(
    options: { after?: number } = {},
  ): readonly DeviceCommandLogEntry[] {
    const after = options.after ?? 0;
    return this.log
      .filter((entry) => entry.sequence > after)
      .map((entry) => ({ ...entry }));
  }

  /** The current log position, for commandLog({ after }) windowing. */
  commandMark(): number {
    return this.sequence;
  }

  private async tapOnce(locator: Locator, options: WaitOptions): Promise<void> {
    const { tree, node } = await this.resolveActionTarget(locator, options);
    await this.driver.tap(this.tapTargetFor(node, tree));
  }

  private tapTargetFor(
    node: AccessibilityNode,
    tree: ReturnType<typeof normalizeAxeTree>,
  ): AxeTapTarget {
    if (node.id && countId(tree.root, node.id) === 1) {
      return { kind: "id", id: node.id };
    }

    if (node.frame) {
      return {
        kind: "point",
        x: node.frame.x + node.frame.width / 2,
        y: node.frame.y + node.frame.height / 2,
      };
    }

    throw new Error(
      `Cannot tap ${node.role}: it has no unique accessibility id or frame.`,
    );
  }

  private async resolveActionTarget(
    locator: Locator,
    options: WaitOptions,
  ): Promise<{
    tree: ReturnType<typeof normalizeAxeTree>;
    node: AccessibilityNode;
  }> {
    const timeout = options.timeout ?? this.timeouts.action;
    const interval = options.interval ?? this.timeouts.interval;
    const deadline = this.clock.now() + timeout;
    let lastError: LocatorResolutionError | undefined;

    while (true) {
      const tree = normalizeAxeTree(await this.driver.describeUi());
      try {
        const node = locator.resolveFrom(tree);
        if (!node.visible) {
          throw new LocatorResolutionError(
            `${locator.describe()} resolved to ${node.role}, but it is not visible.`,
          );
        }
        if (node.enabled === false) {
          throw new LocatorResolutionError(
            `${locator.describe()} resolved to ${node.role}, but it is disabled.`,
          );
        }
        return { tree, node };
      } catch (error) {
        if (!(error instanceof LocatorResolutionError)) throw error;
        lastError = error;
      }

      if (this.clock.now() >= deadline) {
        throw new LocatorTimeoutError(
          `${locator.describe()} was not actionable within ${timeout}ms. ${lastError?.message ?? ""}`.trim(),
        );
      }

      await this.clock.sleep(interval);
    }
  }

  private async enqueue<T>(
    command: DeviceCommandName,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const sequence = ++this.sequence;
    const startedAt = this.clock.now();
    try {
      const result = await operation();
      this.log.push({
        sequence,
        command,
        startedAt,
        finishedAt: this.clock.now(),
        status: "passed",
      });
      return result;
    } catch (error) {
      this.log.push({
        sequence,
        command,
        startedAt,
        finishedAt: this.clock.now(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      release?.();
    }
  }
}

const countId = (node: AccessibilityNode, id: string): number =>
  (node.id === id ? 1 : 0) +
  node.children.reduce((count, child) => count + countId(child, id), 0);
