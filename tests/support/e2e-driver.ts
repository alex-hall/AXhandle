import {
  AdzeChangeSignal,
  AxeCliDriver,
  AxeEventCachedDriver,
  AxeServeDriver,
  NodeAxeCommandRunner,
} from "../../src/index.js";
import type { AxeDriver } from "../../src/index.js";

/**
 * The driver an e2e test drives its device with, chosen by environment so
 * one suite runs on both platforms:
 *
 * - `AXE_E2E_BINARY` — the driver binary: `axe` (default) for iOS
 *   simulators, `adze` for Android emulators, whose UDID is the adb serial.
 * - `AXE_E2E_SERVE=1` — one long-lived `serve` process instead of a process
 *   per command.
 * - `AXE_E2E_EVENTS=adze` — serve tree reads from cache until adze reports a
 *   screen change (Android only; the iOS bridge needs an app-side beacon the
 *   public samples don't carry).
 */
export function e2eDriver(udid: string): AxeDriver {
  const binary = process.env.AXE_E2E_BINARY ?? "axe";
  const driver =
    process.env.AXE_E2E_SERVE === "1"
      ? new AxeServeDriver({ udid, binary })
      : new AxeCliDriver({ udid, runner: new NodeAxeCommandRunner(binary) });
  if (process.env.AXE_E2E_EVENTS === "adze") {
    return new AxeEventCachedDriver(driver, {
      signal: new AdzeChangeSignal({ serial: udid, binary }),
    });
  }
  return driver;
}
