#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir="$root_dir/build/AXhandleSample.app"
sdk_path=$(xcrun --sdk iphonesimulator --show-sdk-path)
target=${IOS_SIMULATOR_TARGET:-arm64-apple-ios18.0-simulator}

rm -rf "$build_dir"
mkdir -p "$build_dir"

xcrun --sdk iphonesimulator swiftc \
  -parse-as-library \
  -target "$target" \
  -sdk "$sdk_path" \
  -framework SwiftUI \
  -framework UIKit \
  "$root_dir/Sources/AXhandleSampleApp.swift" \
  -o "$build_dir/AXhandleSample"

cp "$root_dir/Info.plist" "$build_dir/Info.plist"
