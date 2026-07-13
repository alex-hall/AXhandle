# AXe TypeScript

A TypeScript-first, promise-based testing harness for iOS Simulator automation
through [cameroncooke/AXe](https://github.com/cameroncooke/AXe).

This project is intentionally app-agnostic. It wraps AXe behind typed
primitives, then provides chainable accessibility locators, retrying
assertions, and Vitest integration.

The current work plan is in `docs/plans/initial-roadmap.md`.

```ts
const thread = device.findByTestId("thread");

await thread.findByRole("button", { name: "Send" }).click();
await expect(thread.findByText("Delivered")).toBeVisible();
```

## Development status

This is an initial scaffold. The first vertical slice includes:

- a typed AXe driver boundary;
- a normalised accessibility tree;
- strict, chainable `findBy…` locators with `first()`, `second()`, and `nth()`;
- a fixture driver for simulator-free tests; and
- async Vitest matchers.

The package deliberately has no simulator requirement for its default test
suite. Real AXe/simulator end-to-end tests are opt-in.

## Public integration samples

The workspace includes two deliberately small, public iOS samples outside the
published package: a SwiftUI app in `apps/integration-sample-app` and a bare
React Native app in `apps/react-native-sample-app`. They exercise the same
composer, button, switch, and navigation control contract.

The React Native sample's captured initial AXe tree is a regular fixture, so
its locator behavior is covered by the default simulator-free suite. Live
end-to-end coverage is separately gated. After building, installing, and launching the
sample app on a booted simulator, run:

```sh
AXE_E2E=1 AXE_E2E_UDID=<udid> npm run test:e2e
```

The live test waits for an accessibility condition rather than sleeping. It
also puts its public sample form into a known state before exercising it, but
the library itself intentionally does not own app launch or simulator reset.

The flagship peer flow uses two separately booted simulators, each with the
same public React Native sample installed and launched. Its local relay is
started and reset by the end-to-end suite; it has no external service or
credentials:

```sh
AXE_E2E=1 \
AXE_E2E_ALICE_UDID=<alice-udid> \
AXE_E2E_BOB_UDID=<bob-udid> \
npm run test:e2e
```

The test selects Alice and Bob in their respective app instances, sends an
actual message from Alice, and waits for Bob's accessible incoming-message
state. Do not also set `AXE_E2E_UDID` for this pair mode.

## Fixtures

Fixture tests use a versioned JSON envelope. Its `tree` is the untouched value
from `axe describe-ui`; metadata records where a captured fixture came from.
This allows parser and locator behavior to be tested without a booted
simulator, while preserving provenance when end-to-end fixtures are added.

`tests/fixtures/axe-fixture.schema.json` documents the envelope. Only synthetic
fixtures or captures from this repository's own purpose-built sample app belong
in the project.

## Vitest setup

Install the matchers once in a Vitest setup file, then export a project-specific
`test` with the device lifecycle your application needs:

```ts
// test/support/axe.ts
import { expect } from "vitest";
import { AxeCliDriver, Device } from "axe-typescript";
import { axeMatchers, createAxeTest } from "axe-typescript/vitest";

expect.extend(axeMatchers);

export const test = createAxeTest({
  createDevices: () => ({
    primary: new Device(
      "primary",
      new AxeCliDriver({ udid: process.env.PRIMARY_SIMULATOR_UDID! })
    )
  }),

  reset: async ({ devices }) => {
    // Application-specific cleanup belongs to the consumer.
    await devices.primary.findByTestId("account").click();
  }
});
```

```ts
// test/message.test.ts
import { expect } from "vitest";
import { test } from "./support/axe.js";

test("sends a message", async ({ devices }) => {
  const device = devices.primary;
  const composer = device.findByTestId("composer");

await composer.findByTestId("message-input").type("Hello");
  await composer.findByRole("button", { name: "Send" }).click();
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
await device.findByRole("button", { name: "Send" }).click();
await expect(device.findByText("Delivered")).toBeVisible();
```

Use `findByTestId` when semantic selectors cannot distinguish repeated controls
or when it provides a useful stable scope. It is intentionally available, but
the library does not require every interaction to be driven by opaque IDs.
The supported role contract and known framework differences are documented in
`docs/accessibility-roles.md`.

## Failure evidence

The Vitest fixture can capture raw AXe JSON, a normalized accessibility tree,
and a command log when a test fails. Consumers own the destination through an
artifact sink:

```ts
import { InMemoryArtifactSink } from "axe-typescript";

const evidence = new InMemoryArtifactSink();

export const test = createAxeTest({
  createDevices,
  evidence: {
    sink: evidence,
    capture: "failure",
    screenshotPath: (device) => `artifacts/${device.name}.png`
  }
});
```

Evidence is collected before `reset`. Capture and reset failures do not replace
the original test failure.

## Multiple devices

For device pairs or larger test topologies, provide a lease allocator rather
than letting the harness retain a global pool. Each invocation gets named,
independent `Device` instances; reset runs before the lease is released:

```ts
export const test = createAxeTest({
  deviceProvider: {
    allocate: async () => ({
      alice: await allocateSimulator("alice"),
      bob: await allocateSimulator("bob")
    }),
    release: async ({ alice, bob }) => {
      await Promise.all([releaseSimulator(alice), releaseSimulator(bob)]);
    }
  },
  reset: async ({ devices }) => {
    await Promise.all([resetApp(devices.alice), resetApp(devices.bob)]);
  }
});

test("synchronizes two peers", async ({ devices }) => {
  await Promise.all([
    devices.alice.findByRole("button", { name: "Send" }).click(),
    devices.bob.findByText("Incoming message").waitForVisible()
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
  timeouts: { action: 5_000, assertion: 10_000 }
});

await device.findByTestId("send").click({ timeout: 8_000 });
await expect(device.findByText("Delivered"))
  .toBeVisible({ timeout: 15_000 });
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
import { diagnoseAxe } from "axe-typescript";

const report = await diagnoseAxe({
  udid: process.env.PRIMARY_SIMULATOR_UDID!,
  screenshotPath: "artifacts/doctor.png" // optional
});

if (!report.healthy) {
  throw new Error(report.checks.map((check) => check.message).join("\n"));
}
```

The result retains every individual check, so an unavailable AXe binary, an
unbooted simulator, malformed UI response, and screenshot failure remain
distinct and actionable.

## Optional simulator and biometric control

`Device` deliberately does not launch apps, erase simulators, or grant OS
permissions. Consumers that want Xcode simulator control can opt into the
shell-free `XcrunSimulatorController` instead:

```ts
import { XcrunSimulatorController } from "axe-typescript";

const simulator = new XcrunSimulatorController();
await simulator.install(udid, "/path/to/Example.app");
await simulator.grantPermission(udid, "photos", "dev.example.app");
await simulator.launch({ udid, bundleId: "dev.example.app" });
```

Biometric simulation is a separate `BiometricController` interface. The
default `UnsupportedBiometricController` throws clearly because the validated
Xcode 26.6 `simctl` installation exposes no biometric command. Inject a
verified platform-specific adapter for Face ID enrollment, match, and
non-match; it is not an AXe capability.

## Safety

This is a public open-source project. Do not add private application code,
screenshots, accessibility captures, logs, credentials, service URLs, or test
flows. Read `Agent.MD` before contributing.
