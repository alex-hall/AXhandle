import { Locator } from "./locator.js";
import { normalizeAxeTree } from "./tree.js";
import type {
  AccessibilityNode,
  AxeDriver,
  AxeTapTarget,
  Clock,
  FillOptions
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
    return this.enqueue(async () => locator.resolveFrom(normalizeAxeTree(await this.driver.describeUi())));
  }

  async click(locator: Locator): Promise<void> {
    await this.enqueue(async () => {
      const tree = normalizeAxeTree(await this.driver.describeUi());
      const node = locator.resolveFrom(tree);
      await this.driver.tap(this.tapTargetFor(node, tree));
    });
  }

  async typeInto(locator: Locator, text: string): Promise<void> {
    await this.enqueue(async () => {
      const tree = normalizeAxeTree(await this.driver.describeUi());
      const node = locator.resolveFrom(tree);
      await this.driver.tap(this.tapTargetFor(node, tree));
      await this.driver.type(text);
    });
  }

  async fill(locator: Locator, text: string, options: FillOptions = {}): Promise<void> {
    await this.enqueue(async () => {
      const tree = normalizeAxeTree(await this.driver.describeUi());
      const node = locator.resolveFrom(tree);
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

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

const countId = (node: AccessibilityNode, id: string): number =>
  (node.id === id ? 1 : 0) + node.children.reduce((count, child) => count + countId(child, id), 0);
