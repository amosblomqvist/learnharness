#!/usr/bin/env bash
# update.sh — atualiza o LearnHarness da máquina a partir do seu fork.
#
#   bash ~/learnharness/deploy/oracle/update.sh            # git pull + build + troca
#   bash ~/learnharness/deploy/oracle/update.sh --no-pull  # só build + troca (install.sh usa)
#
# O build acontece no clone (~/learnharness) enquanto o app atual continua
# rodando de ~/learnharness-server. Só quando o build e o teste de fumaça
# passam a versão nova entra no lugar; se ela não responder depois de
# reiniciar, a anterior volta sozinha.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$HOME/learnharness-server"
ENV_FILE="$HOME/.config/learnharness/learnharness.env"
SERVICE=learnharness

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

health() {
	local port
	port="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
	port="${port:-3000}"
	for _ in $(seq 1 60); do
		if curl -fsS -o /dev/null "http://127.0.0.1:$port/"; then return 0; fi
		sleep 1
	done
	return 1
}

swap_in() {
	rm -rf "$SERVER_DIR.prev"
	if [ -d "$SERVER_DIR" ]; then mv "$SERVER_DIR" "$SERVER_DIR.prev"; fi
	mv "$SERVER_DIR.new" "$SERVER_DIR"
}

if ! systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
	# Primeira instalação: o serviço ainda não existe (install.sh o cria depois).
	swap_in
	say "Versão instalada em $SERVER_DIR"
	exit 0
fi

say "Trocando de versão (o app fica fora do ar por alguns segundos)"
sudo systemctl stop "$SERVICE"
swap_in
sudo systemctl start "$SERVICE"

if health; then
	say "Pronto: versão $(git rev-parse --short HEAD) no ar."
	exit 0
fi

echo "A versão nova não respondeu. Voltando para a anterior..." >&2
sudo journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
if [ -d "$SERVER_DIR.prev" ]; then
	sudo systemctl stop "$SERVICE"
	rm -rf "$SERVER_DIR.failed"
	mv "$SERVER_DIR" "$SERVER_DIR.failed"
	mv "$SERVER_DIR.prev" "$SERVER_DIR"
	sudo systemctl start "$SERVICE"
	if health; then
		echo "A versão anterior voltou ao ar. A que falhou ficou em $SERVER_DIR.failed." >&2
	else
		echo "Nem a versão anterior respondeu. Veja: sudo journalctl -u $SERVICE -n 100" >&2
	fi
fi
exit 1
