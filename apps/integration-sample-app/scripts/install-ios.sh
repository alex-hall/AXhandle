#!/bin/sh
set -eu

if [ -z "${SIMULATOR_UDID:-}" ]; then
  echo "SIMULATOR_UDID must name a booted simulator." >&2
  exit 1
fi

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_path="$root_dir/build/AXhandleSample.app"
bundle_id=dev.axhandle.integration-sample-app

if [ ! -d "$app_path" ]; then
  echo "Build the integration sample app before installing it." >&2
  exit 1
fi

xcrun simctl install "$SIMULATOR_UDID" "$app_path"
xcrun simctl launch "$SIMULATOR_UDID" "$bundle_id"
