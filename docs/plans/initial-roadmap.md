# AXe TypeScript initial roadmap

## Purpose

Build a public, TypeScript-first and promise-based testing harness on top of
the AXe iOS Simulator CLI. The developer experience should feel familiar to
Capybara/Cypress users while retaining ordinary `async`/`await` semantics and
supporting multiple independent simulators.

This is a living plan. Update the checkboxes and the progress snapshot when a
milestone changes state.

## Progress snapshot

| Area | Status | Notes |
| --- | --- | --- |
| Project safety and public boundaries | Complete | `Agent.MD` prohibits private fixtures and app information. |
| TypeScript package scaffold | Complete | Node 24, TypeScript, Vitest, build, and typecheck are configured. |
| AXe CLI boundary | In progress | `describe-ui`, tap, type, key-combo, screenshot, and a read-only diagnostic preflight are typed; supported-version policy and remaining primitives are pending. |
| Locator model | In progress | Strict, scoped `findBy…` locators and ordinal selection work; richer query types are pending. |
| Vitest integration | In progress | Typed device fixture and async matchers work; artifact reporting is pending. |
| Fixture-based testing | In progress | Versioned synthetic JSON fixtures plus provenance-tagged React Native and SwiftUI captures work; broader corpus is pending. |
| Real-simulator end-to-end coverage | In progress | Public SwiftUI and React Native sample apps share a small control contract; opt-in React Native cases validate both a single app and a real Alice-to-Bob flow across two simulators. |

## Design decisions already made

- Vitest is the test runner.
- All public operations are normal, typed promises. There is no Cypress-style
  command queue.
- AXe is isolated behind a typed driver adapter.
- Locator construction is synchronous and side-effect free; actions and
  assertions execute when awaited.
- Locator resolution is strict by default. Positional selection is explicit:
  `first()`, `second()`, `third()`, or `nth()`.
- Scoped locators are a v1 feature: `device.findByTestId("body").findByText(...)`.
- Actions and assertions poll semantic UI state; the high-level API does not
  expose a manual sleep primitive.
- Consumer code owns application-specific simulator provisioning, identities,
  network setup, and cleanup. The core provides lifecycle hooks only.
- The default test suite must run without a booted simulator.

## Milestone 0 — foundation

Status: complete.

- [x] Create public-project safety rules.
- [x] Configure TypeScript, Vitest, Node version, build, and typecheck.
- [x] Create a shell-free typed AXe CLI adapter.
- [x] Create a typed `Device` facade with per-device command serialization.
- [x] Implement fixture driver and versioned JSON fixture envelope.
- [x] Add strict chainable locators, action waiting, and ordinal selection.
- [x] Add `type()` and verified `fill()` semantics.
- [x] Add initial async matchers: visibility, enabled state, text, value, and count.
- [x] Add command logs and an explicit screenshot primitive.
- [x] Establish small, passing commits and a local Git history.

## Milestone 1 — failure evidence and matcher completeness

Status: in progress.

Goal: make failures actionable without requiring a simulator expert to inspect
raw AXe output manually.

- [x] Define public artifact types for command logs, normalized/raw trees, and
  screenshots. Video remains intentionally deferred.
- [x] Add a consumer-provided artifact sink; do not impose a CI vendor or UI.
- [x] Capture configured evidence when a Vitest test fails while preserving the
  original assertion failure if cleanup also fails. Broader reset/release
  failure coverage remains in the multi-device lifecycle milestone.
- [x] Add matcher coverage for hidden/visible, enabled/disabled, text, value,
  and count including `.not` semantics.
- [x] Improve strict-locator errors with scoped accessibility paths and useful
  query-refinement suggestions.
- [x] Document timeout precedence: library default, Vitest test deadline, and
  per-action/per-assertion override.

Acceptance criteria:

- A fixture test can intentionally fail and produce a structured evidence
  bundle without obscuring the original error.
- The default reporter output identifies the locator, expected condition,
  observed candidates, and evidence locations.

## Milestone 2 — locator and interaction surface

Status: planned.

Goal: support the common native UI interactions needed for useful end-to-end
flows while keeping the public API small and unsurprising.

- [x] Validate scoped locator behavior against a real AXe accessibility tree:
  both current public SwiftUI and React Native samples flatten their visual
  `composer` region into sibling accessibility elements, so descendant scoping
  is unavailable for that shape. A separate visual-region contract is a future
  design decision; the core remains hierarchy-strict.
- [x] Define accessibility-role normalization and document its supported role
  names and framework differences from the public captures.
- [ ] Add intentional query refinements only where fixtures prove a need
  (partial text, regular expressions, ancestor/descendant relationships).
- [ ] Add native interactions behind the driver boundary: swipe, drag, scroll,
  slider, hardware buttons, and key sequences. `check()` and `uncheck()` now
  provide state-aware switch/checkbox interaction through the existing tap
  primitive.
- [ ] Decide and document unsupported or unreliable input cases, especially
  secure fields and non-US HID characters.
- [ ] Add focused action options rather than global mutable configuration.

Acceptance criteria:

- Every new public locator/action has fixture-driver coverage and a clear AXe
  primitive mapping.
- Ambiguous controls fail safely rather than selecting a surprising target.

## Milestone 3 — AXe compatibility and simulator integrations

Status: planned.

Goal: make environmental failures legible and keep Xcode-specific concerns out
of the portable core.

- [x] Add a `doctor` capability that checks the configured AXe binary and
  version, booted simulator, accessibility-tree read, and optional screenshot
  path. A supported-version policy remains to be chosen.
- [ ] Pin and document the supported AXe/Xcode compatibility matrix.
- [ ] Define an optional simulator-control integration boundary for app launch,
  installation, termination, erase/reset, and permission setup.
- [ ] Define an optional biometric/system-event integration boundary. Face ID
  match/non-match must not be silently treated as an AXe core feature.
- [ ] Ensure all process execution is shell-free and reports stdout/stderr with
  useful context.

Acceptance criteria:

- A bad AXe path, incompatible version, unbooted simulator, and malformed UI
  response each produce distinct actionable errors.
- Core users can bring their own simulator lifecycle implementation.

## Milestone 4 — real-simulator end-to-end suite

Status: planned.

Goal: prove the fixture model against a small, wholly public test application.

- [x] Create a purpose-built public SwiftUI integration sample app, kept in the
  same workspace but outside the published package artifact.
- [x] Create a separate public React Native sample app with a bare iOS target
  to validate the React Native accessibility bridge independently of SwiftUI.
- [ ] Build a minimal native control corpus: nested accessibility container,
  text field, button, toggle, navigation, and alert.
- [ ] Capture a provenance-tagged corpus from UIKit, SwiftUI, and nested
  accessibility containers. React Native and SwiftUI initial-state captures are
  committed; UIKit and deeper nesting remain.
- [ ] Add opt-in end-to-end tests for inspect, nested locator resolution, tap,
  type, fill, switch/toggle, screenshot, and orientation. Semantic role/name
  resolution, fill, tap, navigation, reset hooks, and an Alice-to-Bob
  two-simulator message delivery are covered for React Native; descendant
  resolution remains blocked by the flattened AXe tree.
- [x] Run end-to-end tests only when explicit environment variables provide a
  supported AXe binary and simulator UDID.
- [ ] Record the AXe, Xcode, runtime, device, and orientation for every captured
  fixture. The React Native and SwiftUI captures record all five; future
  captures must too.

Acceptance criteria:

- Default CI remains simulator-free and fast.
- A separately gated job catches AXe/Xcode behavior drift before a release.

## Milestone 5 — multi-device orchestration and release readiness

Status: planned.

Goal: support portable multi-device test suites without introducing hidden
shared state.

- [x] Define device-provider and allocation contracts for named devices.
- [x] Ensure each device serializes its own commands while separate devices can
  run concurrently through ordinary `Promise.all`; a gated React Native
  Alice-to-Bob flow exercises two physical simulators.
- [ ] Add lifecycle tests for reset failures, test failures, and cleanup error
  preservation.
- [ ] Add package metadata, API documentation, examples, changelog, and a
  license chosen by the maintainers.
- [ ] Decide publishing ownership, package name availability, and release
  automation before publishing anything.

Acceptance criteria:

- A two-device fixture scenario can run concurrently without cross-device
  command interference.
- No private data, captured private UI trees, or internal application flows are
  required for documentation or tests.

## Current risks and discovery work

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Accessibility tree flattening | AXe currently flattens the public SwiftUI and React Native sample’s visual `composer` region into sibling elements, so descendant scoping cannot work there. | Keep ordinary scoping hierarchy-strict; consider an explicitly named, frame-based visual-region feature only after defining its safety contract. |
| AXe uses private simulator infrastructure | Xcode/runtime changes can alter behavior. | Pin compatibility, add doctor checks, and keep gated end-to-end tests. |
| Native/system UI | Face ID, permissions, and system dialogs are not ordinary application accessibility targets. | Use optional Xcode/simulator-control integrations with explicit support boundaries. |
| Over-eager abstraction | Premature caching, batching, and broad selectors can make failures opaque. | Start with fresh tree reads and fixture-backed evidence; optimize only from measurements. |
| State leakage | Reused simulators carry persisted app and OS state. | Keep reset consumer-owned, always run lifecycle cleanup, and add explicit device-provider contracts. |

## Near-term order of work

The original first vertical slice is complete: fixture-backed coverage, public
SwiftUI/React Native samples, a diagnostic preflight, and a gated real
Alice-to-Bob two-simulator React Native flow are all in place.

1. **Lifecycle hardening.** Add a lower-level test seam for reset, evidence,
   and provider-release failures; verify that cleanup always runs and the
   original test failure remains primary.
2. **Optional simulator and system boundaries.** Define an injected,
   shell-free simulator-control adapter for install, launch, termination,
   erase/reset, and permissions. Define a separate biometric/system-event
   adapter for Face ID enrollment, match, and non-match; neither belongs in the
   AXe core driver.
3. **Compatibility policy.** Record the currently validated AXe 1.7.1 / Xcode
   26.6 / iOS 26.5 combination and decide how `diagnoseAxe` reports supported
   versus merely detected versions.
4. **Fixture-led expansion.** Add live SwiftUI coverage, then screenshot,
   orientation, alert, UIKit, and deeper-container cases only when a public
   capture demonstrates a needed interaction. Do not add broad query
   refinements or gestures speculatively.
5. **Release readiness.** Complete API documentation and examples, choose a
   license and publishing owner, then add changelog and release automation.
