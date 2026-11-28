#!/usr/bin/env bash
# Roda na criação do Codespace (e a cada Rebuild): clona o repo de dados, cria
# o atalho ~/sources (as ferramentas do agente resolvem caminhos relativos a
# partir da home — src/agent/tools/fs-shared.ts), instala as dependências, o
# Claude Code (provedor claude-code do settings.json) e o Chromium que os
# sub-agentes usam para verificar demos (src/agent/subagents/headless.ts).
set -euo pipefail

DATA_DIR="${LH_DATA_DIR:-/workspaces/learnharness-data}"
DATA_REPO_URL="${DATA_REPO_URL:-https://github.com/GabrielSartoriMosquer/learnharness-data.git}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-/workspaces/.lh/claude}"
PLAYWRIGHT_VERSION=1.63.0

if [ ! -d "$DATA_DIR/.git" ]; then
	git clone "$DATA_REPO_URL" "$DATA_DIR"
else
	echo "Repo de dados já existe em $DATA_DIR"
fi

ln -sfn "$DATA_DIR/sources" "$HOME/sources"
echo "Atalho: $HOME/sources -> $DATA_DIR/sources"

# Login do Claude Code fora da home, para sobreviver a um Rebuild.
mkdir -p "$CLAUDE_DIR" 2>/dev/null || { sudo mkdir -p "$CLAUDE_DIR" && sudo chown -R "$(id -u):$(id -g)" "$(dirname "$CLAUDE_DIR")"; }
chmod 700 "$CLAUDE_DIR"

if [ "${SKIP_INSTALL:-}" != "1" ]; then
	npm ci
	if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
		curl -fsSL https://claude.ai/install.sh | bash
	fi

	# Chromium via Playwright (num prefixo próprio, fora do projeto), ligado em
	# /usr/bin/chromium — um dos caminhos que o app procura —, para valer em
	# qualquer terminal ou processo.
	CHROMIUM_DIR="$HOME/.local/share/learnharness-chromium"
	mkdir -p "$CHROMIUM_DIR"
	npm install --prefix "$CHROMIUM_DIR" --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION"
	(cd "$CHROMIUM_DIR" && npx playwright install --with-deps chromium)
	CHROME="$(cd "$CHROMIUM_DIR" && node -e 'console.log(require("playwright").chromium.executablePath())')"
	if [ -x "$CHROME" ]; then
		sudo ln -sfn "$CHROME" /usr/bin/chromium
		echo "Chromium: /usr/bin/chromium -> $CHROME"
	else
		echo "Aviso: Chromium não encontrado; demos não serão verificados." >&2
	fi

	echo "Rode 'claude' uma vez no terminal para fazer login."
fi
