#!/usr/bin/env bash
# start.sh — sobe o LearnHarness e o laço de backup (postStartCommand: roda a
# cada início do Codespace). Se já estiverem rodando, não faz nada.
#
# O servidor escuta só em 127.0.0.1:3000; o Codespaces encaminha a porta como
# PRIVADA (só abre logado na sua conta do GitHub). Nunca a torne pública: o
# modo navegador do LearnHarness não tem login.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${LH_STATE_DIR:-/workspaces/.lh}"
SERVER_DIR="$STATE_DIR/server"
LOG_DIR="$STATE_DIR/logs"
BACKUP_EVERY=900 # segundos (15 min)

export LH_DATA_DIR="${LH_DATA_DIR:-/workspaces/learnharness-data}"
export LH_AUTH_FILE="${LH_AUTH_FILE:-$STATE_DIR/auth.json}"
export PATH="$HOME/.local/bin:$PATH"
set -a
# shellcheck source=/dev/null
[ -f "$STATE_DIR/runtime.env" ] && . "$STATE_DIR/runtime.env"
set +a

mkdir -p "$LOG_DIR"

running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

if [ ! -f "$SERVER_DIR/server.js" ]; then
	echo "Servidor ainda não instalado: rode bash deploy/codespaces/setup.sh" >&2
	exit 1
fi

if running "$STATE_DIR/server.pid"; then
	echo "LearnHarness já está rodando."
else
	# setsid: o processo sobrevive ao fim do comando de ciclo de vida. O PID é
	# gravado pelo próprio processo antes do exec (o $! do shell não é confiável
	# com setsid).
	# shellcheck disable=SC2016 # expandem no bash interno, de propósito
	(cd "$SERVER_DIR" && NODE_ENV=production HOSTNAME=127.0.0.1 PORT="${PORT:-3000}" \
		setsid bash -c 'echo $$ >"$1"; exec node server.js' _ "$STATE_DIR/server.pid" \
		>>"$LOG_DIR/server.log" 2>&1 </dev/null &)
	echo "LearnHarness iniciado (log: $LOG_DIR/server.log)."
fi

if running "$STATE_DIR/backup.pid"; then
	echo "Backup automático já está rodando."
else
	# A primeira volta já envia o que tiver ficado pendente da última sessão.
	# shellcheck disable=SC2016 # expandem no bash interno, de propósito
	setsid bash -c 'echo $$ >"$1"; while true; do bash "$2" || true; sleep "$3"; done' \
		_ "$STATE_DIR/backup.pid" "$DEPLOY_DIR/../oracle/backup.sh" "$BACKUP_EVERY" \
		>>"$LOG_DIR/backup.log" 2>&1 </dev/null &
	echo "Backup automático a cada $((BACKUP_EVERY / 60)) min (log: $LOG_DIR/backup.log)."
fi
