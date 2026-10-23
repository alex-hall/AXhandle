import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  AdbDeviceController,
  AdbScreenRecorder,
  AdzeChangeSignal,
  AndroidUnsupportedError,
  EmulatorBiometricController,
} from "../src/index.js";
import type {
  AdbCommandRunner,
  SignalWatcherProcess,
  VideoRecorderProcess,
} from "../src/index.js";

/** Records every adb call; answers with `replies` keyed by the joined args. */
class FakeAdb implements AdbCommandRunner {
  readonly calls: string[] = [];
  constructor(private readonly replies: Record<string, string> = {}) {}

  async run(serial: string, args: readonly string[]) {
    const call = [serial, ...args].join(" ");
    this.calls.push(call);
    return { stdout: this.replies[args.join(" ")] ?? "", stderr: "" };
  }
}

const SERIAL = "emulator-5554";
const APP = "com.example.app";

describe("AdbDeviceController", () => {
  it("launches the app's launcher activity and reports its pid", async () => {
    const adb = new FakeAdb({
      [`shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${APP}`]: `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n${APP}/.MainActivity\n`,
      [`shell pidof ${APP}`]: "4242\n",
    });
    const result = await new AdbDeviceController(adb).launch({
      udid: SERIAL,
      bundleId: APP,
      terminateRunning: true,
    });
    expect(result).toEqual({ pid: 4242 });
    expect(adb.calls).toEqual([
      `${SERIAL} shell am force-stop ${APP}`,
      `${SERIAL} shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${APP}`,
      `${SERIAL} shell am start -W -n ${APP}/.MainActivity`,
      `${SERIAL} shell pidof ${APP}`,
    ]);
  });

  it("refuses launch arguments rather than dropping them", async () => {
    await expect(
      new AdbDeviceController(new FakeAdb()).launch({
        udid: SERIAL,
        bundleId: APP,
        arguments: ["--reset"],
      }),
    ).rejects.toBeInstanceOf(AndroidUnsupportedError);
  });

  it("quotes a URL for the device shell, so & and ' arrive intact", async () => {
    const adb = new FakeAdb();
    await new AdbDeviceController(adb).openUrl(
      SERIAL,
      "https://example.com/invite?a=1&name=O'Brien",
    );
    expect(adb.calls).toEqual([
      `${SERIAL} shell am start -a android.intent.action.VIEW -d 'https://example.com/invite?a=1&name=O'\\''Brien'`,
    ]);
  });

  it("grants every Android permission behind a simulator permission name", async () => {
    const adb = new FakeAdb();
    await new AdbDeviceController(adb).grantPermission(SERIAL, "photos", APP);
    expect(adb.calls).toEqual([
      `${SERIAL} shell pm grant ${APP} android.permission.READ_MEDIA_IMAGES`,
      `${SERIAL} shell pm grant ${APP} android.permission.READ_MEDIA_VIDEO`,
    ]);
  });

  it("takes an Android permission name as-is", async () => {
    const adb = new FakeAdb();
    await new AdbDeviceController(adb).grantPermission(
      SERIAL,
      "android.permission.READ_CONTACTS",
      APP,
    );
    expect(adb.calls).toEqual([
      `${SERIAL} shell pm grant ${APP} android.permission.READ_CONTACTS`,
    ]);
  });

  it("returns one permission to never-asked by revoking it and clearing its answer", async () => {
    const adb = new FakeAdb();
    await new AdbDeviceController(adb).resetPermissions(SERIAL, "camera", APP);
    expect(adb.calls).toEqual([
      `${SERIAL} shell pm revoke ${APP} android.permission.CAMERA`,
      `${SERIAL} shell pm clear-permission-flags ${APP} android.permission.CAMERA user-set user-fixed`,
    ]);
  });

  it("knows an installed app by its exact package line", async () => {
    const adb = new FakeAdb({
      [`shell pm list packages ${APP}`]: `package:${APP}.debug\npackage:${APP}\n`,
    });
    expect(await new AdbDeviceController(adb).isAppInstalled(SERIAL, APP)).toBe(
      true,
    );
    const other = new FakeAdb({
      [`shell pm list packages ${APP}`]: `package:${APP}.debug\n`,
    });
    expect(
      await new AdbDeviceController(other).isAppInstalled(SERIAL, APP),
    ).toBe(false);
  });

  it("sends longitude first to the emulator console", async () => {
    const adb = new FakeAdb();
    await new AdbDeviceController(adb).setLocation(SERIAL, 51.5, -0.12);
    expect(adb.calls).toEqual([`${SERIAL} emu geo fix -0.12 51.5`]);
  });

  it("explains the clipboard instead of failing obscurely", async () => {
    await expect(
      new AdbDeviceController(new FakeAdb()).setPasteboard(SERIAL, "hi"),
    ).rejects.toThrow(/Android 10/);
  });
});

describe("EmulatorBiometricController", () => {
  it("matches with the enrolled finger and rejects with another", async () => {
    const adb = new FakeAdb();
    const biometrics = new EmulatorBiometricController({ runner: adb });
    await biometrics.match(SERIAL);
    await biometrics.nonMatch(SERIAL);
    expect(adb.calls).toEqual([
      `${SERIAL} emu finger touch 1`,
      `${SERIAL} emu finger touch 2`,
    ]);
  });

  it("enrolls through the configured enroller", async () => {
    const enrolled: string[] = [];
    const biometrics = new EmulatorBiometricController({
      runner: new FakeAdb(),
      enrollWith: async (serial) => {
        enrolled.push(serial);
      },
    });
    await biometrics.enroll(SERIAL);
    expect(enrolled).toEqual([SERIAL]);
  });
});

/** A fake long-lived child process: emits stdout data on demand. */
class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit");
  }
}

describe("AdzeChangeSignal", () => {
  it("runs adze watch-changes for the emulator and reports each change", () => {
    const launched: string[][] = [];
    const process = new FakeProcess();
    const signal = new AdzeChangeSignal({
      serial: SERIAL,
      binary: "/opt/adze",
      launch: (command, args) => {
        launched.push([command, ...args]);
        return process as unknown as SignalWatcherProcess;
      },
    });
    let changes = 0;
    signal.subscribe(() => changes++);
    signal.ensureWatching();
    signal.ensureWatching();
    process.stdout.emit("data", "changed\n");
    process.stdout.emit("data", "changed\nchanged\n");

    expect(launched).toEqual([
      ["/opt/adze", "watch-changes", "--serial", SERIAL],
    ]);
    expect(changes).toBe(2);
    signal.dispose();
  });

  it("starts the watcher again after it exits", () => {
    let launches = 0;
    const processes: FakeProcess[] = [];
    const signal = new AdzeChangeSignal({
      serial: SERIAL,
      launch: () => {
        launches++;
        const process = new FakeProcess();
        processes.push(process);
        return process as unknown as SignalWatcherProcess;
      },
    });
    signal.ensureWatching();
    processes[0]!.exitCode = 1;
    processes[0]!.emit("exit");
    signal.ensureWatching();
    expect(launches).toBe(2);
    signal.dispose();
  });
});

describe("AdbScreenRecorder", () => {
  it("records on the device, ends with SIGINT there, then pulls the file", async () => {
    const adb = new FakeAdb();
    const process = new FakeProcess();
    const launched: string[][] = [];
    const recorder = new AdbScreenRecorder(
      SERIAL,
      "/tmp/axhandle-test/run.mp4",
      {
        adb: "adb",
        runner: adb,
        finalizeTimeout: 50,
        launch: (command, args) => {
          launched.push([command, ...args]);
          return process as unknown as VideoRecorderProcess;
        },
      },
    );
    recorder.start();
    const remote = launched[0]!.at(-1)!;
    expect(launched[0]!.slice(0, 6)).toEqual([
      "adb",
      "-s",
      SERIAL,
      "shell",
      "screenrecord",
      "--time-limit",
    ]);

    setTimeout(() => process.emit("exit"), 5);
    await recorder.stop();
    expect(adb.calls).toEqual([
      `${SERIAL} shell pkill -INT -f ${remote}`,
      `${SERIAL} pull ${remote} /tmp/axhandle-test/run.mp4`,
      `${SERIAL} shell rm -f ${remote}`,
    ]);
  });
});
