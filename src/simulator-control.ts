import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface SimulatorCommandResult {
  stdout: string;
  stderr: string;
}

export interface SimulatorCommandRunnerOptions {
  environment?: Readonly<Record<string, string>>;
  /** Piped to the command's stdin (`simctl pbcopy` reads its payload there). */
  input?: string;
}

export interface SimulatorCommandRunner {
  run(
    args: readonly string[],
    options?: SimulatorCommandRunnerOptions
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
    options: SimulatorCommandRunnerOptions = {}
  ): Promise<SimulatorCommandResult> {
    try {
      const execOptions = {
        encoding: "utf8",
        env: { ...process.env, ...options.environment },
        maxBuffer: 10 * 1024 * 1024
      } as const;

      if (options.input === undefined) {
        const result = await this.execute("xcrun", ["simctl", ...args], execOptions);
        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      }

      // promisify(execFile) hides the child, so stdin needs the callback form.
      const input = options.input;
      return await new Promise<SimulatorCommandResult>((resolve, reject) => {
        const child = execFile(
          "xcrun",
          ["simctl", ...args],
          execOptions,
          (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { stderr }));
            else resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
        child.stdin?.end(input);
      });
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
  uninstall(udid: string, bundleId: string): Promise<void>;
  launch(options: LaunchSimulatorAppOptions): Promise<{ pid?: number }>;
  terminate(udid: string, bundleId: string): Promise<void>;
  erase(udid: string): Promise<void>;
  appContainerPath(
    udid: string,
    bundleId: string,
    container?: "app" | "data" | "groups"
  ): Promise<string | undefined>;
  isAppInstalled(udid: string, bundleId: string): Promise<boolean>;
  resetKeychain(udid: string): Promise<void>;
  setPasteboard(udid: string, text: string): Promise<void>;
  getPasteboard(udid: string): Promise<string>;
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

  async uninstall(udid: string, bundleId: string): Promise<void> {
    await this.runner.run(["uninstall", udid, bundleId]);
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

  /** The installed .app bundle's path, or undefined when not installed. */
  async appContainerPath(
    udid: string,
    bundleId: string,
    container: "app" | "data" | "groups" = "app"
  ): Promise<string | undefined> {
    try {
      const { stdout } = await this.runner.run(["get_app_container", udid, bundleId, container]);
      const containerPath = stdout.trim();
      return containerPath.length > 0 ? containerPath : undefined;
    } catch (error) {
      if (error instanceof SimulatorCommandError) return undefined;
      throw error;
    }
  }

  async isAppInstalled(udid: string, bundleId: string): Promise<boolean> {
    return (await this.appContainerPath(udid, bundleId)) !== undefined;
  }

  /**
   * The simulator keychain SURVIVES app uninstall — leftover identities are
   * the classic source of non-deterministic first-run state (an app that
   * boots signed-in, or offers "sign in" where a fresh install offers
   * "sign up"). Reset it whenever a test needs a genuinely pristine install.
   */
  async resetKeychain(udid: string): Promise<void> {
    await this.runner.run(["keychain", udid, "reset"]);
  }

  /**
   * Put a string on the simulator's general pasteboard. NOTE: the pasteboard
   * SURVIVES app uninstall/reinstall — apps that inspect the clipboard on
   * first focus (deferred-deeplink detection is the classic) will act on
   * whatever a previous test left there. Suites that provision fresh installs
   * should neutralize the pasteboard deliberately.
   */
  async setPasteboard(udid: string, text: string): Promise<void> {
    await this.runner.run(["pbcopy", udid], { input: text });
  }

  async getPasteboard(udid: string): Promise<string> {
    const { stdout } = await this.runner.run(["pbpaste", udid]);
    return stdout;
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

/**
 * Face ID / Touch ID simulation over the simulator's Darwin notification
 * bridge (`xcrun simctl spawn <udid> notifyutil`). simctl exposes no biometric
 * subcommand, but BiometricKit inside the simulator listens for these
 * notifications — the same mechanism behind Simulator.app's
 * Features > Face ID menu.
 *
 * Two caveats callers must own:
 * - The biometric prompt is SYSTEM UI, outside the app's accessibility tree:
 *   `describe-ui` cannot observe it, so there is no pollable "prompt is
 *   ready" condition. Sequence matches against an app-level observable (or a
 *   documented settle delay) and verify the outcome in the app afterwards.
 * - enroll() must run before any match — and apps that gate on biometrics
 *   may behave badly when launched unenrolled.
 */
export class NotifyutilBiometricController implements BiometricController {
  constructor(
    private readonly runner: SimulatorCommandRunner = new NodeSimulatorCommandRunner()
  ) {}

  /** Enroll a simulated face/fingerprint. Idempotent; required before any match. */
  async enroll(udid: string): Promise<void> {
    await this.setEnrollment(udid, true);
  }

  async unenroll(udid: string): Promise<void> {
    await this.setEnrollment(udid, false);
  }

  /** Approve the currently-presented biometric prompt. */
  async match(udid: string): Promise<void> {
    await this.notifyutil(udid, "-p", "com.apple.BiometricKit_Sim.pearl.match");
  }

  /** Reject the currently-presented biometric prompt (non-matching face). */
  async nonMatch(udid: string): Promise<void> {
    await this.notifyutil(udid, "-p", "com.apple.BiometricKit_Sim.pearl.nomatch");
  }

  private async setEnrollment(udid: string, enrolled: boolean): Promise<void> {
    await this.notifyutil(udid, "-s", "com.apple.BiometricKit.enrollmentChanged", enrolled ? "1" : "0");
    await this.notifyutil(udid, "-p", "com.apple.BiometricKit.enrollmentChanged");
  }

  private notifyutil(udid: string, ...args: string[]): Promise<SimulatorCommandResult> {
    return this.runner.run(["spawn", udid, "notifyutil", ...args]);
  }
}

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
