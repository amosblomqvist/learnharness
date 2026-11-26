#!/usr/bin/env bash
# Bootstrap the Linux checkout without requiring Node, npm, or administrator access.
#
# Usage: bootstrap-linux.sh [restart] [--install-only] [--register] [--pause-on-error]
set -euo pipefail

scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
workspace="$(dirname "$scripts")"
command=""
install_only=0
register=0
pause_on_error=0
cleanup_stage=""
for argument in "$@"; do
	case "$argument" in
		restart) command="restart" ;;
		--install-only) install_only=1 ;;
		--register) register=1 ;;
		--pause-on-error) pause_on_error=1 ;;
		*) echo "[launcher] Usage: learn [restart]" >&2; exit 1 ;;
	esac
done

fail() {
	echo "[launcher] $1" >&2
	echo "[launcher] Setup could not complete. Check your internet connection and the error above, then launch again." >&2
	exit 1
}

finish() {
	local status=$?
	if [ -n "$cleanup_stage" ]; then rm -rf -- "$cleanup_stage"; fi
	if [ "$status" -ne 0 ] && [ "$pause_on_error" -eq 1 ]; then
		echo
		echo "LearnHarness could not finish successfully. See the error above."
		printf "Press Enter to close."
		read -r _ || true
	fi
	exit "$status"
}
trap finish EXIT

# Prints the Node.js version when the bin directory holds a usable Node 26 with npm.
test_node_installation() {
	local bin="$1" node npm_cli npm_manifest version npm_version
	node="$bin/node"
	npm_cli="$bin/../lib/node_modules/npm/bin/npm-cli.js"
	npm_manifest="$bin/../lib/node_modules/npm/package.json"
	[ -f "$node" ] && [ -x "$node" ] && [ -f "$npm_cli" ] && [ -f "$npm_manifest" ] || return 1
	version="$("$node" --version 2>/dev/null)" || return 1
	[[ "$version" =~ ^v26\.[0-9]+\.[0-9]+$ ]] || return 1
	# Reading npm's manifest avoids starting a second Node.js process on every launch.
	npm_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$npm_manifest" | head -n 1)"
	[[ "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
	printf '%s\n' "$version"
}

# Refuse paths outside the runtime folder, or reached through a symbolic link.
assert_managed_path() {
	local target="$1" current
	case "$target/" in
		"$runtime_root"/*) ;;
		*) fail "Refusing to modify a path outside the LearnHarness runtime folder: $target" ;;
	esac
	current="$target"
	while [ "${#current}" -ge "${#data_home}" ]; do
		if [ -L "$current" ]; then fail "Refusing a redirected LearnHarness runtime path: $current"; fi
		[ "$current" = "/" ] && break
		current="$(dirname "$current")"
	done
}

install_node_runtime() {
	local architecture="$1" destination="$2" checksums archive_name version base_url expected stage archive candidate backup=""
	echo "[launcher] Node.js 26 with npm is needed. Installing it for your Linux account..."
	echo "[launcher] Runtime folder: $destination"
	for tool in curl tar xz sha256sum; do
		command -v "$tool" >/dev/null 2>&1 || fail "$tool is required to install Node.js. Install it with your package manager."
	done
	mkdir -p "$runtime_root"
	assert_managed_path "$runtime_root"
	stage="$(mktemp -d "$runtime_root/setup-XXXXXXXXXX")"
	cleanup_stage="$stage"
	assert_managed_path "$stage"
	checksums="$stage/SHASUMS256.txt"
	curl -fsSL --max-time 30 -o "$checksums" "https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt" ||
		fail "Could not download the Node.js 26 release list from nodejs.org."
	archive_name="$(sed -n "s/^[0-9a-fA-F]\{64\}[[:space:]]\+\(node-v26\.[0-9]\+\.[0-9]\+-linux-$architecture\.tar\.xz\)\$/\1/p" "$checksums" | head -n 1)"
	[ -n "$archive_name" ] || fail "No official Node.js 26 Linux $architecture release was found."
	version="${archive_name#node-}"
	version="${version%%-linux-*}"
	expected="$(sed -n "s/^\([0-9a-fA-F]\{64\}\)[[:space:]]\+${archive_name//./\\.}\$/\1/p" "$checksums" | head -n 1)"
	base_url="https://nodejs.org/dist/$version"
	archive="$stage/$archive_name"
	echo "[launcher] Downloading Node.js $version with npm from nodejs.org..."
	curl -fsSL --max-time 180 -o "$archive" "$base_url/$archive_name" || fail "Could not download Node.js $version."
	if [ "$(sha256sum "$archive" | cut -d ' ' -f 1)" != "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ]; then
		fail "The Node.js download failed its SHA-256 check. Nothing was installed. Try launching again."
	fi
	mkdir "$stage/unpacked"
	tar -xJf "$archive" -C "$stage/unpacked" --no-same-owner || fail "The Node.js download could not be unpacked."
	candidate="$stage/unpacked/${archive_name%.tar.xz}"
	test_node_installation "$candidate/bin" >/dev/null || fail "The downloaded Node.js/npm installation could not be verified."

	assert_managed_path "$candidate"
	assert_managed_path "$destination"
	if [ -e "$destination" ]; then
		backup="$stage/previous"
		mv -- "$destination" "$backup"
	fi
	if ! mv -- "$candidate" "$destination"; then
		if [ -n "$backup" ]; then mv -- "$backup" "$destination"; fi
		fail "The Node.js runtime could not be moved into place."
	fi
	rm -rf -- "$stage"
	cleanup_stage=""
	echo "[launcher] Installed Node.js $version and npm."
}

node_bin=""
node_version=""
IFS=: read -r -a path_entries <<< "${PATH:-}"
for entry in "${path_entries[@]}"; do
	[ -n "$entry" ] && [ -x "$entry/node" ] || continue
	real_bin="$(dirname "$(readlink -f "$entry/node")")"
	if node_version="$(test_node_installation "$real_bin")"; then node_bin="$real_bin"; break; fi
done

if [ -z "$node_bin" ]; then
	[ -n "${HOME:-}" ] || fail "The HOME folder could not be found."
	data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
	case "$data_home" in /*) ;; *) fail "XDG_DATA_HOME must be an absolute path." ;; esac
	data_home="${data_home%/}"
	runtime_root="$data_home/LearnHarness/runtime"
	case "$(uname -m)" in
		x86_64|amd64) architecture="x64" ;;
		aarch64|arm64) architecture="arm64" ;;
		*) fail "Node.js 26 requires 64-bit Linux (x64 or ARM64); found $(uname -m)." ;;
	esac
	command -v flock >/dev/null 2>&1 || fail "flock is required. Install util-linux with your package manager."
	node_bin="$runtime_root/node26-$architecture/bin"
	assert_managed_path "$runtime_root/node26-$architecture"
	assert_managed_path "$node_bin/node"
	mkdir -p "$runtime_root"
	assert_managed_path "$runtime_root"
	exec 9>"$runtime_root/.setup.lock"
	flock -w 600 9 || fail "Another LearnHarness Node.js setup is still in progress."
	if ! node_version="$(test_node_installation "$node_bin")"; then
		install_node_runtime "$architecture" "$runtime_root/node26-$architecture"
		node_version="$(test_node_installation "$node_bin")" || fail "The installed Node.js/npm runtime could not be verified."
	fi
	exec 9>&-
fi

npm_cli="$(readlink -f "$node_bin/../lib/node_modules/npm/bin/npm-cli.js")"
export PATH="$node_bin:$PATH"
echo "[launcher] Using $node_version with npm from $node_bin"
if [ "$install_only" -eq 1 ]; then exit 0; fi

export npm_execpath="$npm_cli"
cd "$workspace"
launch=("$node_bin/node" "$scripts/launch-checkout-desktop.mjs")
if [ -n "$command" ]; then launch+=("$command"); fi
"${launch[@]}"

if [ "$register" -eq 1 ]; then
	bash "$scripts/register-linux-launcher.sh" "$scripts/bootstrap-linux.sh" ||
		{ echo "[launcher] Could not set up the learn command." >&2; exit 1; }
fi
