# Compatibility policy

The current supported AXe version is **1.7.1**. `diagnoseAxe()` treats another
version as unsupported by default while continuing its independent simulator
and accessibility diagnostics. A controlled rollout can pass
`supportedVersions` explicitly while fixtures and end-to-end tests are being
validated.

## Validated public matrix

| Component | Validated version |
| --- | --- |
| AXe | 1.7.1 |
| Xcode | 26.6 (17F113) |
| iOS Simulator runtime | 26.5 |
| Public simulator devices | iPhone 17, iPhone 17 Pro |
| React Native sample | 0.83.0 |

This is an evidence-based support policy, not a promise that nearby versions
behave identically. Add a provenance-tagged capture and run the gated e2e suite
before extending the supported version list.
