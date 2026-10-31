#!/usr/bin/env bash
# setup.sh — preparação do Codespace (postCreateCommand: roda na criação e a
# cada recriação do contêiner). Instala Claude Code e Chromium, clona o
# repositório privado de dados e faz o build. Pode rodar de novo sem medo.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${LH_STATE_DIR:-/workspaces/.lh}"
DATA_DIR="${LH_DATA_DIR:-/workspaces/learnharness-data}"
AUTH_FILE="${LH_AUTH_FILE:-$STATE_DIR/auth.json}"
DATA_REPO_URL="${LH_DATA_REPO_URL:-https://github.com/${LH_DATA_REPO:?defina LH_DATA_REPO no devcontainer.json}.git}"
CHROMIUM_DIR="$HOME/.local/share/learnharness-chromium"
PLAYWRIGHT_VERSION=1.63.0

say() { printf '\n==> %s\n' "$*"; }

# /workspaces sobrevive a paradas e recriações; o resto do contêiner não.
own_dir() {
	mkdir -p "$1" 2>/dev/null || { sudo mkdir -p "$1" && sudo chown "$(id -u):$(id -g)" "$1"; }
}
own_dir "$STATE_DIR"
chmod 700 "$STATE_DIR"
mkdir -p "$STATE_DIR/logs" "${CLAUDE_CONFIG_DIR:-$STATE_DIR/claude}"

# ─── Claude Code (o login fica em CLAUDE_CONFIG_DIR, dentro de /workspaces) ──
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
	say "Instalando o Claude Code"
	curl -fsSL https://claude.ai/install.sh | bash
fi

# ─── Chromium (demos e renderizações) ────────────────────────────────────────
chrome_path() {
	(cd "$CHROMIUM_DIR" && node -e 'console.log(require("playwright").chromium.executablePath())')
}
if [ ! -x "$(chrome_path 2>/dev/null || true)" ]; then
	say "Instalando o Chromium (via Playwright $PLAYWRIGHT_VERSION)"
	mkdir -p "$CHROMIUM_DIR"
	npm install --prefix "$CHROMIUM_DIR" --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION"
	(cd "$CHROMIUM_DIR" && npx playwright install --with-deps chromium)
fi
printf 'CHROME_PATH=%s\n' "$(chrome_path)" >"$STATE_DIR/runtime.env"

# ─── Repositório privado de dados ────────────────────────────────────────────
if [ ! -d "$DATA_DIR/.git" ]; then
	say "Clonando o repositório de dados"
	own_dir "$(dirname "$DATA_DIR")"
	git clone -q "$DATA_REPO_URL" "$DATA_DIR"
	git -C "$DATA_DIR" config user.name "LearnHarness backup"
	git -C "$DATA_DIR" config user.email "learnharness-backup@codespaces"
	# Decide pela branch main do remoto, não pelo HEAD do clone: se o branch
	# padrão do repositório não for main, o clone vem sem checkout.
	if git -C "$DATA_DIR" rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
		git -C "$DATA_DIR" checkout -q -B main origin/main
	else
		echo "O repositório de dados está vazio: começando do zero."
		echo "(Para trazer o progresso do PC, rode migrate-from-pc.sh ANTES de criar o Codespace.)"
		git -C "$DATA_DIR" checkout -q -b main
		cp "$DEPLOY_DIR/../oracle/data.gitignore" "$DATA_DIR/.gitignore"
		git -C "$DATA_DIR" add -A
		git -C "$DATA_DIR" commit -q -m "backup: início"
		git -C "$DATA_DIR" push -q -u origin main
	fi
fi

# ─── Chaves (as dos segredos do Codespaces chegam como variáveis de ambiente) ─
if [ ! -f "$AUTH_FILE" ]; then
	echo "{}" >"$AUTH_FILE"
	chmod 600 "$AUTH_FILE"
fi

# ─── Build ───────────────────────────────────────────────────────────────────
if [ ! -f "$STATE_DIR/server/server.js" ]; then
	bash "$DEPLOY_DIR/update.sh" --no-pull
fi

say "Preparação concluída"
