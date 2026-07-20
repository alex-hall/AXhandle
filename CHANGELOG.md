# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Breaking (0.2.0 API, unadopted)

Nomenclature alignment before these names gathered consumers. 0.2.0
introduced three spellings of the non-strict presence concept and one
misfit duration name; they are unified here as clean breaks (0.2.0 has no
known consumers), and the conventions are now documented in Agent.MD's
"Naming conventions" section.

- `Locator.exists()` is now `Locator.isPresent()` — the *present* family
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
