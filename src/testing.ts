import type { AxeDriver, AxeTapTarget } from "./types.js";

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
