import type { Device } from "./device.js";
import { accessibilityPath, descendants, nodeDescription } from "./tree.js";
import type {
  AccessibilityNode,
  AccessibilityTree,
  FillOptions,
  WaitOptions
} from "./types.js";

export type LocatorQuery =
  | { kind: "testId"; value: string }
  | { kind: "text"; value: string }
  | { kind: "label"; value: string }
  | { kind: "role"; role: string; name?: string };

interface LocatorSegment {
  query: LocatorQuery;
  index?: number;
}

export class LocatorResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorResolutionError";
  }
}

export class LocatorTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorTimeoutError";
  }
}

export class Locator {
  private constructor(
    private readonly device: Device,
    private readonly segments: readonly LocatorSegment[]
  ) {}

  static from(device: Device, query: LocatorQuery): Locator {
    return new Locator(device, [{ query }]);
  }

  findByTestId(value: string): Locator {
    return this.append({ kind: "testId", value });
  }

  findByText(value: string): Locator {
    return this.append({ kind: "text", value });
  }

  findByLabel(value: string): Locator {
    return this.append({ kind: "label", value });
  }

  findByRole(role: string, options: { name?: string } = {}): Locator {
    return this.append({ kind: "role", role, name: options.name });
  }

  first(): Locator {
    return this.nth(0);
  }

  second(): Locator {
    return this.nth(1);
  }

  third(): Locator {
    return this.nth(2);
  }

  nth(index: number): Locator {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError("Locator nth() expects a non-negative integer.");
    }

    const last = this.segments.at(-1);
    if (!last) throw new Error("A locator needs at least one query segment.");

    return new Locator(this.device, [
      ...this.segments.slice(0, -1),
      { ...last, index }
    ]);
  }

  async click(options?: WaitOptions): Promise<void> {
    await this.device.click(this, options);
  }

  async type(text: string, options?: WaitOptions): Promise<void> {
    await this.device.typeInto(this, text, options);
  }

  /** Replaces existing text with Command-A followed by AXe HID text entry. */
  async fill(text: string, options?: FillOptions): Promise<void> {
    await this.device.fill(this, text, options);
  }

  /** Ensures a switch- or checkbox-like control is checked. */
  async check(options?: WaitOptions): Promise<void> {
    await this.device.setChecked(this, true, options);
  }

  /** Ensures a switch- or checkbox-like control is unchecked. */
  async uncheck(options?: WaitOptions): Promise<void> {
    await this.device.setChecked(this, false, options);
  }

  async resolve(): Promise<AccessibilityNode> {
    return this.device.inspect(this);
  }

  async count(): Promise<number> {
    return this.device.count(this);
  }

  async waitForVisible(options?: WaitOptions): Promise<AccessibilityNode> {
    return this.waitFor((node) => node.visible, options);
  }

  async waitFor(
    predicate: (node: AccessibilityNode) => boolean,
    options: WaitOptions = {}
  ): Promise<AccessibilityNode> {
    const timeout = options.timeout ?? this.device.timeouts.assertion;
    const interval = options.interval ?? this.device.timeouts.interval;
    const deadline = this.device.clock.now() + timeout;
    let lastError: unknown;

    while (true) {
      try {
        const node = await this.resolve();
        if (predicate(node)) return node;
        lastError = new LocatorResolutionError(
          `${this.describe()} resolved to ${nodeDescription(node)}, but the expected state was not met.`
        );
      } catch (error) {
        lastError = error;
      }

      if (this.device.clock.now() >= deadline) {
        const reason = lastError instanceof Error ? lastError.message : String(lastError);
        throw new LocatorTimeoutError(`${this.describe()} did not satisfy its condition within ${timeout}ms. ${reason}`);
      }

      await this.device.clock.sleep(interval);
    }
  }

  async waitForCount(expected: number, options: WaitOptions = {}): Promise<number> {
    return this.waitForCountWhere((actual) => actual === expected, options, expected);
  }

  /** @internal Shared polling primitive for count-based matchers. */
  async waitForCountWhere(
    predicate: (actual: number) => boolean,
    options: WaitOptions = {},
    expected?: number
  ): Promise<number> {
    const timeout = options.timeout ?? this.device.timeouts.assertion;
    const interval = options.interval ?? this.device.timeouts.interval;
    const deadline = this.device.clock.now() + timeout;
    let actual = -1;

    while (true) {
      actual = await this.count();
      if (predicate(actual)) return actual;

      if (this.device.clock.now() >= deadline) {
        throw new LocatorTimeoutError(
          `${this.describe()} had ${actual} ${pluralize("match", actual)}${expected === undefined ? "" : ` instead of ${expected}`} within ${timeout}ms.`
        );
      }

      await this.device.clock.sleep(interval);
    }
  }

  /** @internal Resolves this deferred query against one fresh tree. */
  resolveFrom(tree: AccessibilityTree): AccessibilityNode {
    const matches = this.matchesFrom(tree);
    if (matches.length !== 1) {
      throw new LocatorResolutionError(buildStrictnessMessage(this.describe(), matches, tree.root));
    }
    const result = matches[0];
    if (!result) throw new LocatorResolutionError(`${this.describe()} found no element.`);
    return result;
  }

  /** @internal Returns every final match while keeping intermediate scopes strict. */
  matchesFrom(tree: AccessibilityTree): AccessibilityNode[] {
    let roots = [tree.root];

    for (const [segmentIndex, segment] of this.segments.entries()) {
      const matches = roots
        .flatMap((root) => descendants(root))
        .filter((node) => matchesQuery(node, segment.query));

      if (segment.index !== undefined) {
        const selected = matches[segment.index];
        if (!selected) {
          throw new LocatorResolutionError(
            `${this.describe()} requested ${ordinal(segment.index)} match, but only ${matches.length} ${pluralize("match", matches.length)} found.`
          );
        }
        roots = [selected];
        continue;
      }

      if (segmentIndex < this.segments.length - 1 && matches.length !== 1) {
        throw new LocatorResolutionError(buildStrictnessMessage(this.describe(), matches, tree.root));
      }
      roots = matches;
    }

    return roots;
  }

  describe(): string {
    return this.segments
      .map(({ query, index }) => `${queryDescription(query)}${index === undefined ? "" : `.${ordinal(index)}`}`)
      .join(".findBy");
  }

  private append(query: LocatorQuery): Locator {
    return new Locator(this.device, [...this.segments, { query }]);
  }
}

const matchesQuery = (node: AccessibilityNode, query: LocatorQuery): boolean => {
  switch (query.kind) {
    case "testId":
      return node.id === query.value;
    case "text":
      return node.label === query.value || node.value === query.value;
    case "label":
      return node.label === query.value;
    case "role":
      return node.role === query.role && (query.name === undefined || node.label === query.name);
  }
};

const queryDescription = (query: LocatorQuery): string => {
  switch (query.kind) {
    case "testId":
      return `findByTestId(${JSON.stringify(query.value)})`;
    case "text":
      return `findByText(${JSON.stringify(query.value)})`;
    case "label":
      return `findByLabel(${JSON.stringify(query.value)})`;
    case "role":
      return `findByRole(${JSON.stringify(query.role)}${query.name ? `, { name: ${JSON.stringify(query.name)} }` : ""})`;
  }
};

const buildStrictnessMessage = (
  locator: string,
  matches: AccessibilityNode[],
  root: AccessibilityNode
): string => {
  if (matches.length === 0) return `${locator} found no matching accessible elements.`;

  const candidates = matches
    .map((node, index) => {
      const path = accessibilityPath(root, node);
      return `  ${index + 1}. ${path ?? nodeDescription(node)}`;
    })
    .join("\n");
  return `${locator} expected one matching accessible element, found ${matches.length}:\n${candidates}\nRefine the query, scope it with findBy…, or select deliberately with first(), second(), or nth().`;
};

const ordinal = (index: number): string => {
  const number = index + 1;
  const suffix = number % 100 >= 11 && number % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][number % 10] ?? "th";
  return `${number}${suffix}`;
};

const pluralize = (word: string, count: number): string => (count === 1 ? word : `${word}es`);
