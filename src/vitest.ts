import { test as baseTest } from "vitest";
import { Locator } from "./locator.js";
import type { Device } from "./device.js";
import type { WaitOptions } from "./types.js";
import type {} from "@vitest/expect";

type MatcherContext = { isNot?: boolean };

const requireLocator = (received: unknown): Locator => {
  if (received instanceof Locator) return received;
  throw new TypeError("AXe Vitest matchers expect a Locator.");
};

const matcher = (
  name: "visible" | "enabled" | "hidden",
  predicate: (locator: Locator) => (node: Awaited<ReturnType<Locator["resolve"]>>) => boolean
) =>
  async function (this: MatcherContext, received: unknown, options?: WaitOptions) {
    const locator = requireLocator(received);
    const expected = !this.isNot;

    try {
      await locator.waitFor((node) => predicate(locator)(node) === expected, options);
      return {
        pass: expected,
        message: () => `Expected ${locator.describe()} ${expected ? "not " : ""}to be ${name}.`
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        pass: !expected,
        message: () => `Expected ${locator.describe()} ${expected ? "to be" : "not to be"} ${name}. ${reason}`
      };
    }
  };

const equalityMatcher = <T>(
  name: string,
  observed: (node: Awaited<ReturnType<Locator["resolve"]>>) => T | undefined
) =>
  async function (
    this: MatcherContext,
    received: unknown,
    expectedValue: T,
    options?: WaitOptions
  ) {
    const locator = requireLocator(received);
    const expected = !this.isNot;

    try {
      await locator.waitFor(
        (node) => (Object.is(observed(node), expectedValue)) === expected,
        options
      );
      return {
        pass: expected,
        message: () =>
          `Expected ${locator.describe()} ${expected ? "not " : ""}to have ${name} ${JSON.stringify(expectedValue)}.`
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        pass: !expected,
        message: () =>
          `Expected ${locator.describe()} ${expected ? "to have" : "not to have"} ${name} ${JSON.stringify(expectedValue)}. ${reason}`
      };
    }
  };

export const axeMatchers = {
  toBeVisible: matcher("visible", () => (node) => node.visible),
  toBeEnabled: matcher("enabled", () => (node) => node.enabled === true),
  toBeHidden: matcher("hidden", () => (node) => !node.visible),
  toHaveText: equalityMatcher("text", (node) => node.label ?? String(node.value ?? "")),
  toHaveValue: equalityMatcher("value", (node) => node.value),
  async toHaveCount(this: MatcherContext, received: unknown, expected: number, options?: WaitOptions) {
    const locator = requireLocator(received);
    const wantsMatch = !this.isNot;

    try {
      const actual = await locator.waitForCountWhere(
        (count) => (count === expected) === wantsMatch,
        options,
        expected
      );
      return {
        pass: wantsMatch,
        message: () => `Expected ${locator.describe()} ${wantsMatch ? "not " : ""}to have count ${expected}; received ${actual}.`
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        pass: !wantsMatch,
        message: () => `Expected ${locator.describe()} ${wantsMatch ? "to have" : "not to have"} count ${expected}. ${reason}`
      };
    }
  }
};

type MaybePromise<T> = T | Promise<T>;
type DeviceSet = Record<string, Device>;

export interface AxeTestLifecycle<TDevices extends DeviceSet> {
  devices: TDevices;
}

export interface CreateAxeTestOptions<TDevices extends DeviceSet> {
  /** Allocates the devices for one Vitest test invocation. */
  createDevices(): MaybePromise<TDevices>;
  beforeTest?(context: AxeTestLifecycle<TDevices>): MaybePromise<void>;
  /** Always runs after the test body, including after a failed assertion. */
  reset?(context: AxeTestLifecycle<TDevices>): MaybePromise<void>;
}

/**
 * Returns a regular Vitest test function extended with a typed `devices`
 * fixture. The caller still owns simulator allocation and application reset.
 */
export function createAxeTest<TDevices extends DeviceSet>(
  options: CreateAxeTestOptions<TDevices>
) {
  return baseTest.extend<{ devices: TDevices }>({
    devices: async ({}, use) => {
      const devices = await options.createDevices();
      const context = { devices };

      try {
        await options.beforeTest?.(context);
        await use(devices);
      } finally {
        await options.reset?.(context);
      }
    }
  });
}

declare module "@vitest/expect" {
  interface Assertion<T = any> {
    toBeVisible(options?: WaitOptions): Promise<void>;
    toBeEnabled(options?: WaitOptions): Promise<void>;
    toBeHidden(options?: WaitOptions): Promise<void>;
    toHaveText(expected: string, options?: WaitOptions): Promise<void>;
    toHaveValue(
      expected: string | number | boolean,
      options?: WaitOptions
    ): Promise<void>;
    toHaveCount(expected: number, options?: WaitOptions): Promise<void>;
  }
}
