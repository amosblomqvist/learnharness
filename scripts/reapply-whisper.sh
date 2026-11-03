#!/usr/bin/env bash
# reapply-whisper.sh — put local Whisper dictation back after a LearnHarness
# update (local-whisper branch). Run from Git Bash with the app CLOSED:
#
#   bash scripts/reapply-whisper.sh
#
# 1. reads the installed app version
# 2. rebases the local-whisper branch onto that release tag (git does the
#    3-way merge; a conflict stops here with the repo left clean)
# 3. installs deps, typechecks, runs the dictation tests, builds
# 4. backs up the installed server and swaps the new build in
#
# The whisper binary/model in %APPDATA%\LearnHarness\data\whisper and the
# engine choice survive updates on their own — only the app code is redone.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${LH_INSTALL_DIR:-$LOCALAPPDATA/Programs/learnharness}"
SERVER="$APP/resources/server"
INSTALLED="$SERVER/standalone"

die() { echo "reapply-whisper: $*" >&2; exit 1; }

[ -f "$INSTALLED/package.json" ] || die "no installed app at $APP (set LH_INSTALL_DIR)"
VERSION="$(node -p "require(process.argv[1]).version" "$INSTALLED/package.json")"
echo "Installed LearnHarness: $VERSION"

if [ -d "$INSTALLED/app/api/stt/whisper" ] && [ "${1:-}" != "--force" ]; then
	echo "The installed app already has local Whisper — nothing to do (--force rebuilds anyway)."
	exit 0
fi

if tasklist //FI "IMAGENAME eq LearnHarness.exe" 2>/dev/null | grep -qi learnharness.exe; then
	die "LearnHarness is running — quit it first."
fi

cd "$REPO"
git checkout -q -- next-env.d.ts 2>/dev/null || true # `next build` rewrites it
[ -z "$(git status --porcelain)" ] || die "uncommitted changes in $REPO — commit or stash them first."
git switch -q local-whisper
git fetch -q --tags origin
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || die "no upstream tag v$VERSION yet."

if git merge-base --is-ancestor "v$VERSION" HEAD; then
	echo "local-whisper already sits on v$VERSION."
else
	echo "Rebasing local-whisper onto v$VERSION…"
	if ! git rebase -q "v$VERSION"; then
		git rebase --abort
		die "upstream changed the same lines — rebase conflict, left untouched. Resolve by hand (or ask Claude)."
	fi
fi

echo "Installing dependencies…"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error
echo "Typechecking…"
npx tsc --noEmit
echo "Testing dictation…"
NODE_ENV=test npx tsx --test tests/*dictation*.test.ts tests/*dictation*.test.tsx tests/zero-keys.test.tsx
echo "Building…"
rm -rf .next
npx next build >/dev/null
node scripts/build-server.mjs

echo "Installing into $INSTALLED…"
rm -rf "$SERVER"/standalone.backup-*
mv "$INSTALLED" "$SERVER/standalone.backup-$VERSION"
cp -r .next/standalone "$INSTALLED"
echo "Done — local Whisper is back in LearnHarness $VERSION (original kept in standalone.backup-$VERSION)."
