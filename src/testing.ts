import type { AxeDriver, AxeTapTarget } from "./types.js";

export interface AxeFixtureMetadata {
  /** `synthetic` fixtures are hand-authored; `captured` trees come from AXe. */
  source: "synthetic" | "captured";
  axeVersion?: string;
  xcodeVersion?: string;
  runtime?: string;
  device?: string;
  orientation?: string;
}

/**
 * A versioned envelope around an otherwise untouched AXe `describe-ui` value.
 * The `tree` member must remain raw so fixtures keep exercising the normalizer.
 */
export interface AxeFixture {
  formatVersion: 1;
  metadata: AxeFixtureMetadata;
  tree: unknown;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fixtureKeys = new Set(["formatVersion", "metadata", "tree"]);
const metadataKeys = new Set([
  "source",
  "axeVersion",
  "xcodeVersion",
  "runtime",
  "device",
  "orientation"
]);

/**
 * Validates the committed fixture-v1 contract at runtime. The JSON Schema is
 * documentation for tooling; this keeps malformed fixture input out of tests.
 */
export function fixtureTree(fixture: unknown): unknown {
  if (!isRecord(fixture) || hasUnexpectedKeys(fixture, fixtureKeys)) {
    throw new TypeError("Expected an AXe fixture envelope with only formatVersion, metadata, and tree.");
  }
  if (fixture.formatVersion !== 1) {
    throw new TypeError("Expected an AXe fixture envelope at format version 1.");
  }
  if (!isFixtureMetadata(fixture.metadata)) {
    throw new TypeError("Expected AXe fixture metadata with source 'synthetic' or 'captured'.");
  }
  if (!isRecord(fixture.tree) && !Array.isArray(fixture.tree)) {
    throw new TypeError("Expected an AXe fixture tree object or array.");
  }
  return fixture.tree;
}

const hasUnexpectedKeys = (record: JsonRecord, allowed: ReadonlySet<string>): boolean =>
  Object.keys(record).some((key) => !allowed.has(key));

const isFixtureMetadata = (value: unknown): value is AxeFixtureMetadata => {
  if (!isRecord(value) || hasUnexpectedKeys(value, metadataKeys)) return false;
  if (value.source !== "synthetic" && value.source !== "captured") return false;

  return ["axeVersion", "xcodeVersion", "runtime", "device", "orientation"].every(
    (key) => value[key] === undefined || typeof value[key] === "string"
  );
};

export type FixtureCall =
  | { kind: "describeUi" }
  | { kind: "tap"; target: AxeTapTarget }
  | { kind: "type"; text: string }
  | { kind: "keyCombo"; modifiers: readonly number[]; key: number };

export interface FixtureTransition {
  when: (call: FixtureCall) => boolean;
  nextUi: unknown;
}

/**
 * A deterministic AXe driver for unit and integration tests. It exercises the
 * same Device and Locator APIs as a real CLI-backed driver without a simulator.
 */
export class FixtureAxeDriver implements AxeDriver {
  readonly calls: FixtureCall[] = [];
  private ui: unknown;

  constructor(
    initialUi: unknown,
    private readonly transitions: readonly FixtureTransition[] = []
  ) {
    this.ui = initialUi;
  }

  async describeUi(): Promise<unknown> {
    this.calls.push({ kind: "describeUi" });
    return this.ui;
  }

  async tap(target: AxeTapTarget): Promise<void> {
    const call: FixtureCall = { kind: "tap", target };
    this.calls.push(call);
    this.applyTransition(call);
  }

  async type(text: string): Promise<void> {
    const call: FixtureCall = { kind: "type", text };
    this.calls.push(call);
    this.applyTransition(call);
  }

  async keyCombo(modifiers: readonly number[], key: number): Promise<void> {
    const call: FixtureCall = { kind: "keyCombo", modifiers, key };
    this.calls.push(call);
    this.applyTransition(call);
  }

  private applyTransition(call: FixtureCall): void {
    const transition = this.transitions.find((candidate) => candidate.when(call));
    if (transition) this.ui = transition.nextUi;
  }
}
