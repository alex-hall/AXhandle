import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface SimulatorCommandResult {
  stdout: string;
  stderr: string;
}

export interface SimulatorCommandRunner {
  run(
    args: readonly string[],
    options?: { environment?: Readonly<Record<string, string>> }
  ): Promise<SimulatorCommandResult>;
}

export class SimulatorCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    cause?: unknown
  ) {
    super(`Simulator command failed: xcrun simctl ${args.join(" ")}\n${stderr}`.trim(), { cause });
    this.name = "SimulatorCommandError";
  }
}

/** Shell-free runner for the Xcode-provided simulator controller. */
export class NodeSimulatorCommandRunner implements SimulatorCommandRunner {
  private readonly execute = promisify(execFile);

  async run(
    args: readonly string[],
    options: { environment?: Readonly<Record<string, string>> } = {}
  ): Promise<SimulatorCommandResult> {
    try {
      const result = await this.execute("xcrun", ["simctl", ...args], {
        encoding: "utf8",
        env: { ...process.env, ...options.environment },
        maxBuffer: 10 * 1024 * 1024
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const failure = error as { stderr?: string | Buffer };
      throw new SimulatorCommandError(args, String(failure.stderr ?? ""), error);
    }
  }
}

export interface LaunchSimulatorAppOptions {
  udid: string;
  bundleId: string;
  arguments?: readonly string[];
  /** Environment values are passed through Xcode's `SIMCTL_CHILD_` mechanism. */
  environment?: Readonly<Record<string, string>>;
  terminateRunning?: boolean;
}

export interface SimulatorController {
  install(udid: string, appPath: string): Promise<void>;
  launch(options: LaunchSimulatorAppOptions): Promise<{ pid?: number }>;
  terminate(udid: string, bundleId: string): Promise<void>;
  erase(udid: string): Promise<void>;
  grantPermission(udid: string, service: string, bundleId: string): Promise<void>;
  revokePermission(udid: string, service: string, bundleId: string): Promise<void>;
  resetPermissions(udid: string, service?: string, bundleId?: string): Promise<void>;
}

/** Optional Xcode integration; core Device and AXe driver never call it. */
export class XcrunSimulatorController implements SimulatorController {
  private readonly runner: SimulatorCommandRunner;

  constructor(runner: SimulatorCommandRunner = new NodeSimulatorCommandRunner()) {
    this.runner = runner;
  }

  async install(udid: string, appPath: string): Promise<void> {
    await this.runner.run(["install", udid, appPath]);
  }

  async launch(options: LaunchSimulatorAppOptions): Promise<{ pid?: number }> {
    const args = ["launch"];
    if (options.terminateRunning) args.push("--terminate-running-process");
    args.push(options.udid, options.bundleId, ...(options.arguments ?? []));
    const { stdout } = await this.runner.run(args, {
      environment: childEnvironment(options.environment)
    });
    return { pid: parseLaunchPid(stdout) };
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    await this.runner.run(["terminate", udid, bundleId]);
  }

  async erase(udid: string): Promise<void> {
    await this.runner.run(["erase", udid]);
  }

  async grantPermission(udid: string, service: string, bundleId: string): Promise<void> {
    await this.runner.run(["privacy", udid, "grant", service, bundleId]);
  }

  async revokePermission(udid: string, service: string, bundleId: string): Promise<void> {
    await this.runner.run(["privacy", udid, "revoke", service, bundleId]);
  }

  async resetPermissions(udid: string, service = "all", bundleId?: string): Promise<void> {
    await this.runner.run([
      "privacy",
      udid,
      "reset",
      service,
      ...(bundleId === undefined ? [] : [bundleId])
    ]);
  }
}

export interface BiometricController {
  enroll(udid: string): Promise<void>;
  unenroll(udid: string): Promise<void>;
  match(udid: string): Promise<void>;
  nonMatch(udid: string): Promise<void>;
}

/**
 * Xcode 26.6's simctl has no biometric subcommand. Consumers must inject a
 * verified platform-specific implementation rather than receiving a no-op.
 */
export class UnsupportedBiometricController implements BiometricController {
  async enroll(_udid: string): Promise<void> {
    throw unsupportedBiometricError();
  }

  async unenroll(_udid: string): Promise<void> {
    throw unsupportedBiometricError();
  }

  async match(_udid: string): Promise<void> {
    throw unsupportedBiometricError();
  }

  async nonMatch(_udid: string): Promise<void> {
    throw unsupportedBiometricError();
  }
}

const unsupportedBiometricError = (): Error =>
  new Error(
    "Biometric simulation is not available through the configured simulator controller. Inject a verified BiometricController implementation."
  );

const childEnvironment = (
  environment: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined =>
  environment &&
  Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value])
  );

const parseLaunchPid = (stdout: string): number | undefined => {
  const match = stdout.match(/:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : undefined;
};
