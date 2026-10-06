#!/bin/sh
# Native stream/mixer regression tests; runs on macOS without an API key/device.
set -eu
project_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/skuzic-audio-tests.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

xcrun swiftc -swift-version 5 -parse-as-library -warnings-as-errors \
    "$project_root/ios/Skuzic/Core/Types.swift" \
    "$project_root/ios/Skuzic/Core/Reducer.swift" \
    "$project_root/ios/Skuzic/Core/Diagnostics.swift" \
    "$project_root/ios/Skuzic/Audio/PromptMixer.swift" \
    "$project_root/ios/Skuzic/Audio/PlaybackTimeline.swift" \
    "$project_root/ios/Skuzic/Audio/LyriaOutbox.swift" \
    "$project_root/ios/Skuzic/Audio/LyriaStream.swift" \
    "$project_root/test/ios-audio.test.swift" \
    -o "$test_dir/audio-tests"
"$test_dir/audio-tests"

xcrun swiftc -swift-version 5 -parse-as-library -warnings-as-errors \
    "$project_root/ios/Skuzic/Core/Types.swift" \
    "$project_root/ios/Skuzic/Core/Diagnostics.swift" \
    "$project_root/ios/Skuzic/Audio/PromptMixer.swift" \
    "$project_root/ios/Skuzic/Audio/PlaybackTimeline.swift" \
    "$project_root/ios/Skuzic/Audio/LyriaStream.swift" \
    "$project_root/ios/Skuzic/Audio/LyriaEngine.swift" \
    "$project_root/test/ios-engine.test.swift" \
    -o "$test_dir/engine-tests"
"$test_dir/engine-tests"

xcrun swiftc -swift-version 5 -parse-as-library -warnings-as-errors \
    "$project_root/ios/Skuzic/Audio/TouchEngine.swift" \
    "$project_root/test/ios-touch.test.swift" \
    -o "$test_dir/touch-tests"
"$test_dir/touch-tests"

xcrun swiftc -swift-version 5 -parse-as-library -warnings-as-errors \
    "$project_root/ios/Skuzic/Core/Types.swift" \
    "$project_root/ios/Skuzic/Vision/Palette.swift" \
    "$project_root/ios/Skuzic/Vision/Ink.swift" \
    "$project_root/test/ios-palette.test.swift" \
    -o "$test_dir/palette-tests"
"$test_dir/palette-tests" "$project_root"
