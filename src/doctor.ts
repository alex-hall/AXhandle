import { AxeCliDriver, NodeAxeCommandRunner } from "./axe-cli-driver.js";
import { descendants, normalizeAxeTree } from "./tree.js";
import type { AxeCommandRunner } from "./axe-cli-driver.js";
import type { AxeDriver } from "./types.js";

export type AxeDoctorCheckName = "axe" | "simulator" | "accessibility" | "screenshot";
export type AxeDoctorCheckStatus = "passed" | "failed" | "skipped";

/** Versions exercised by the public fixture and end-to-end corpus. */
export const supportedAxeVersions = ["1.7.1"] as const;

export interface AxeDoctorCheck {
  name: AxeDoctorCheckName;
  status: AxeDoctorCheckStatus;
  message: string;
}

export interface AxeDoctorOptions {
  /** The simulator to inspect; doctor never boots, launches, or resets it. */
  udid: string;
  /** Inject a runner in tests or to control the AXe binary. */
  runner?: AxeCommandRunner;
  /** Inject a driver when the accessibility transport needs custom behavior. */
  driver?: Pick<AxeDriver, "describeUi" | "screenshot">;
  /** Capture a screenshot only when the caller explicitly provides a path. */
  screenshotPath?: string;
  /** Override the package's supported AXe versions for a controlled rollout. */
  supportedVersions?: readonly string[];
}

export interface AxeDoctorResult {
  healthy: boolean;
  checks: readonly AxeDoctorCheck[];
  axeVersion?: string;
  accessibilityNodeCount?: number;
}

/**
 * Performs read-only AXe diagnostics without taking ownership of simulator or
 * app lifecycle. Failures are returned as structured checks, never thrown.
 */
export async function diagnoseAxe(options: AxeDoctorOptions): Promise<AxeDoctorResult> {
  const runner = options.runner ?? new NodeAxeCommandRunner();
  const driver = options.driver ?? new AxeCliDriver({ udid: options.udid, runner });
  const checks: AxeDoctorCheck[] = [];
  let axeVersion: string | undefined;
  let accessibilityNodeCount: number | undefined;

  try {
    const { stdout } = await runner.run(["--version"]);
    axeVersion = stdout.trim();
    if (!axeVersion) throw new Error("AXe returned no version information.");
    const supportedVersions = options.supportedVersions ?? supportedAxeVersions;
    if (!supportedVersions.includes(axeVersion)) {
      throw new Error(
        `AXe ${axeVersion} is not supported. Supported versions: ${supportedVersions.join(", ")}.`
      );
    }
    checks.push({ name: "axe", status: "passed", message: `AXe ${axeVersion} is available.` });
  } catch (error) {
    checks.push({ name: "axe", status: "failed", message: errorMessage(error) });
  }

  try {
    const { stdout } = await runner.run(["list-simulators"]);
    const simulator = parseSimulator(stdout, options.udid);
    if (!simulator) {
      throw new Error(`Simulator ${options.udid} was not reported by AXe.`);
    }
    if (simulator.state !== "Booted") {
      throw new Error(`Simulator ${options.udid} is ${simulator.state}, not Booted.`);
    }
    checks.push({ name: "simulator", status: "passed", message: simulator.line });
  } catch (error) {
    checks.push({ name: "simulator", status: "failed", message: errorMessage(error) });
  }

  try {
    const tree = normalizeAxeTree(await driver.describeUi());
    accessibilityNodeCount = descendants(tree.root).length;
    checks.push({
      name: "accessibility",
      status: "passed",
      message: `Read ${accessibilityNodeCount} accessibility ${pluralize("node", accessibilityNodeCount)}.`
    });
  } catch (error) {
    checks.push({ name: "accessibility", status: "failed", message: errorMessage(error) });
  }

  if (!options.screenshotPath) {
    checks.push({
      name: "screenshot",
      status: "skipped",
      message: "No screenshot path was requested."
    });
  } else if (!driver.screenshot) {
    checks.push({
      name: "screenshot",
      status: "failed",
      message: "The configured AXe driver does not support screenshots."
    });
  } else {
    try {
      await driver.screenshot(options.screenshotPath);
      checks.push({ name: "screenshot", status: "passed", message: `Wrote ${options.screenshotPath}.` });
    } catch (error) {
      checks.push({ name: "screenshot", status: "failed", message: errorMessage(error) });
    }
  }

  return {
    healthy: checks.every((check) => check.status !== "failed"),
    checks,
    axeVersion,
    accessibilityNodeCount
  };
}

const parseSimulator = (
  output: string,
  udid: string
): { state: string; line: string } | undefined => {
  const line = output.split(/\r?\n/).find((candidate) => candidate.includes(udid));
  if (!line) return undefined;

  const fields = line.split("|").map((field) => field.trim());
  return { state: fields[2] ?? "Unknown", line: line.trim() };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const pluralize = (word: string, count: number): string => (count === 1 ? word : `${word}s`);
