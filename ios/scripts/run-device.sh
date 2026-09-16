#!/bin/bash
# Build, install, and stream diagnostics from a paired physical iPad/iPhone.
# Usage: bash ios/scripts/run-device.sh "Not your iPad"
set -euo pipefail
device="${1:?Usage: bash ios/scripts/run-device.sh <device-name-or-id>}"
project_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$project_root"
umask 077
mkdir -p .logs
stamp="$(date +%Y%m%d-%H%M%S)"
build_log="$project_root/.logs/ios-build-$stamp.log"
capture_log="$project_root/.logs/ios-device-$stamp.log"

echo "Building Skuzic; build output: $build_log"
if ! xcodebuild -project ios/Skuzic.xcodeproj -scheme Skuzic \
    -configuration Debug -destination 'generic/platform=iOS' \
    -derivedDataPath ios/DerivedData build > "$build_log" 2>&1; then
    tail -n 40 "$build_log"
    exit 1
fi

xcrun devicectl device install app --device "$device" \
    ios/DerivedData/Build/Products/Debug-iphoneos/Skuzic.app

echo "Launching Skuzic; capture: $capture_log"
echo "Open a sketch and draw. Ctrl-C stops the capture and running app."
xcrun devicectl device process launch --device "$device" \
    --terminate-existing --console \
    --environment-variables '{"SKUZIC_DIAGNOSTICS_STDOUT":"1"}' \
    com.incubious.skuzic 2>&1 | tee "$capture_log"
