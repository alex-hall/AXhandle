# React Native integration sample app

This public app is a deliberately small accessibility surface for the AXe
TypeScript live end-to-end suite. It mirrors the SwiftUI integration sample’s
composer, input, button, toggle, and details-flow contract while exercising
React Native’s iOS accessibility bridge.

It is not part of the published `axhandle` package. Default library tests
remain simulator-free.

The sample currently uses React Native 0.83 because it supports the repository's
Node 24.0 runtime. Its Podfile scopes an Xcode 26 compatibility setting to the
legacy `fmt` pod; remove it when upgrading to a React Native release with
`fmt` 12.1.0 or newer.

Install JavaScript dependencies from the workspace root, then provision iOS
dependencies once:

```sh
npm install
npm run react-native-app:pods
```

Build it with `npm run build:react-native-app`. To install and launch the
release build on a booted simulator, provide its UDID:

```sh
SIMULATOR_UDID=<udid> npm run react-native-app:install
```

For the public multi-device end-to-end flow, install and launch the same
release build on two booted simulators. The root `test:e2e` command
starts a host-only relay, selects Alice and Bob in the separate app instances,
and verifies delivery with ordinary AXe accessibility assertions. No external
network or credentials are used.
