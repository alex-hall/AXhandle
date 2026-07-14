import { test as baseTest } from "vitest";
import { Locator } from "./locator.js";
import { checkedState } from "./state.js";
import type { Device } from "./device.js";
import { captureDeviceEvidence } from "./evidence.js";
import type { ArtifactSink, CaptureDeviceEvidenceOptions } from "./evidence.js";
import type { WaitOptions } from "./types.js";
import type {} from "@vitest/expect";

type MatcherContext = { isNot?: boolean };

const requireLocator = (received: unknown): Locator => {
  if (received instanceof Locator) return received;
  throw new TypeError("AXe Vitest matchers expect a Locator.");
};

const matcher = (
  name: "visible" | "enabled" | "disabled" | "hidden" | "checked" | "unchecked",
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
  toBeDisabled: matcher("disabled", () => (node) => node.enabled === false),
  toBeHidden: matcher("hidden", () => (node) => !node.visible),
  toBeChecked: matcher("checked", () => (node) => checkedState(node) === true),
  toBeUnchecked: matcher("unchecked", () => (node) => checkedState(node) === false),
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
export type AxeDeviceSet = Record<string, Device>;
type DeviceSet = AxeDeviceSet;

export interface AxeTestLifecycle<TDevices extends DeviceSet> {
  devices: TDevices;
}

/**
 * Consumer-owned device allocation. Each `allocate()` call must return a fresh
 * lease for one Vitest invocation; the harness releases it after reset.
 */
export interface AxeDeviceProvider<TDevices extends DeviceSet> {
  allocate(): MaybePromise<TDevices>;
  release?(devices: TDevices): MaybePromise<void>;
}

interface AxeTestLifecycleOptions<TDevices extends DeviceSet> {
  beforeTest?(context: AxeTestLifecycle<TDevices>): MaybePromise<void>;
  /** Always runs after the test body, including after a failed assertion. */
  reset?(context: AxeTestLifecycle<TDevices>): MaybePromise<void>;
  evidence?: VitestEvidenceOptions;
}

export type CreateAxeTestOptions<TDevices extends DeviceSet> =
  | (AxeTestLifecycleOptions<TDevices> & {
      /** Allocates the devices for one Vitest test invocation. */
      createDevices(): MaybePromise<TDevices>;
      deviceProvider?: never;
    })
  | (AxeTestLifecycleOptions<TDevices> & {
      /** A consumer-owned provider for named device leases. */
      deviceProvider: AxeDeviceProvider<TDevices>;
      createDevices?: never;
    });

export interface VitestEvidenceOptions extends CaptureDeviceEvidenceOptions {
  sink: ArtifactSink;
  /** Defaults to failure, keeping ordinary successful test runs quiet. */
  capture?: "failure" | "always";
}

export type AxeCleanupPhase = "evidence" | "reset" | "release";

export interface AxeCleanupFailure {
  phase: AxeCleanupPhase;
  error: unknown;
}

const cleanupFailuresKey = Symbol("axhandle.cleanup-failures");

/** Returns cleanup failures attached to the primary lifecycle error, if any. */
export const getAxeCleanupFailures = (error: unknown): readonly AxeCleanupFailure[] => {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return [];
  }
  const failures = (error as { [cleanupFailuresKey]?: unknown })[cleanupFailuresKey];
  return Array.isArray(failures) ? failures : [];
};

const attachCleanupFailures = (
  error: unknown,
  failures: readonly AxeCleanupFailure[]
): void => {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
  Object.defineProperty(error, cleanupFailuresKey, {
    configurable: true,
    value: failures.slice()
  });
};

/**
 * Runs the lifecycle that backs the Vitest fixture. Exported for custom
 * integrations and direct failure-path tests; normal suites use createAxeTest.
 */
export async function runAxeTestLifecycle<TDevices extends DeviceSet, TResult>(
  options: CreateAxeTestOptions<TDevices>,
  body: (devices: TDevices) => MaybePromise<TResult>
): Promise<TResult> {
  const provider = "deviceProvider" in options ? options.deviceProvider : undefined;
  const createDevices = provider ? () => provider.allocate() : options.createDevices;
  if (!createDevices) {
    throw new TypeError("createAxeTest requires either createDevices or deviceProvider.");
  }

  const devices = await createDevices();
  const context = { devices };
  const cleanupFailures: AxeCleanupFailure[] = [];
  let hasPrimaryError = false;
  let primaryError: unknown;
  let result: TResult;

  const runCleanup = async (phase: AxeCleanupPhase, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push({ phase, error });
    }
  };

  try {
    await options.beforeTest?.(context);
    result = await body(devices);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    throw error;
  } finally {
    const evidenceOptions = options.evidence;
    const shouldCapture =
      evidenceOptions && (evidenceOptions.capture === "always" || hasPrimaryError);

    if (shouldCapture) {
      await runCleanup("evidence", async () => {
        for (const device of Object.values(devices)) {
          await captureDeviceEvidence(device, evidenceOptions.sink, evidenceOptions);
        }
      });
    }

    await runCleanup("reset", async () => options.reset?.(context));
    await runCleanup("release", async () => provider?.release?.(devices));

    if (hasPrimaryError) {
      if (cleanupFailures.length > 0) attachCleanupFailures(primaryError, cleanupFailures);
    } else if (cleanupFailures.length > 0) {
      const [firstFailure] = cleanupFailures;
      if (firstFailure) {
        attachCleanupFailures(firstFailure.error, cleanupFailures);
        throw firstFailure.error;
      }
    }
  }

  return result!;
}

/**
 * Returns a regular Vitest test function extended with a typed `devices`
 * fixture. The caller still owns simulator allocation and application reset.
 */
export function createAxeTest<TDevices extends DeviceSet>(
  options: CreateAxeTestOptions<TDevices>
) {
  return baseTest.extend<{ devices: TDevices }>({
    devices: async ({}, use) => runAxeTestLifecycle(options, use)
  });
}

declare module "@vitest/expect" {
  interface Assertion<T = any> {
    toBeVisible(options?: WaitOptions): Promise<void>;
    toBeEnabled(options?: WaitOptions): Promise<void>;
    toBeDisabled(options?: WaitOptions): Promise<void>;
    toBeHidden(options?: WaitOptions): Promise<void>;
    toBeChecked(options?: WaitOptions): Promise<void>;
    toBeUnchecked(options?: WaitOptions): Promise<void>;
    toHaveText(expected: string, options?: WaitOptions): Promise<void>;
    toHaveValue(
      expected: string | number | boolean,
      options?: WaitOptions
    ): Promise<void>;
    toHaveCount(expected: number, options?: WaitOptions): Promise<void>;
  }
}
