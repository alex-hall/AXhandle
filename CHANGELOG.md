# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

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
