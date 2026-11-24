#!/usr/bin/env bash
#
# THE EXACT NEW-USER SIMULATOR (owner, interlude 2026-09-22): one command,
# a fresh instance with zero keys and zero data — setup stage 1, every
# launch. The owner's repeatable first-run BYOK test bed.
#
#   bash scripts/dev-fresh.sh            # http://localhost:3005
#   npm run dev:fresh                    # the same, via package.json
#   scripts/dev-fresh.sh --port 3006    # any port OUTSIDE 3000-3004
#   scripts/dev-fresh.sh --keep         # don't wipe between runs
#                                        (multi-session testing)
#
# WHY A SWITCH, NOT AN ENV SCRUB: a script cannot merely unset shell
# *_API_KEY vars — Next injects .env.local (the dev secrets) into the
# server env at boot, so a "fresh" instance would silently federate the
# real keys. LH_IGNORE_ENV_KEYS=1 (the keys seam, src/server/keys.ts)
# deletes every managed key var from the process after Next's env load:
# pi-ai reads provider keys from process.env NATIVELY at every request,
# so deletion hides keys from the whole app, model engines included.
#
#   LH_DATA_DIR     → .fresh-data/ (wiped each launch unless --keep)
#   LH_AUTH_FILE    → .fresh-data/auth.json (NEVER the repo-root auth.json
#                     — that file may symlink the real keys)
#   LH_IGNORE_ENV_KEYS=1
#
# Safe to rerun. The data dir is disposable scratch — never copy it back.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="3005"
DATA_DIR="$ROOT/.fresh-data"
KEEP=false

usage() {
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--port)
		[ $# -ge 2 ] || { echo "error: --port needs a value" >&2; exit 1; }
		PORT="$2"
		shift 2
		;;
	--port=*)
		PORT="${1#--port=}"
		shift
		;;
	--keep)
		KEEP=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown flag: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
	echo "error: --port must be a number, got \"$PORT\"" >&2
	exit 1
fi
case "$PORT" in
3000 | 3001 | 3002 | 3003 | 3004)
	echo "error: port $PORT is a standing assignment (3000 master, 3001 UI, 3002 graph, 3003 teacher, 3004 platform)" >&2
	echo "       — the fresh instance runs on a dedicated port (default 3005)" >&2
	exit 1
	;;
esac

if [ "$KEEP" != "true" ]; then
	rm -rf "$DATA_DIR"
else
	# --keep preserves prior sessions (multi-session testing); the dir is
	# still created if this is the first run.
	:
fi
mkdir -p "$DATA_DIR"

export LH_DATA_DIR="$DATA_DIR"
export LH_AUTH_FILE="$DATA_DIR/auth.json"
export LH_IGNORE_ENV_KEYS=1
export PORT

echo "── fresh-user instance ─────────────────────────────────"
echo "  URL      : http://localhost:$PORT"
echo "  data dir : $DATA_DIR ($( [ "$KEEP" = "true" ] && echo 'kept across runs' || echo 'wiped next launch unless --keep' ))"
echo "  keys     : env keys hidden (LH_IGNORE_ENV_KEYS=1), auth.json empty"
echo "─────────────────────────────────────────────────────────"

cd "$ROOT"
exec npm run dev
