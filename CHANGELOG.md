# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Breaking (0.2.0 API, unadopted)

Nomenclature alignment before these names gathered consumers. 0.2.0
introduced three spellings of the non-strict presence concept and one
misfit duration name; they are unified here as clean breaks (0.2.0 has no
known consumers), and the conventions are now documented in Agent.MD's
"Naming conventions" section.

- `Locator.exists()` is now `Locator.isPresent()` — the _present_ family
  (`isPresent`, `waitForPresent`, `waitForGone`, `presentNodes`,
  `firstPresent`) is the one spelling of non-strict presence.
- Snapshot matching is unified under `Locator.matchesIn(tree, { strict? })`:
  presence semantics by default, interaction-grade with `strict: true`. The
  0.2.0 `presenceMatches` is removed; the 0.1.x `matchesFrom` remains as a
  deprecated alias until 1.0.
- `SimulatorVideoRecorderOptions.finalizeTimeoutMs` is now
  `finalizeTimeout` — `*timeout`/`*interval` names never carry a unit
  suffix; all public durations are milliseconds.

### Changed

- `click()` is renamed to `tap()` on `Device` and `Locator` — iOS has taps,
  not clicks. `click()` and `ClickOptions` remain as deprecated aliases and
  will be removed in 1.0. Command-log entries now record `tap` (locator
  taps) and `tap-point` (coordinate taps) instead of `click`/`tap`.

### Added

- `Device.swipe()`, `Device.tapLabel()` (native alert buttons), `poll()`,
  `SimulatorVideoRecorder`, `XcrunSimulatorController` (install/launch/
  terminate, privacy grants, keychain reset), biometric controllers, and
  device evidence capture.
- The sample apps now exercise the full interaction surface (swipe lists,
  native alerts, coordinate taps), with matching e2e suites plus a
  simulator-control e2e suite.
- `Device.longPress(x, y, { holdMs, command })` and the optional
  `AxeDriver.longPress` capability (`touch --down`/`--up` bracketing a real
  hold) — long-press affordances such as copy-on-hold.
- Simulator pasteboard control: `XcrunSimulatorController.setPasteboard` /
  `getPasteboard` (`SimulatorCommandRunner` gained an `input` option for
  stdin-fed commands). Documented caveat: the pasteboard survives app
  reinstall, so suites should neutralize it when provisioning.
- `Locator.waitForPresent()` — the arrival companion to `waitForGone()`.
- `Locator.presentNodes()` — non-strict matched-node reads, for when the
  rendered content itself is the assertion ground truth.
- `Locator.matchesIn(tree)` — evaluate a locator against a caller-held
  snapshot, so one `uiSnapshot()` answers many queries (batch frame-mapping
  a keypad costs one tree fetch). Replaces the internal `presenceMatches`,
  which remains as a deprecated alias until 1.0.
- `tapPoint` / `swipe` / `longPress` accept `{ command }` to name their
  command-log rows (`numpad-7` instead of an opaque `tap-point`).
- `recordAction` is now reentrancy-safe: device calls nested inside the
  recorded operation run inline on the held queue slot (still logged)
  instead of deadlocking — previously this was a guaranteed hang.
- Snapshot cache: back-to-back reads (a check-then-tap, a multi-locator
  probe) now share one `describe-ui` dump instead of re-dumping within the
  same instant. The cache can never mask a state change a wait is polling
  for: every action invalidates it immediately, so does every wait-sleep on
  the device's clock (each poll iteration re-dumps, whatever its per-call
  interval), and reuse is bounded by `DeviceOptions.cacheWindowMs` — default
  `min(interval - 1, 50)`, `0` to opt out.
- `AxeServeDriver` — an `AxeDriver` over one long-lived `axe serve` process
  instead of one CLI invocation per command, eliminating the CLI's fixed
  per-invocation session setup. Requires an AXe build with the `serve`
  subcommand. Screenshots and newline-bearing text fall back to a classic
  CLI driver; a command that gets no response within its deadline kills and
  respawns the process, so the reply stream can never desynchronize.
- `AxeDriver.dispose?()` and `Device.dispose()` — release a driver's held
  resources (a serve process above all) without `instanceof` checks in
  consumer teardown.
- Every failure now names its device: errors thrown through the device
  queue and locator waits carry a ` [device-name]` suffix (command-log rows
  included), so multi-device suites can tell identical-looking failures
  apart without wrapping every call. `Device.tagMessage()` exposes the same
  tagging for consumer-built helpers; already-tagged messages are never
  double-tagged.
- `Locator.last()` — the final match in tree order, whatever the count.
  iOS appends stacked presentations last, so
  `findByRole("sheet").last()` scopes to the sheet actually in front —
  the disambiguation for alerts that reuse a word visible on the screen
  behind them.
- `Locator.label()` / `value()` / `frame()` — strict single-element
  attribute reads (Playwright's `textContent()`/`boundingBox()` shape), for
  elements that exist to be read rather than tapped and for
  relative-position assertions.
- `Device.type(text)` — HID-type into whatever currently holds focus,
  resolving nothing. The fast path when the previous action (a `tapLabel`,
  a coordinate tap on an AX-invisible target) already owns the focus.
- `XcrunSimulatorController.openUrl(udid, url)` — deep links per device.
  Unlike the pasteboard (one host-wide resource every simulator shares),
  `simctl openurl` cannot cross-talk between parallel suites.
- Event-invalidated snapshot caching: `AxeEventCachedDriver` serves
  `describe-ui` from cache until the app announces a UI change (or a
  driver interaction lands), instead of re-dumping once per poll interval.
  The announcing side is consumer-owned and pluggable via the
  `UiChangeSignal` interface; `NotifyutilChangeSignal` is the reference
  implementation — one persistent `simctl spawn <udid> notifyutil -w`
  watcher on a configurable Darwin notification name, lazily restarted if
  a simulator reboot kills it. Safety valves: `maxStalenessMs` bounds how
  long beacon-blind native UI (UIKit menus, the keyboard) can go unseen;
  `minPollMs` keeps a perpetually-animating screen from collapsing poll
  sleeps to zero and spinning at full dump speed.
- `AxeDriver.sleepUntilChange?(ms)` — an optional driver capability for
  poll sleeps that end early the moment the screen changes. When a driver
  provides it and no explicit clock is configured, `Device` wires it into
  its poll clock automatically: waits re-check within milliseconds of a
  real change instead of up to a full interval later. Safe by
  construction — every internal clock sleep is a poll loop that re-checks
  its condition on wake.
- `Device.wallSleep(ms)` — a sleep that always elapses in full, in real
  time. The companion rule to early-waking poll sleeps: pacing floors that
  must genuinely pass (system-UI settle windows, scroll-inertia floors)
  are correctness bugs when cut short, so they get their own API instead
  of the device clock.

## 0.1.1

### Added

- The npm tarball now ships `src/` alongside `dist/`, so the existing
  declaration maps resolve into real TypeScript source — editors land
  go-to-definition in `.ts`, not `.d.ts`, from a plain npm install.

### Changed

- Index-signature reads in the accessibility-tree normalization use bracket
  access. No behavior change; the source now also compiles cleanly for
  consumers who type-check it under stricter flags (for example
  `noPropertyAccessFromIndexSignature`).

## 0.1.0

### Added

- Promise-based `Device` and strict, chainable accessibility locators over the
  AXe iOS Simulator CLI.
- Vitest fixture and matcher integration, fixture-backed testing, structured
  failure evidence, and consumer-owned lifecycle hooks.
- Named multi-device leases and a public React Native two-simulator delivery
  proof.
- Optional shell-free simulator-control interfaces, an explicit biometric
  support boundary, and a read-only AXe environment diagnostic.
- Supported AXe version policy and public SwiftUI/React Native compatibility
  proofs.
