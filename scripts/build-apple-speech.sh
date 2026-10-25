#!/usr/bin/env bash
# Build the Apple on-device dictation helper (native/apple-speech/main.swift).
# Needs Xcode 26+ (the macOS 26 SDK). The deployment target is the MINIMUM
# macOS version: the binary runs on macOS 26 and later; electron/apple-speech.cjs
# never spawns it on older systems. Non-mac hosts skip the build.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "[apple-speech] not macOS, skipping helper build"
	exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/native/apple-speech/build"
mkdir -p "$out"
xcrun swiftc -O -swift-version 5 \
	-target arm64-apple-macos26.0 \
	-o "$out/apple-speech" \
	"$root/native/apple-speech/main.swift"
echo "[apple-speech] built $out/apple-speech"
