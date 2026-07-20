import type { Device } from "./device.js";
import { poll } from "./poll.js";
import { accessibilityPath, descendants, nodeDescription } from "./tree.js";
import type {
  AccessibilityNode,
  AccessibilityTree,
  FillOptions,
  WaitOptions,
} from "./types.js";

export type LocatorQuery =
  | { kind: "testId"; value: string }
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "label"; value: string; exact?: boolean }
  | { kind: "role"; role: string; name?: string };

export interface TextQueryOptions {
  /**
   * `exact: false` switches to normalized substring matching: case-insensitive,
   * with no-break spaces (U+00A0) treated as ordinary spaces. React Native
   * joins composite labels with no-break spaces, so an exact query typed with
   * a regular space can silently never match rendered text.
   */
  exact?: boolean;
}

/** @deprecated Use {@link TapOptions}. Removed in 1.0. */
export type ClickOptions = TapOptions;

export interface TapOptions extends WaitOptions {
  /**
   * Arrival condition: a locator that must be present for the tap to count
   * as done. The tap is retried until it is. This absorbs the ways a
   * "successful" tap can do nothing — a control rendered before its touch
   * handler attached, a first-run tooltip eating the tap, an overlay above
   * the target — without blind sleeps.
   */
  until?: Locator;
  /** Maximum taps when `until` is set (default 3). */
  attempts?: number;
  /** How long to poll for `until` after each tap before retapping (default: the action timeout). */
  settleTimeout?: number;
}

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
    private readonly segments: readonly LocatorSegment[],
  ) {}

  static from(device: Device, query: LocatorQuery): Locator {
    return new Locator(device, [{ query }]);
  }

  findByTestId(value: string): Locator {
    return this.append({ kind: "testId", value });
  }

  findByText(value: string, options: TextQueryOptions = {}): Locator {
    return this.append(textQuery("text", value, options));
  }

  findByLabel(value: string, options: TextQueryOptions = {}): Locator {
    return this.append(textQuery("label", value, options));
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
      { ...last, index },
    ]);
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.device.tap(this, options);
  }

  /** @deprecated Use {@link tap} — iOS has taps, not clicks. Removed in 1.0. */
  async click(options?: TapOptions): Promise<void> {
    await this.tap(options);
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

  /**
   * Non-strict presence: is anything matching on screen at all? Unlike
   * resolve(), ambiguity anywhere in the chain is not an error — this answers
   * the screen-detection question ("which screen am I on?"), not the
   * interaction question ("which one element do I mean?").
   */
  async isPresent(): Promise<boolean> {
    return (await this.device.presenceCount(this)) > 0;
  }

  /**
   * Every matching node from one fresh snapshot, presence semantics. This is
   * the non-strict READ — when the matched content itself is the answer (for
   * example parsing a rendered row label that is the only reliable ground
   * truth for what the app actually shows).
   */
  async presentNodes(): Promise<AccessibilityNode[]> {
    return this.device.presentNodes(this);
  }

  async waitForVisible(options?: WaitOptions): Promise<AccessibilityNode> {
    return this.waitFor((node) => node.visible, options);
  }

  /** Waits until something matching is on screen (presence semantics). */
  async waitForPresent(options: WaitOptions = {}): Promise<void> {
    const timeout = options.timeout ?? this.device.timeouts.assertion;
    const interval = options.interval ?? this.device.timeouts.interval;

    await poll(async () => (await this.device.presenceCount(this)) > 0, {
      timeout,
      interval,
      clock: this.device.clock,
      onTimeout: () =>
        new LocatorTimeoutError(
          `${this.describe()} never appeared within ${timeout}ms.`,
        ),
    });
  }

  /** Waits until nothing matching remains on screen (presence semantics). */
  async waitForGone(options: WaitOptions = {}): Promise<void> {
    const timeout = options.timeout ?? this.device.timeouts.assertion;
    const interval = options.interval ?? this.device.timeouts.interval;
    let lastCount = -1;

    await poll(
      async () => (lastCount = await this.device.presenceCount(this)) === 0,
      {
        timeout,
        interval,
        clock: this.device.clock,
        onTimeout: () =>
          new LocatorTimeoutError(
            `${this.describe()} still had ${lastCount} ${pluralize("match", lastCount)} after ${timeout}ms.`,
          ),
      },
    );
  }

  async waitFor(
    predicate: (node: AccessibilityNode) => boolean,
    options: WaitOptions = {},
  ): Promise<AccessibilityNode> {
    const timeout = options.timeout ?? this.device.timeouts.assertion;
    const interval = options.interval ?? this.device.timeouts.interval;
    let result: AccessibilityNode | undefined;
    let lastError: unknown;

    await poll(
      async () => {
        try {
          const node = await this.resolve();
          if (predicate(node)) {
            result = node;
            return true;
          }
          lastError = new LocatorResolutionError(
            `${this.describe()} resolved to ${nodeDescription(node)}, but the expected state was not met.`,
          );
        } catch (error) {
          lastError = error;
        }
        return false;
      },
      {
        timeout,
        interval,
        clock: this.device.clock,
        onTimeout: () => {
          const reason =
            lastError instanceof Error ? lastError.message : String(lastError);
          return new LocatorTimeoutError(
            `${this.describe()} did not satisfy its condition within ${timeout}ms. ${reason}`,
          );
        },
      },
    );

    if (!result) {
      throw new LocatorResolutionError(
        `${this.describe()} produced no node after a satisfied wait.`,
      );
    }
    return result;
  }

  async waitForCount(
    expected: number,
    options: WaitOptions = {},
  ): Promise<number> {
    return this.waitForCountWhere(
      (actual) => actual === expected,
      options,
      expected,
    );
  }

  /** @internal Shared polling primitive for count-based matchers. */
  async waitForCountWhere(
    predicate: (actual: number) => boolean,
    options: WaitOptions = {},
    expected?: number,
  ): Promise<number> {
    const timeout = options.timeout ?? this.device.timeouts.assertion;
    const interval = options.interval ?? this.device.timeouts.interval;
    let actual = -1;

    await poll(
      async () => {
        actual = await this.count();
        return predicate(actual);
      },
      {
        timeout,
        interval,
        clock: this.device.clock,
        onTimeout: () =>
          new LocatorTimeoutError(
            `${this.describe()} had ${actual} ${pluralize("match", actual)}${expected === undefined ? "" : ` instead of ${expected}`} within ${timeout}ms.`,
          ),
      },
    );

    return actual;
  }

  /** @internal Resolves this deferred query against one fresh tree. */
  resolveFrom(tree: AccessibilityTree): AccessibilityNode {
    const matches = this.matchesIn(tree, { strict: true });
    if (matches.length !== 1) {
      throw new LocatorResolutionError(
        buildStrictnessMessage(this.describe(), matches, tree.root),
      );
    }
    const result = matches[0];
    if (!result)
      throw new LocatorResolutionError(`${this.describe()} found no element.`);
    return result;
  }

  /**
   * Every matching node from a caller-held snapshot. This is THE snapshot
   * matching API: one `uiSnapshot()` can answer many queries — mapping a
   * screenful of controls to their frames costs one tree fetch instead of one
   * per control, which matters when each fetch is a full `describe-ui` round
   * trip.
   *
   * Default is presence semantics: every segment keeps ALL of its matches, an
   * empty segment short-circuits to [], and nothing throws. This backs
   * isPresent()/waitForPresent()/waitForGone()/firstPresent(), never
   * interactions. With `strict: true` it matches interaction-grade
   * resolution instead: intermediate scopes must be unambiguous and an
   * out-of-range nth() is an error, exactly as resolve() sees the tree.
   */
  matchesIn(
    tree: AccessibilityTree,
    options: { strict?: boolean } = {},
  ): AccessibilityNode[] {
    return options.strict ? this.strictMatches(tree) : this.presentMatches(tree);
  }

  /** @deprecated Use {@link matchesIn} with `{ strict: true }`. Removed in 1.0. */
  matchesFrom(tree: AccessibilityTree): AccessibilityNode[] {
    return this.matchesIn(tree, { strict: true });
  }

  private strictMatches(tree: AccessibilityTree): AccessibilityNode[] {
    let roots = [tree.root];

    for (const [segmentIndex, segment] of this.segments.entries()) {
      const matches = roots
        .flatMap((root) => descendants(root))
        .filter((node) => matchesQuery(node, segment.query));

      if (segment.index !== undefined) {
        const selected = matches[segment.index];
        if (!selected) {
          throw new LocatorResolutionError(
            `${this.describe()} requested ${ordinal(segment.index)} match, but only ${matches.length} ${pluralize("match", matches.length)} found.`,
          );
        }
        roots = [selected];
        continue;
      }

      if (segmentIndex < this.segments.length - 1 && matches.length !== 1) {
        throw new LocatorResolutionError(
          buildStrictnessMessage(this.describe(), matches, tree.root),
        );
      }
      roots = matches;
    }

    return roots;
  }

  private presentMatches(tree: AccessibilityTree): AccessibilityNode[] {
    let roots = [tree.root];

    for (const segment of this.segments) {
      const matches = dedupe(
        roots
          .flatMap((root) => descendants(root))
          .filter((node) => matchesQuery(node, segment.query)),
      );

      if (segment.index !== undefined) {
        const selected = matches[segment.index];
        roots = selected ? [selected] : [];
      } else {
        roots = matches;
      }

      if (roots.length === 0) return [];
    }

    return roots;
  }

  describe(): string {
    return this.segments
      .map(
        ({ query, index }) =>
          `${queryDescription(query)}${index === undefined ? "" : `.${ordinal(index)}`}`,
      )
      .join(".findBy");
  }

  private append(query: LocatorQuery): Locator {
    return new Locator(this.device, [...this.segments, { query }]);
  }
}

const textQuery = (
  kind: "text" | "label",
  value: string,
  options: TextQueryOptions,
): LocatorQuery =>
  options.exact === false ? { kind, value, exact: false } : { kind, value };

/**
 * Normalization for `exact: false` queries: case-insensitive, with no-break
 * spaces treated as ordinary spaces (React Native joins composite labels with
 * U+00A0, which is indistinguishable from a space in any error message).
 */
const normalizeForContains = (value: string): string =>
  value.replaceAll("\u00a0", " ").toLowerCase();

const containsNormalized = (
  haystack: string | undefined,
  needle: string,
): boolean =>
  haystack !== undefined &&
  normalizeForContains(haystack).includes(normalizeForContains(needle));

const matchesQuery = (
  node: AccessibilityNode,
  query: LocatorQuery,
): boolean => {
  switch (query.kind) {
    case "testId":
      return node.id === query.value;
    case "text":
      if (query.exact === false) {
        return (
          containsNormalized(node.label, query.value) ||
          (node.value !== undefined &&
            containsNormalized(String(node.value), query.value))
        );
      }
      return node.label === query.value || node.value === query.value;
    case "label":
      if (query.exact === false)
        return containsNormalized(node.label, query.value);
      return node.label === query.value;
    case "role":
      return (
        node.role === query.role &&
        (query.name === undefined || node.label === query.name)
      );
  }
};

const dedupe = (nodes: AccessibilityNode[]): AccessibilityNode[] => [
  ...new Set(nodes),
];

const queryDescription = (query: LocatorQuery): string => {
  switch (query.kind) {
    case "testId":
      return `findByTestId(${JSON.stringify(query.value)})`;
    case "text":
      return `findByText(${JSON.stringify(query.value)}${query.exact === false ? ", { exact: false }" : ""})`;
    case "label":
      return `findByLabel(${JSON.stringify(query.value)}${query.exact === false ? ", { exact: false }" : ""})`;
    case "role":
      return `findByRole(${JSON.stringify(query.role)}${query.name ? `, { name: ${JSON.stringify(query.name)} }` : ""})`;
  }
};

const buildStrictnessMessage = (
  locator: string,
  matches: AccessibilityNode[],
  root: AccessibilityNode,
): string => {
  if (matches.length === 0)
    return `${locator} found no matching accessible elements.`;

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
  const suffix =
    number % 100 >= 11 && number % 100 <= 13
      ? "th"
      : (["th", "st", "nd", "rd"][number % 10] ?? "th");
  return `${number}${suffix}`;
};

const pluralize = (word: string, count: number): string =>
  count === 1 ? word : `${word}es`;
