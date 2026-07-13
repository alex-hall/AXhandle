import { Locator, LocatorResolutionError, LocatorTimeoutError } from "./locator.js";
import { normalizeAxeTree } from "./tree.js";
import type {
  AccessibilityNode,
  AxeDriver,
  AxeTapTarget,
  Clock,
  FillOptions,
  WaitOptions
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

export interface DeviceCommandLogEntry {
  sequence: number;
  command: "inspect" | "click" | "type" | "fill" | "screenshot";
  startedAt: number;
  finishedAt: number;
  status: DeviceCommandStatus;
  error?: string;
}

const defaultTimeouts: DeviceTimeouts = {
  action: 3_000,
  assertion: 5_000,
  interval: 100
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
    options: DeviceOptions = {}
  ) {
    this.clock = options.clock ?? systemClock;
    this.timeouts = { ...defaultTimeouts, ...options.timeouts };
  }

  findByTestId(value: string): Locator {
    return Locator.from(this, { kind: "testId", value });
  }

  findByText(value: string): Locator {
    return Locator.from(this, { kind: "text", value });
  }

  findByLabel(value: string): Locator {
    return Locator.from(this, { kind: "label", value });
  }

  findByRole(role: string, options: { name?: string } = {}): Locator {
    return Locator.from(this, { kind: "role", role, name: options.name });
  }

  async inspect(locator: Locator): Promise<AccessibilityNode> {
    return this.enqueue("inspect", async () =>
      locator.resolveFrom(normalizeAxeTree(await this.driver.describeUi()))
    );
  }

  async count(locator: Locator): Promise<number> {
    return this.enqueue("inspect", async () =>
      locator.matchesFrom(normalizeAxeTree(await this.driver.describeUi())).length
    );
  }

  async click(locator: Locator, options: WaitOptions = {}): Promise<void> {
    await this.enqueue("click", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      await this.driver.tap(this.tapTargetFor(node, tree));
    });
  }

  async typeInto(locator: Locator, text: string, options: WaitOptions = {}): Promise<void> {
    await this.enqueue("type", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      await this.driver.tap(this.tapTargetFor(node, tree));
      await this.driver.type(text);
    });
  }

  async fill(locator: Locator, text: string, options: FillOptions = {}): Promise<void> {
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
        interval: options.interval
      });
    }
  }

  async screenshot(output: string): Promise<string> {
    return this.enqueue("screenshot", async () => {
      if (!this.driver.screenshot) {
        throw new Error("The configured AXe driver does not support screenshots.");
      }
      return this.driver.screenshot(output);
    });
  }

  /** A copy of the structured command history for reporters and artifact sinks. */
  commandLog(): readonly DeviceCommandLogEntry[] {
    return this.log.map((entry) => ({ ...entry }));
  }

  private tapTargetFor(node: AccessibilityNode, tree: ReturnType<typeof normalizeAxeTree>): AxeTapTarget {
    if (node.id && countId(tree.root, node.id) === 1) {
      return { kind: "id", id: node.id };
    }

    if (node.frame) {
      return {
        kind: "point",
        x: node.frame.x + node.frame.width / 2,
        y: node.frame.y + node.frame.height / 2
      };
    }

    throw new Error(
      `Cannot tap ${node.role}: it has no unique accessibility id or frame.`
    );
  }

  private async resolveActionTarget(
    locator: Locator,
    options: WaitOptions
  ): Promise<{ tree: ReturnType<typeof normalizeAxeTree>; node: AccessibilityNode }> {
    const timeout = options.timeout ?? this.timeouts.action;
    const interval = options.interval ?? this.timeouts.interval;
    const deadline = this.clock.now() + timeout;
    let lastError: LocatorResolutionError | undefined;

    while (true) {
      const tree = normalizeAxeTree(await this.driver.describeUi());
      try {
        return { tree, node: locator.resolveFrom(tree) };
      } catch (error) {
        if (!(error instanceof LocatorResolutionError)) throw error;
        lastError = error;
      }

      if (this.clock.now() >= deadline) {
        throw new LocatorTimeoutError(
          `${locator.describe()} was not actionable within ${timeout}ms. ${lastError?.message ?? ""}`.trim()
        );
      }

      await this.clock.sleep(interval);
    }
  }

  private async enqueue<T>(
    command: DeviceCommandLogEntry["command"],
    operation: () => Promise<T>
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
        status: "passed"
      });
      return result;
    } catch (error) {
      this.log.push({
        sequence,
        command,
        startedAt,
        finishedAt: this.clock.now(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      release?.();
    }
  }
}

const countId = (node: AccessibilityNode, id: string): number =>
  (node.id === id ? 1 : 0) + node.children.reduce((count, child) => count + countId(child, id), 0);
