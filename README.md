# AXhandle

A TypeScript-first, promise-based testing harness for iOS Simulator automation
through [cameroncooke/AXe](https://github.com/cameroncooke/AXe).

This project is intentionally app-agnostic. It wraps AXe behind typed
primitives, then provides chainable accessibility locators, retrying
assertions, and Vitest integration.

## Getting started

AXhandle runs on macOS against the iOS Simulator. Install a supported
AXe CLI version on `PATH`, then add this package and Vitest to the consuming
project:

```sh
npm install --save-dev axhandle vitest
```

Register the matchers and create a project-specific test fixture as shown in
[Vitest setup](#vitest-setup). The fixture is where your project supplies a
simulator UDID and owns app-specific provisioning and reset behavior.

```ts
const thread = device.findByTestId("thread");

await thread.findByRole("button", { name: "Send" }).tap();
await expect(thread.findByText("Delivered")).toBeVisible();
```

## What it provides

AXhandle provides:

- a typed AXe driver boundary;
- a normalised accessibility tree;
- strict, chainable `findBy…` locators with `first()`, `second()`, and `nth()`;
- async Vitest matchers and structured failure evidence; and
- named, independently composable devices for multi-simulator flows.

It is designed for simulator-backed end-to-end tests. Your suite supplies the
simulator devices, application lifecycle, identity/provisioning, and reset
behavior; this package supplies typed AXe interaction and assertion semantics.

## Vitest setup

Install the matchers once in a Vitest setup file, then export a project-specific
`test` with the device lifecycle your application needs:

```ts
// test/support/axe.ts
import { expect } from "vitest";
import { AxeCliDriver, Device } from "axhandle";
import { axeMatchers, createAxeTest } from "axhandle/vitest";

expect.extend(axeMatchers);

export const test = createAxeTest({
  createDevices: () => ({
    primary: new Device(
      "primary",
      new AxeCliDriver({ udid: process.env.PRIMARY_SIMULATOR_UDID! }),
    ),
  }),

  reset: async ({ devices }) => {
    // Application-specific cleanup belongs to the consumer.
    await devices.primary.findByTestId("account").tap();
  },
});
```

```ts
// test/message.test.ts
import { expect } from "vitest";
import { test } from "./support/axe.js";

test("sends a message", async ({ devices }) => {
  const device = devices.primary;
  const message = device.findByTestId("message-input");

  await message.type("Hello");
  await device.findByRole("button", { name: "Send" }).tap();
  await expect(device.findByText("Delivered")).toBeVisible();
});
```

`findBy…` calls only construct immutable locator descriptions. Actions and
assertions execute immediately as normal promises when they are awaited; there
is no Cypress-style hidden command queue.

## Locator strategy

Favor selectors a person could understand from the interface: roles and their
accessible names first, then visible text or labels. For example:

```ts
await device.findByRole("button", { name: "Send" }).tap();
await expect(device.findByText("Delivered")).toBeVisible();
```

Use `findByTestId` when semantic selectors cannot distinguish repeated controls
or when it provides a useful stable scope. It is intentionally available, but
the library does not require every interaction to be driven by opaque IDs.
The supported role contract and known framework differences are documented in
`docs/accessibility-roles.md`.

When AXe reports a genuine accessibility hierarchy, locators can scope further
searches without a new abstraction:

```ts
const body = device.findByTestId("body");
await body.findByRole("button", { name: "Send" }).tap();
```

Scope is hierarchy-strict. Some visual containers, including the public
SwiftUI and React Native sample composer, are flattened by AXe into sibling
elements; a visual container is not a valid scope in that shape.

## Presence, absence, and screen detection

Interactions are strict — one element, or an error. Presence questions are
different: "is the toast gone yet?" or "which screen am I on?" want a
non-strict answer, not an ambiguity error.

```ts
if (await device.findByLabel("Saved").exists()) {
  /* … */
}
await device.findByLabel("Uploading").waitForGone();

// One accessibility snapshot answers a multi-screen race:
const seen = await device.firstPresent(welcome, home);
if (seen === home) {
  /* already signed in */
}
```

`findByText` and `findByLabel` accept `{ exact: false }` for normalized
substring matching: case-insensitive, and no-break spaces (which some
frameworks, React Native included, use to join composite labels) match
ordinary spaces. Exact matching stays exact — an ASCII space never equals
U+00A0.

## Navigation taps that verify arrival

A "successful" tap is not proof of navigation: a control can render before its
touch handler attaches, and overlays or first-run tooltips can swallow the
first tap. `tap({ until })` retries the tap until an arrival locator is
present, tolerating a control that vanished because an earlier tap did land:

```ts
await device.findByLabel("Continue").tap({
  until: device.findByLabel("Welcome"),
  attempts: 3,
});
```

> `click()` (from 0.1.x) remains a deprecated alias for `tap()` and will be
> removed in 1.0 — iOS has taps, not clicks.

## System alerts, gestures, and raw taps

Native alert buttons frequently never appear in `describe-ui`, so tree-based
locators cannot reach them — but AXe's own label tap still lands. `tapLabel`
exposes it (including AXe's `--wait-timeout` presence polling), and
`optional: true` makes it the standard way to drain an alert whose arrival
races the flow:

```ts
await device.tapLabel("Allow", { waitTimeout: 5_000, optional: true });
await device.swipe({
  startX: 200,
  startY: 650,
  endX: 200,
  endY: 250,
  durationMs: 400,
});
await device.tapPoint(200, 500);
```

No actionability check happens on these paths — use them where the next wait
in the flow verifies the outcome. All three run through the device queue and
command log. On the driver contract they are optional capabilities;
`AxeCliDriver` implements them all.

## Command log and step timing

Every queued operation lands in `device.commandLog()` with real timings.
`recordAction` folds out-of-band work (app lifecycle, biometric triggers, raw
driver calls) into the same queue and log so one log is the whole truth, and
`commandMark()` + `commandLog({ after })` window it for per-step attribution:

```ts
const mark = device.commandMark();
await device.recordAction("app.launch", () =>
  simulator.launch({ udid, bundleId }),
);
await signIn(device);
const actionsInsideStep = device.commandLog({ after: mark });
```

## Failure evidence

The Vitest fixture can capture raw AXe JSON, a normalized accessibility tree,
and a command log when a test fails. Consumers own the destination through an
artifact sink:

```ts
import { InMemoryArtifactSink } from "axhandle";

const evidence = new InMemoryArtifactSink();

export const test = createAxeTest({
  createDevices,
  evidence: {
    sink: evidence,
    capture: "failure",
    screenshotPath: (device) => `artifacts/${device.name}.png`,
  },
});
```

Evidence is collected before `reset`. Capture and reset failures do not replace
the original test failure.

`DirectoryArtifactSink` writes each artifact as a file in a directory of your
choice — the production default for retained evidence. File names carry the
device name, and repeated captures (a second failing test, or `capture:
"always"`) get numeric suffixes rather than overwriting earlier evidence.
For screen recordings,
`SimulatorVideoRecorder` wraps `simctl io recordVideo` with the lifecycle a
record-always policy needs: `start()` before the test, `discard()` on pass,
`stop()` on failure to keep the file. Finalization is SIGINT-only — any other
way of ending the recorder process corrupts the file — and stop is
deadline-bounded so a wedged recorder cannot hang teardown.

## Multiple devices

For device pairs or larger test topologies, provide a lease allocator rather
than letting the harness retain a global pool. Each invocation gets named,
independent `Device` instances; reset runs before the lease is released:

```ts
export const test = createAxeTest({
  deviceProvider: {
    allocate: async () => ({
      alice: await allocateSimulator("alice"),
      bob: await allocateSimulator("bob"),
    }),
    release: async ({ alice, bob }) => {
      await Promise.all([releaseSimulator(alice), releaseSimulator(bob)]);
    },
  },
  reset: async ({ devices }) => {
    await Promise.all([resetApp(devices.alice), resetApp(devices.bob)]);
  },
});

test("synchronizes two peers", async ({ devices }) => {
  await Promise.all([
    devices.alice.findByRole("button", { name: "Send" }).tap(),
    devices.bob.findByText("Incoming message").waitForVisible(),
  ]);
});
```

`Device` serializes commands only within itself. Separate devices remain normal
independent promises, so the provider determines allocation and parallelism.

Lifecycle order is deterministic: `beforeTest`, test body, failure evidence
(when configured), `reset`, then provider `release`. Reset and release always
run. A primary test failure remains primary; later cleanup failures are
available to custom integrations with `getAxeCleanupFailures(error)`.

## Text input

`type()` appends HID keystrokes to the focused field. `fill()` replaces text by
tapping the field, sending Command-A, typing the replacement, and verifying the
new accessibility value:

```ts
await device.findByTestId("message-input").fill("Hello");
await expect(device.findByTestId("message-input")).toHaveValue("Hello");
```

AXe uses a US HID keyboard layout. For fields that intentionally mask their
accessibility value (such as secure text entry), skip only the value check:

```ts
await device.findByTestId("password").fill("correct-horse", { verify: false });
```

If AXe text entry fails, the entered value is redacted from the public error,
command log, and failure evidence. The command, simulator target, and AXe
diagnostic remain available for debugging.

## Switches and checkboxes

`check()` and `uncheck()` read the current accessibility state, tap only when
necessary, and retry until AXe reports the desired result:

```ts
const notifications = device.findByRole("switch", { name: "Notifications" });

await notifications.check();
await expect(notifications).toBeChecked();
```

## Timeouts

There are three timeout levels:

1. A `Device` has defaults for actions (3 seconds), assertions (5 seconds),
   and polling interval (100 milliseconds).
2. Vitest owns the outer test deadline.
3. Individual actions and assertions can override their own timeout.

```ts
const device = new Device("primary", driver, {
  timeouts: { action: 5_000, assertion: 10_000 },
});

await device.findByTestId("send").tap({ timeout: 8_000 });
await expect(device.findByText("Delivered")).toBeVisible({ timeout: 15_000 });
```

Prefer a visible condition or assertion over an arbitrary delay. The public API
intentionally has no manual sleep operation.

## Environment diagnostics

`diagnoseAxe` is a read-only preflight for a configured simulator. It checks
the AXe binary and version, confirms that AXe reports the requested simulator
as booted, reads and validates the accessibility tree, and can optionally
exercise screenshot capture. It does not boot a simulator or launch, terminate,
or reset an app.

```ts
import { diagnoseAxe } from "axhandle";

const report = await diagnoseAxe({
  udid: process.env.PRIMARY_SIMULATOR_UDID!,
  screenshotPath: "artifacts/doctor.png", // optional
});

if (!report.healthy) {
  throw new Error(report.checks.map((check) => check.message).join("\n"));
}
```

The result retains every individual check, so an unavailable AXe binary, an
unbooted simulator, malformed UI response, and screenshot failure remain
distinct and actionable.

The supported-version policy and validated public matrix are in
`docs/compatibility.md`.

To run the native SwiftUI sample proof after building and installing the app on
a booted simulator:

```sh
AXE_E2E=1 AXE_E2E_SWIFTUI_UDID=<simulator-udid> npm run test:e2e
```

## Optional simulator and biometric control

`Device` deliberately does not launch apps, erase simulators, or grant OS
permissions. Consumers that want Xcode simulator control can opt into the
shell-free `XcrunSimulatorController` instead:

```ts
import { XcrunSimulatorController } from "axhandle";

const simulator = new XcrunSimulatorController();
await simulator.install(udid, "/path/to/Example.app");
await simulator.grantPermission(udid, "photos", "dev.example.app");
await simulator.launch({ udid, bundleId: "dev.example.app" });

// Deterministic first-run state: the simulator keychain SURVIVES uninstall,
// and leftover identities are a classic source of flaky signup flows.
await simulator.uninstall(udid, "dev.example.app");
await simulator.resetKeychain(udid);
if (await simulator.isAppInstalled(udid, "dev.example.app")) {
  /* … */
}
```

Biometric simulation is a separate `BiometricController` interface; it is not
an AXe capability. `NotifyutilBiometricController` drives BiometricKit over
the simulator's Darwin notification bridge (`simctl spawn <udid> notifyutil`)
— the same mechanism behind Simulator.app's Features menu — for enrollment,
match, and non-match. Note the biometric prompt itself is system UI outside
the app's accessibility tree: `describe-ui` cannot observe it, so sequence
matches against an app-level observable and verify the outcome in the app.
The default remains `UnsupportedBiometricController`, which throws clearly,
because the validated Xcode 26.6 `simctl` exposes no biometric command.

## Safety

This is a public open-source project. Do not add private application code,
screenshots, accessibility captures, logs, credentials, service URLs, or test
flows. Read `Agent.MD` before contributing.

## Trademarks

AXhandle is an independent open-source project built on
[cameroncooke/AXe](https://github.com/cameroncooke/AXe). It is not affiliated
with, endorsed by, or associated with Deque Systems or its axe® accessibility
products, nor with Apple Inc. "AX" refers to the prefix Apple uses for its
accessibility APIs.
