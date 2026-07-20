# AXhandle

A TypeScript wrapper around [cameroncooke/AXe](https://github.com/cameroncooke/AXe)
for building and managing iOS Simulator regression suites. You get
Playwright-style locators and custom Vitest matchers for driving a real app
through its accessibility tree — no app changes, no mocks — plus wrappers for
the Apple tooling a simulator suite ends up needing anyway:

- **`simctl` app lifecycle** — install, launch, permission grants, and the
  state that survives reinstall (keychain, pasteboard) and quietly breaks
  "fresh install" tests until you reset it.
- **Face ID / Touch ID simulation** — `simctl` has no biometric command;
  AXhandle drives the same notification bridge Simulator.app's Features menu
  uses.
- **Per-test screen recording** — kept on failure, deleted on pass, finalized
  correctly (get this wrong and the file is corrupt).
- **A per-device command log with real timings** — so when the suite is slow,
  you can see where the time actually went.

## Contents

- [Getting started](#getting-started)
- [API overview](#api-overview)
- [Vitest setup](#vitest-setup)
- [Choosing selectors](#choosing-selectors)
- [One element, or "is it on screen at all?"](#one-element-or-is-it-on-screen-at-all)
- [Taps that get swallowed](#taps-that-get-swallowed)
- [Things the accessibility tree can't see](#things-the-accessibility-tree-cant-see)
- [Text input](#text-input)
- [Switches and checkboxes](#switches-and-checkboxes)
- [Timeouts](#timeouts)
- [Screenshots and video](#screenshots-and-video)
- [Screenshot/Debug when a test fails](#screenshotdebug-when-a-test-fails)
- [Multiple devices](#multiple-devices)
- [Command log and step timing](#command-log-and-step-timing)
- [Simulator control and Face ID](#simulator-control-and-face-id)
- [Preflight diagnostics](#preflight-diagnostics)
- [Contributing](#contributing)

## Getting started

AXhandle runs on macOS and talks to the simulator through the AXe CLI:

```sh
brew install cameroncooke/axe/axe    # AXe CLI on PATH
npm install --save-dev axhandle vitest
```

Every `Device` targets one simulator by UDID. Find yours with:

```sh
xcrun simctl list devices booted
```

The examples below read the UDID from an environment variable
(`PRIMARY_SIMULATOR_UDID`) — that's your variable to define, not something
AXhandle reads on its own. Wire it into a fixture once
([Vitest setup](#vitest-setup)) and tests look like this:

```ts
const thread = device.findByTestId("thread");

await thread.findByRole("button", { name: "Send" }).tap();
await expect(thread.findByText("Delivered")).toBeVisible();
```

## API overview

Everything hangs off a `Device` (one simulator) and the `Locator`s it
creates. Actions are plain promises — no hidden command queue.

**Finding elements**

| API | What it does |
| --- | --- |
| `findByRole("button", { name: "Send" })` | Match by accessibility role and name — the selector a person would use |
| `findByText(value)` / `findByLabel(value)` | Match visible text or accessibility label; `{ exact: false }` for case-insensitive substring matching |
| `findByTestId(value)` | Match a `testID` / accessibility identifier |
| `.first()` / `.second()` / `.nth(i)` | Choose among duplicate matches explicitly |
| `parent.findBy…(…)` | Scope a query inside a previous match |

**Acting on them**

| API | What it does |
| --- | --- |
| `tap()` | Wait until the element is unique, visible, and enabled; then tap. `tap({ until })` retries until an arrival marker appears |
| `type(text)` | Tap the field, then send HID keystrokes |
| `fill(text)` | Replace field contents (select-all + type) and verify the result |
| `check()` / `uncheck()` | Read a switch's state, tap only if needed, verify |
| `tapLabel(label)` | Tap by label through AXe directly — reaches native alert buttons the tree never shows |
| `tapPoint(x, y)` / `longPress(x, y)` / `swipe(gesture)` | Raw coordinate gestures, logged and queued |
| `screenshot(path)` | PNG of the current screen |

**Waiting and asserting**

| API | What it does |
| --- | --- |
| `expect(locator).toBeVisible()` etc. | Retrying Vitest matchers: `toBeVisible/Hidden`, `toBeEnabled/Disabled`, `toBeChecked/Unchecked`, `toHaveText/Value/Count` |
| `waitForVisible()` / `waitFor(predicate)` | Poll until the (single) element satisfies a condition |
| `isPresent()` / `waitForPresent()` / `waitForGone()` | Non-strict presence: "is anything matching on screen?" |
| `firstPresent(...locators)` | Which of these screens am I on? One tree fetch answers |
| `presentNodes()` / `matchesIn(tree)` | Read the matching nodes themselves; evaluate many locators against one snapshot |
| `poll(condition, options)` | The bare polling loop, exported for your own waits |

**Running a suite**

| API | What it does |
| --- | --- |
| `createAxeTest(options)` | Vitest fixture: device creation, reset, failure evidence, deterministic teardown |
| `DirectoryArtifactSink` | On failure, write screenshot + accessibility tree + command log to a directory |
| `SimulatorVideoRecorder` | Record every test; keep video on failure, discard on pass |
| `commandLog()` / `commandMark()` / `recordAction()` | Per-device action log with timings, windowable per step |

**Simulator control**

| API | What it does |
| --- | --- |
| `XcrunSimulatorController` | Install/uninstall/launch/terminate, permission grants, keychain reset, pasteboard get/set, container paths |
| `NotifyutilBiometricController` | Enroll, match, and reject Face ID / Touch ID prompts |
| `diagnoseAxe(options)` | Read-only preflight: AXe version, simulator booted, tree parses — with a per-check report |

## Vitest setup

Register the matchers once, then export a project-specific `test` that owns
your device lifecycle:

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
    // App-specific cleanup between tests belongs to your suite.
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

  await device.findByTestId("message-input").type("Hello");
  await device.findByRole("button", { name: "Send" }).tap();
  await expect(device.findByText("Delivered")).toBeVisible();
});
```

The rest of this README is guidance: how to pick selectors, and the
simulator/accessibility quirks each part of the API exists to absorb.

## Choosing selectors

Prefer selectors a person could read off the screen: roles and names first,
then visible text or labels. `findByTestId` is there when semantic selectors
can't distinguish repeated controls — useful, just not mandatory. The
supported roles and known framework differences are in
`docs/accessibility-roles.md`.

Locators chain to scope a search:

```ts
const body = device.findByTestId("body");
await body.findByRole("button", { name: "Send" }).tap();
```

Watch out: scoping follows the accessibility hierarchy, not the visual one.
AXe flattens some visual containers (SwiftUI and React Native composers among
them) into siblings — a container that looks like a parent on screen may not
be one in the tree.

## One element, or "is it on screen at all?"

Interactions are strict: a locator must resolve to exactly one element, and
ambiguity is an error that tells you to refine the query. Presence questions
are different — "is the toast gone?", "which screen am I on?" — and have
their own non-strict APIs:

```ts
if (await device.findByLabel("Saved").isPresent()) { /* … */ }
await device.findByLabel("Uploading").waitForGone();

// One tree fetch decides a multi-screen race:
const seen = await device.firstPresent(welcome, home);
if (seen === home) { /* already signed in */ }
```

`presentNodes()` returns the matching nodes themselves — useful when the
rendered content is the ground truth, like reading a display name back off a
profile row because the text input that produced it is opaque to
accessibility.

When you need many answers from one screen, fetch the tree once and evaluate
locators against it — each fetch is a full `describe-ui` round trip, so this
is the difference between one CLI call and ten:

```ts
const { tree } = await device.uiSnapshot();
const frame = device.findByLabel("7").matchesIn(tree)[0]?.frame;
```

Substring matching (`{ exact: false }`) is case-insensitive and treats
no-break spaces as spaces. That last part matters on React Native, which
joins composite labels with U+00A0 — an exact query typed with a normal space
will never match, and nothing will tell you why.

## Taps that get swallowed

A tap can "succeed" and do nothing: React Native renders buttons before their
touch handlers attach, first-run tooltips eat the next tap, and overlays sit
above targets. When a tap is supposed to navigate, say so, and AXhandle
retries until the destination actually shows up:

```ts
await device.findByLabel("Continue").tap({
  until: device.findByLabel("Welcome"),
  attempts: 3,
});
```

(`click()` from 0.1.x still works as a deprecated alias — it's removed in
1.0. iOS has taps, not clicks.)

## Things the accessibility tree can't see

Native alert buttons ("Allow", "Delete", permission prompts) frequently don't
appear in `describe-ui` at all, so tree-based locators can't reach them. AXe's
label tap still lands. `tapLabel` exposes it, and `optional: true` is the
pattern for draining an alert that may or may not show up:

```ts
await device.tapLabel("Allow", { waitTimeout: 5_000, optional: true });
```

Coordinate gestures cover the rest — list scrolling, long-press affordances,
targets with no labels:

```ts
await device.swipe({
  startX: 200,
  startY: 650,
  endX: 200,
  endY: 250,
  durationMs: 400,
});
await device.longPress(200, 420, { holdMs: 1_500, command: "copy-link" });
await device.tapPoint(200, 500);
```

None of these check actionability first — use them where the next wait in
your flow verifies the outcome. They all run through the device queue and
show up in the command log; pass `{ command: "numpad-7" }` to give the log
row a meaningful name.

## Text input

`type()` appends HID keystrokes to the focused field. `fill()` replaces the
contents (tap, select-all, type) and verifies the field's accessibility value
afterwards:

```ts
await device.findByTestId("message-input").fill("Hello");
```

For secure fields that mask their accessibility value, skip just the
verification: `fill("…", { verify: false })`. If AXe text entry fails, the
typed value is redacted from errors, the command log, and failure evidence.

AXe types on a US HID keyboard layout.

## Switches and checkboxes

`check()` and `uncheck()` read the current state, tap only when needed, and
verify the result:

```ts
const notifications = device.findByRole("switch", { name: "Notifications" });
await notifications.check();
await expect(notifications).toBeChecked();
```

## Timeouts

Three levels, all in milliseconds:

1. `Device` defaults: 3s for actions, 5s for assertions, 100ms polling
   interval.
2. Per-call overrides: `tap({ timeout: 8_000 })`,
   `toBeVisible({ timeout: 15_000 })`.
3. Vitest owns the outer test deadline.

```ts
const device = new Device("primary", driver, {
  timeouts: { action: 5_000, assertion: 10_000 },
});
```

There is deliberately no sleep API. Wait on something observable; generous
timeouts are free when the condition arrives early.

## Screenshots and video

Grab a screenshot at any point — it goes through the device queue, so it
captures the screen as of the commands before it:

```ts
await device.screenshot("artifacts/after-signup.png");
```

For full-run recordings, `SimulatorVideoRecorder` wraps
`simctl io recordVideo` with a record-always lifecycle: start before the
test, keep the file on failure, delete it on pass:

```ts
import { SimulatorVideoRecorder } from "axhandle";

const video = new SimulatorVideoRecorder(udid, "artifacts/run.mp4");
video.start();
try {
  // ... drive the app ...
} finally {
  if (failed) await video.stop(); // finalize and keep
  else await video.discard(); // finalize and delete
}
```

Two details it handles for you: `recordVideo` only writes a playable file
when finalized with SIGINT (kill it any other way and the video is corrupt),
and `stop()` bounds its wait so a wedged recorder can't hang test teardown.

## Screenshot/Debug when a test fails

The Vitest fixture can automatically capture a screenshot, the raw and
normalized accessibility tree, and the command log for every failing test:

```ts
import { DirectoryArtifactSink } from "axhandle";

export const test = createAxeTest({
  createDevices,
  evidence: {
    sink: new DirectoryArtifactSink("artifacts/evidence"),
    capture: "failure",
    screenshotPath: (device) => `artifacts/${device.name}.png`,
  },
});
```

File names include the device name, and repeated captures get numeric
suffixes instead of overwriting earlier evidence. Capture runs before
`reset`, and a capture failure never masks the original test failure. Pair
it with [video recording](#screenshots-and-video) to retain a recording of
each failed run alongside the tree and log.

## Multiple devices

For two-actor and larger tests, hand the fixture a lease allocator. Each test
gets named, independent `Device` instances:

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
});

test("synchronizes two peers", async ({ devices }) => {
  await Promise.all([
    devices.alice.findByRole("button", { name: "Send" }).tap(),
    devices.bob.findByText("Incoming message").waitForVisible(),
  ]);
});
```

Commands serialize within one device; separate devices run in parallel as
ordinary promises. Lifecycle order is fixed: `beforeTest`, test body, failure
evidence, `reset`, provider `release` — reset and release always run, and
cleanup failures never replace the primary failure
(`getAxeCleanupFailures(error)` retrieves them).

## Command log and step timing

Every operation lands in `device.commandLog()` with start/end timestamps.
`recordAction` pulls out-of-band work (app launches, biometric triggers) into
the same log, and `commandMark()` + `commandLog({ after })` slice it per
step — which is how you attribute a slow test to the actions inside it:

```ts
const mark = device.commandMark();
await device.recordAction("app.launch", () =>
  simulator.launch({ udid, bundleId }),
);
await signIn(device);
const actionsInsideStep = device.commandLog({ after: mark });
```

Device calls nested inside `recordAction` are safe — they run inline on the
held queue slot and still log their own rows.

## Simulator control and Face ID

`Device` only drives the app's UI. App lifecycle and OS state live on
`XcrunSimulatorController` (shell-free `simctl`):

```ts
import { XcrunSimulatorController } from "axhandle";

const simulator = new XcrunSimulatorController();
await simulator.install(udid, "/path/to/Example.app");
await simulator.grantPermission(udid, "camera", "dev.example.app");
await simulator.launch({ udid, bundleId: "dev.example.app" });
```

Two pieces of simulator state survive app uninstall and quietly break
"fresh install" tests:

- **The keychain.** A leftover identity turns your signup flow into a signin
  flow. `resetKeychain(udid)` before a fresh install.
- **The pasteboard.** Apps that inspect the clipboard on first focus
  (deferred-deeplink detection) will act on whatever a previous test left
  there. `setPasteboard(udid, "…")` to neutralize it.

For Face ID / Touch ID, `simctl` has no biometric command.
`NotifyutilBiometricController` posts the same Darwin notifications
Simulator.app's Features menu does — `enroll`, `match`, `nonMatch`. One
caveat: the biometric prompt is system UI, invisible to `describe-ui`, so you
can't poll for it. Trigger the match against something observable in your app
and verify the outcome there. (The default is `UnsupportedBiometricController`,
which throws with instructions rather than silently no-oping.)

## Preflight diagnostics

`diagnoseAxe` checks the environment before a run wastes time on it: AXe
binary present and a supported version, simulator booted, accessibility tree
readable, optionally a screenshot round trip. Each check reports separately,
so "AXe not installed" and "simulator not booted" stay distinct:

```ts
import { diagnoseAxe } from "axhandle";

const report = await diagnoseAxe({ udid: process.env.PRIMARY_SIMULATOR_UDID! });
if (!report.healthy) {
  throw new Error(report.checks.map((check) => check.message).join("\n"));
}
```

Supported AXe versions and the validated compatibility matrix are in
`docs/compatibility.md`. To run the SwiftUI sample's e2e proof against a
booted simulator:

```sh
AXE_E2E=1 AXE_E2E_SWIFTUI_UDID=<simulator-udid> npm run test:e2e
```

## Contributing

Contributor guidelines — including the information-safety rules for this
public repo and the API naming conventions — live in `Agent.MD`.

## Trademarks

AXhandle is an independent open-source project built on
[cameroncooke/AXe](https://github.com/cameroncooke/AXe). It is not affiliated
with, endorsed by, or associated with Deque Systems or its axe® accessibility
products, nor with Apple Inc. "AX" refers to the prefix Apple uses for its
accessibility APIs.
