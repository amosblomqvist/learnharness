#!/usr/bin/env bash
# update.sh — atualiza o LearnHarness do Codespace a partir do seu fork.
#
#   bash deploy/codespaces/update.sh            # git pull + build + troca
#   bash deploy/codespaces/update.sh --no-pull  # só build + troca (setup.sh usa)
#
# O build acontece no clone enquanto o app atual continua rodando de
# /workspaces/.lh/server. Só quando o build e o teste de fumaça passam a versão
# nova entra no lugar; se ela não responder, a anterior volta sozinha.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
STATE_DIR="${LH_STATE_DIR:-/workspaces/.lh}"
SERVER_DIR="$STATE_DIR/server"
PID_FILE="$STATE_DIR/server.pid"

pull=1
for arg in "$@"; do
	case "$arg" in
		--no-pull) pull=0 ;;
		*) echo "uso: $0 [--no-pull]" >&2; exit 2 ;;
	esac
done

say() { printf '\n==> %s\n' "$*"; }

cd "$REPO_DIR"

if [ "$pull" = 1 ]; then
	say "Baixando a versão mais nova do seu fork"
	before="$(git rev-parse --short HEAD)"
	git pull --ff-only
	after="$(git rev-parse --short HEAD)"
	if [ "$before" = "$after" ]; then
		echo "Nada novo no fork ($after). Refazendo o build mesmo assim."
	else
		git log --oneline "$before..$after"
	fi
fi

say "Instalando dependências"
# O Electron só serve ao app desktop; não baixar o binário dele aqui.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund

say "Fazendo o build (pode levar alguns minutos)"
rm -rf .next/standalone
npm run build
node scripts/build-server.mjs

say "Teste de fumaça do servidor novo (dados e chaves descartáveis)"
node scripts/smoke-server.mjs

say "Preparando a versão nova"
rm -rf "$SERVER_DIR.new"
cp -a .next/standalone "$SERVER_DIR.new"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

stop_server() {
	if running; then
		local pid
		pid="$(cat "$PID_FILE")"
		kill "$pid"
		for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
		kill -9 "$pid" 2>/dev/null || true
	fi
	rm -f "$PID_FILE"
}

health() {
	for _ in $(seq 1 60); do
		if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3000}/"; then return 0; fi
		sleep 1
	done
	return 1
}

swap_in() {
	rm -rf "$SERVER_DIR.prev"
	if [ -d "$SERVER_DIR" ]; then mv "$SERVER_DIR" "$SERVER_DIR.prev"; fi
	mv "$SERVER_DIR.new" "$SERVER_DIR"
}

if ! running; then
	# Nada no ar (primeira instalação): start.sh sobe o servidor no próximo início.
	swap_in
	say "Versão instalada em $SERVER_DIR"
	exit 0
fi

say "Trocando de versão (o app fica fora do ar por alguns segundos)"
stop_server
swap_in
bash "$DEPLOY_DIR/start.sh" >/dev/null

if health; then
	say "Pronto: versão $(git rev-parse --short HEAD) no ar."
	exit 0
fi

echo "A versão nova não respondeu. Voltando para a anterior..." >&2
tail -n 40 "$STATE_DIR/logs/server.log" >&2 || true
if [ -d "$SERVER_DIR.prev" ]; then
	stop_server
	rm -rf "$SERVER_DIR.failed"
	mv "$SERVER_DIR" "$SERVER_DIR.failed"
	mv "$SERVER_DIR.prev" "$SERVER_DIR"
	bash "$DEPLOY_DIR/start.sh" >/dev/null
	if health; then
		echo "A versão anterior voltou ao ar. A que falhou ficou em $SERVER_DIR.failed." >&2
	else
		echo "Nem a versão anterior respondeu. Veja: $STATE_DIR/logs/server.log" >&2
	fi
fi
exit 1
