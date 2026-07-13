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
suite. Real AXe/simulator conformance tests will be opt-in.

## Fixtures

Fixture tests use a versioned JSON envelope. Its `tree` is the untouched value
from `axe describe-ui`; metadata records where a captured fixture came from.
This allows parser and locator behavior to be tested without a booted
simulator, while preserving provenance when conformance fixtures are added.

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

## Safety

This is a public open-source project. Do not add private application code,
screenshots, accessibility captures, logs, credentials, service URLs, or test
flows. Read `Agent.MD` before contributing.
