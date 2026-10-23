import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  BiometricController,
  LaunchSimulatorAppOptions,
  SimulatorController,
} from "./simulator-control.js";

/**
 * Android emulators, driven through adb. These implement the same
 * `SimulatorController` and `BiometricController` interfaces as the Xcode
 * ones, with the device's adb serial (`emulator-5554`) where those take a
 * simulator UDID and the application ID where they take a bundle ID, so a
 * suite can hold one controller per platform behind one type.
 */

export interface AdbCommandResult {
  stdout: string;
  stderr: string;
}

/** Runs adb against one device; injectable for tests. */
export interface AdbCommandRunner {
  run(serial: string, args: readonly string[]): Promise<AdbCommandResult>;
}

export class AdbCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    cause?: unknown,
  ) {
    super(`adb command failed: adb ${args.join(" ")}\n${stderr}`.trim(), {
      cause,
    });
    this.name = "AdbCommandError";
  }
}

/** The command was understood, but Android emulators have no equivalent. */
export class AndroidUnsupportedError extends Error {
  constructor(operation: string, reason: string) {
    super(`${operation} isn't available on Android: ${reason}`);
    this.name = "AndroidUnsupportedError";
  }
}

/**
 * The adb binary: `$ANDROID_HOME/platform-tools/adb` when that exists,
 * otherwise `adb` from PATH.
 */
export function defaultAdbPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  for (const sdk of [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT]) {
    if (!sdk) continue;
    const candidate = join(sdk, "platform-tools", "adb");
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

/** Shell-free runner: arguments go to adb as an argument vector. */
export class NodeAdbCommandRunner implements AdbCommandRunner {
  private readonly execute = promisify(execFile);

  constructor(private readonly adb = defaultAdbPath()) {}

  async run(
    serial: string,
    args: readonly string[],
  ): Promise<AdbCommandResult> {
    const fullArgs = ["-s", serial, ...args];
    try {
      const result = await this.execute(this.adb, fullArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const failure = error as { stderr?: string | Buffer };
      throw new AdbCommandError(fullArgs, String(failure.stderr ?? ""), error);
    }
  }
}

/**
 * Permission names the Xcode controller takes, as the Android runtime
 * permissions they correspond to. A name containing a dot is taken as an
 * Android permission as-is.
 */
const PERMISSIONS: Record<string, readonly string[]> = {
  camera: ["android.permission.CAMERA"],
  microphone: ["android.permission.RECORD_AUDIO"],
  photos: [
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
  ],
  location: [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
  ],
  "location-always": [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
  ],
  contacts: ["android.permission.READ_CONTACTS"],
  calendar: [
    "android.permission.READ_CALENDAR",
    "android.permission.WRITE_CALENDAR",
  ],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
};

export function androidPermissions(service: string): readonly string[] {
  if (service.includes(".")) return [service];
  const permissions = PERMISSIONS[service];
  if (!permissions) {
    throw new Error(
      `Unknown permission '${service}'. Use one of ${Object.keys(PERMISSIONS).join(", ")}, or an Android permission name.`,
    );
  }
  return permissions;
}

/** Quotes a value for the device's shell, which adb hands its arguments to. */
const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** Optional adb integration; core Device and drivers never call it. */
export class AdbDeviceController implements SimulatorController {
  constructor(
    private readonly runner: AdbCommandRunner = new NodeAdbCommandRunner(),
  ) {}

  async install(serial: string, apkPath: string): Promise<void> {
    await this.runner.run(serial, ["install", "-r", apkPath]);
  }

  async uninstall(serial: string, applicationId: string): Promise<void> {
    await this.runner.run(serial, ["uninstall", applicationId]);
  }

  /**
   * Starts the app's launcher activity. Android apps take no command-line
   * arguments or environment, so passing either is an error rather than
   * something silently dropped.
   */
  async launch(options: LaunchSimulatorAppOptions): Promise<{ pid?: number }> {
    if (options.arguments?.length) {
      throw new AndroidUnsupportedError(
        "Launch arguments",
        "Android apps take no command-line arguments; pass data through a deep link instead",
      );
    }
    if (options.environment && Object.keys(options.environment).length > 0) {
      throw new AndroidUnsupportedError(
        "A launch environment",
        "Android apps take no environment from their launcher",
      );
    }
    const { udid: serial, bundleId: applicationId } = options;
    if (options.terminateRunning) await this.terminate(serial, applicationId);
    const component = await this.launcherActivity(serial, applicationId);
    await this.runner.run(serial, [
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      component,
    ]);
    return { pid: await this.pid(serial, applicationId) };
  }

  async terminate(serial: string, applicationId: string): Promise<void> {
    await this.runner.run(serial, ["shell", "am", "force-stop", applicationId]);
  }

  async erase(_serial: string): Promise<void> {
    throw new AndroidUnsupportedError(
      "Erasing a running emulator",
      "restart it with `emulator -avd <name> -wipe-data`",
    );
  }

  /**
   * Always undefined: an app's container lives on the device, where the
   * host can't open it as a path. Read it with `adb shell run-as <app>`
   * (debuggable builds) instead.
   */
  async appContainerPath(
    _serial: string,
    _applicationId: string,
  ): Promise<string | undefined> {
    return undefined;
  }

  async isAppInstalled(
    serial: string,
    applicationId: string,
  ): Promise<boolean> {
    const { stdout } = await this.runner.run(serial, [
      "shell",
      "pm",
      "list",
      "packages",
      applicationId,
    ]);
    return stdout
      .split("\n")
      .some((line) => line.trim() === `package:${applicationId}`);
  }

  /**
   * Nothing to do. Unlike the iOS simulator keychain, an Android app's
   * keystore entries are deleted with the app, so a fresh install is
   * already pristine.
   */
  async resetKeychain(_serial: string): Promise<void> {}

  async openUrl(serial: string, url: string): Promise<void> {
    await this.runner.run(serial, [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      shellQuote(url),
    ]);
  }

  async setPasteboard(_serial: string, _text: string): Promise<void> {
    throw new AndroidUnsupportedError(
      "Setting the clipboard",
      "since Android 10 only the focused app and the keyboard can use it; have the app under test set it through a debug-only deep link",
    );
  }

  async getPasteboard(_serial: string): Promise<string> {
    throw new AndroidUnsupportedError(
      "Reading the clipboard",
      "since Android 10 only the focused app and the keyboard can use it",
    );
  }

  async grantPermission(
    serial: string,
    service: string,
    applicationId: string,
  ): Promise<void> {
    for (const permission of androidPermissions(service)) {
      await this.runner.run(serial, [
        "shell",
        "pm",
        "grant",
        applicationId,
        permission,
      ]);
    }
  }

  async revokePermission(
    serial: string,
    service: string,
    applicationId: string,
  ): Promise<void> {
    for (const permission of androidPermissions(service)) {
      await this.runner.run(serial, [
        "shell",
        "pm",
        "revoke",
        applicationId,
        permission,
      ]);
    }
  }

  /**
   * Back to "never asked": revoked, and cleared of the flags that record
   * an answer, so the app's next request shows the system prompt again.
   */
  async resetPermissions(
    serial: string,
    service = "all",
    applicationId?: string,
  ): Promise<void> {
    if (service === "all") {
      await this.runner.run(serial, [
        "shell",
        "pm",
        "reset-permissions",
        ...(applicationId ? ["-p", applicationId] : []),
      ]);
      return;
    }
    if (!applicationId) {
      throw new Error("Resetting one permission needs the application ID.");
    }
    for (const permission of androidPermissions(service)) {
      await this.runner.run(serial, [
        "shell",
        "pm",
        "revoke",
        applicationId,
        permission,
      ]);
      await this.runner.run(serial, [
        "shell",
        "pm",
        "clear-permission-flags",
        applicationId,
        permission,
        "user-set",
        "user-fixed",
      ]);
    }
  }

  /**
   * Makes `port` on the device reach the same port on this machine. An
   * emulator's localhost is its own, so an app that talks to a server on
   * the host (a test relay, a dev server) needs this, where a simulator
   * shares the Mac's network.
   */
  async reverse(serial: string, port: number): Promise<void> {
    await this.runner.run(serial, ["reverse", `tcp:${port}`, `tcp:${port}`]);
  }

  /** Moves the emulator's GPS to these coordinates. */
  async setLocation(
    serial: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    // The emulator console takes longitude first.
    await this.runner.run(serial, [
      "emu",
      "geo",
      "fix",
      String(longitude),
      String(latitude),
    ]);
  }

  private async launcherActivity(
    serial: string,
    applicationId: string,
  ): Promise<string> {
    const { stdout } = await this.runner.run(serial, [
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      applicationId,
    ]);
    const component = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!component.includes("/")) {
      throw new Error(
        `${applicationId} has no launcher activity on ${serial}.`,
      );
    }
    return component;
  }

  private async pid(
    serial: string,
    applicationId: string,
  ): Promise<number | undefined> {
    const { stdout } = await this.runner
      .run(serial, ["shell", "pidof", applicationId])
      .catch(() => ({ stdout: "" }));
    const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : undefined;
  }
}

export interface EmulatorBiometricControllerOptions {
  runner?: AdbCommandRunner;
  /**
   * Runs `adze biometric enroll` for `enroll()`, which has to walk the
   * Settings screens. Default: the `adze` binary on PATH.
   */
  enrollWith?: (serial: string) => Promise<void>;
}

/**
 * Fingerprint on an Android emulator, through its virtual sensor
 * (`adb emu finger touch`). Finger 1 is the one `enroll()` registers; any
 * other finger is a stranger's.
 *
 * The biometric prompt is a secure system window, outside every
 * accessibility tree, so there is nothing to poll for; `adze biometric
 * prompt` asks the window manager whether one is showing.
 */
export class EmulatorBiometricController implements BiometricController {
  private readonly runner: AdbCommandRunner;
  private readonly enrollWith: (serial: string) => Promise<void>;

  constructor(options: EmulatorBiometricControllerOptions = {}) {
    this.runner = options.runner ?? new NodeAdbCommandRunner();
    this.enrollWith =
      options.enrollWith ??
      (async (serial) => {
        await promisify(execFile)("adze", [
          "biometric",
          "enroll",
          "--serial",
          serial,
        ]);
      });
  }

  /** Sets a screen-lock PIN (1111) and enrolls finger 1. Idempotent. */
  async enroll(serial: string): Promise<void> {
    await this.enrollWith(serial);
  }

  async unenroll(_serial: string): Promise<void> {
    throw new AndroidUnsupportedError(
      "Removing an enrolled fingerprint",
      "delete it in Settings, or wipe the emulator",
    );
  }

  async match(serial: string): Promise<void> {
    await this.runner.run(serial, ["emu", "finger", "touch", "1"]);
  }

  async nonMatch(serial: string): Promise<void> {
    await this.runner.run(serial, ["emu", "finger", "touch", "2"]);
  }
}
