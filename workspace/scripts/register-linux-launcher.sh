#!/usr/bin/env bash
# Install ~/.local/bin/learn, which runs this checkout's Linux bootstrap from any folder.
#
# Usage: register-linux-launcher.sh <absolute path to bootstrap-linux.sh>
set -euo pipefail

marker="# LearnHarness source checkout launcher"
bootstrap="${1:?Usage: register-linux-launcher.sh <bootstrap-linux.sh>}"
case "$bootstrap" in /*) ;; *) echo "[launcher] The bootstrap path must be absolute: $bootstrap" >&2; exit 1 ;; esac
[ -n "${HOME:-}" ] || { echo "[launcher] The HOME folder could not be found." >&2; exit 1; }
bin_directory="$HOME/.local/bin"
shim="$bin_directory/learn"

if [ -e "$shim" ] || [ -L "$shim" ]; then
	if [ -L "$shim" ] || [ ! -f "$shim" ] || ! grep -qxF "$marker" "$shim"; then
		echo "[launcher] A different launcher already uses $shim." >&2
		exit 1
	fi
fi

# Single-quote the checkout path so spaces and shell characters stay literal.
quoted="'${bootstrap//\'/\'\\\'\'}'"
contents="#!/bin/sh
$marker
exec bash $quoted \"\$@\""

if [ ! -f "$shim" ] || [ "$(cat "$shim")" != "$contents" ]; then
	mkdir -p "$bin_directory"
	temporary="$(mktemp "$bin_directory/.learn.XXXXXXXXXX")"
	printf '%s\n' "$contents" > "$temporary"
	chmod 755 "$temporary"
	mv -f -- "$temporary" "$shim"
fi

case ":${PATH:-}:" in
	*":$bin_directory:"*) ;;
	*) echo "[launcher] Add $bin_directory to your PATH to launch LearnHarness with learn." ;;
esac
