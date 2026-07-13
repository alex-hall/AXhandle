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
| AXe CLI boundary | In progress | `describe-ui`, tap, type, key-combo, and screenshot are typed; version checks and remaining primitives are pending. |
| Locator model | In progress | Strict, scoped `findBy…` locators and ordinal selection work; richer query types are pending. |
| Vitest integration | In progress | Typed device fixture and async matchers work; artifact reporting is pending. |
| Fixture-based testing | In progress | Versioned synthetic JSON fixtures plus provenance-tagged React Native and SwiftUI captures work; broader corpus is pending. |
| Real-simulator conformance | In progress | Public SwiftUI and React Native sample apps share a small control contract; an opt-in React Native flow now validates the live AXe bridge. |

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

Status: next.

Goal: make failures actionable without requiring a simulator expert to inspect
raw AXe output manually.

- [ ] Define public artifact types: command log, normalized tree, raw tree,
  screenshot, and optional video.
- [ ] Add a consumer-provided artifact sink; do not impose a CI vendor or UI.
- [ ] Capture configured evidence when a Vitest test fails while preserving the
  original assertion failure if cleanup also fails.
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
- [ ] Define accessibility-role normalization and document its supported role
  names.
- [ ] Add intentional query refinements only where fixtures prove a need
  (partial text, regular expressions, ancestor/descendant relationships).
- [ ] Add native interactions behind the driver boundary: swipe, drag, scroll,
  toggle, slider, hardware buttons, and key sequences.
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

- [ ] Add a `doctor` capability that checks the configured AXe binary, supported
  version range, booted simulator, accessibility-tree read, and screenshot path.
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

## Milestone 4 — real-simulator conformance suite

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
- [ ] Add opt-in conformance tests for inspect, nested locator resolution, tap,
  type, fill, switch/toggle, screenshot, and orientation. Semantic role/name
  resolution, fill, tap, navigation, and reset hooks are covered for React
  Native; descendant resolution remains blocked by the flattened AXe tree.
- [x] Run conformance tests only when explicit environment variables provide a
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

- [ ] Define device-provider and allocation contracts for named devices.
- [ ] Ensure each device serializes its own commands while separate devices can
  run concurrently through ordinary `Promise.all`.
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
| AXe uses private simulator infrastructure | Xcode/runtime changes can alter behavior. | Pin compatibility, add doctor checks, and keep gated conformance tests. |
| Native/system UI | Face ID, permissions, and system dialogs are not ordinary application accessibility targets. | Use optional Xcode/simulator-control integrations with explicit support boundaries. |
| Over-eager abstraction | Premature caching, batching, and broad selectors can make failures opaque. | Start with fresh tree reads and fixture-backed evidence; optimize only from measurements. |
| State leakage | Reused simulators carry persisted app and OS state. | Keep reset consumer-owned, always run lifecycle cleanup, and add explicit device-provider contracts. |

## Near-term order of work

1. Failure evidence and artifact-sink contract.
2. Capture and validate a small public AXe tree corpus for scoped locator
   behavior.
3. Implement only the next interactions justified by that corpus.
4. Add `doctor` and optional simulator-control boundaries.
5. Build and gate the real-simulator conformance suite against the integration
   sample app.
