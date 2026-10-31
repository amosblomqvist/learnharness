#!/usr/bin/env bash
# install.sh — prepara uma máquina Ubuntu (Oracle A1, ARM) para servir o
# LearnHarness aos seus aparelhos. Rode como o usuário normal (ubuntu), não
# como root; o script pede sudo quando precisa. Pode rodar de novo sem medo:
# cada passo pula o que já está feito.
#
#   LH_DATA_REPO=git@github.com:SEU_USUARIO/learnharness-data.git \
#     bash ~/learnharness/deploy/oracle/install.sh
#
# Migração: se existir ~/lh-import/ (com data/ e/ou auth.json copiados do PC),
# os dados entram no repositório de backup na primeira instalação.
# Restauração: se o repositório de backup já tiver dados, ele só é clonado.
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
	echo "Rode como o usuário normal (ex.: ubuntu), não como root." >&2
	exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
CONFIG_DIR="$HOME/.config/learnharness"
DATA_DIR="$HOME/learnharness-data"
AUTH_FILE="$CONFIG_DIR/auth.json"
ENV_FILE="$CONFIG_DIR/learnharness.env"
IMPORT_DIR="$HOME/lh-import"
DEPLOY_KEY="$HOME/.ssh/learnharness-data"
CHROMIUM_DIR="$HOME/.local/share/learnharness-chromium"
NODE_MAJOR=26
PLAYWRIGHT_VERSION=1.63.0
# Chave pública oficial do GitHub (docs.github.com → "GitHub's SSH key fingerprints").
GITHUB_HOST_KEY="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"

say() { printf '\n==> %s\n' "$*"; }
pause() { read -r -p "$* [Enter para continuar] " _ </dev/tty; }

if [ "$(uname -m)" != "aarch64" ]; then
	echo "Aviso: esta máquina é $(uname -m), não aarch64. O kit foi pensado para Oracle A1 (ARM), mas deve funcionar."
fi

# ─── 1. Pacotes do sistema e Node ────────────────────────────────────────────
say "Pacotes do sistema"
sudo apt-get update -q
sudo apt-get install -y -q git curl ca-certificates util-linux openssh-client

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" != "$NODE_MAJOR" ]; then
	say "Instalando Node $NODE_MAJOR (NodeSource)"
	curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
	sudo apt-get install -y -q nodejs
fi
echo "Node $(node -v)"

# ─── 2. Claude Code ──────────────────────────────────────────────────────────
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
	say "Instalando o Claude Code"
	curl -fsSL https://claude.ai/install.sh | bash
fi
echo "Claude Code $(claude --version 2>/dev/null || echo '(versão não lida)')"

# ─── 3. Chromium (demos e renderizações) ─────────────────────────────────────
chrome_path() {
	(cd "$CHROMIUM_DIR" && node -e 'console.log(require("playwright").chromium.executablePath())')
}
if [ ! -x "$(chrome_path 2>/dev/null || true)" ]; then
	say "Instalando o Chromium (via Playwright $PLAYWRIGHT_VERSION)"
	mkdir -p "$CHROMIUM_DIR"
	npm install --prefix "$CHROMIUM_DIR" --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION"
	(cd "$CHROMIUM_DIR" && npx playwright install --with-deps chromium)
fi
CHROME_PATH="$(chrome_path)"
echo "Chromium: $CHROME_PATH"

# ─── 4. Tailscale (acesso privado com HTTPS) ─────────────────────────────────
if ! command -v tailscale >/dev/null 2>&1; then
	say "Instalando o Tailscale"
	curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
	say "Conectando ao Tailscale — abra o link que aparecer e entre na sua conta"
	sudo tailscale up --ssh
fi

# ─── 5. Repositório privado de dados ─────────────────────────────────────────
if [ ! -d "$DATA_DIR/.git" ]; then
	if [ -z "${LH_DATA_REPO:-}" ]; then
		read -r -p "Endereço SSH do repositório de dados (ex.: git@github.com:USUARIO/learnharness-data.git): " LH_DATA_REPO </dev/tty
	fi

	mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
	grep -qxF "$GITHUB_HOST_KEY" "$HOME/.ssh/known_hosts" 2>/dev/null \
		|| echo "$GITHUB_HOST_KEY" >>"$HOME/.ssh/known_hosts"
	if [ ! -f "$DEPLOY_KEY" ]; then
		ssh-keygen -q -t ed25519 -N "" -C "learnharness-backup@$(hostname)" -f "$DEPLOY_KEY"
	fi
	say "Deploy key do backup"
	echo "No GitHub, abra o repositório de dados → Settings → Deploy keys → Add deploy key,"
	echo "cole a linha abaixo e MARQUE 'Allow write access':"
	echo
	cat "$DEPLOY_KEY.pub"
	echo
	pause "Depois de adicionar a chave,"

	export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"
	say "Clonando o repositório de dados"
	git clone -q "$LH_DATA_REPO" "$DATA_DIR"
	git -C "$DATA_DIR" config core.sshCommand "$GIT_SSH_COMMAND"
	git -C "$DATA_DIR" config user.name "LearnHarness backup"
	git -C "$DATA_DIR" config user.email "learnharness-backup@$(hostname)"
	unset GIT_SSH_COMMAND

	# Decide pela branch main do remoto, não pelo HEAD do clone: se o branch
	# padrão do repositório não for main, o clone vem sem checkout.
	if git -C "$DATA_DIR" rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
		git -C "$DATA_DIR" checkout -q -B main origin/main
		echo "O repositório já tem dados: restaurando a partir dele."
		if [ -d "$IMPORT_DIR/data" ]; then
			echo "Atenção: $IMPORT_DIR/data foi IGNORADO para não sobrescrever o backup existente." >&2
		fi
	else
		git -C "$DATA_DIR" checkout -q -b main
		if [ -d "$IMPORT_DIR/data" ]; then
			echo "Importando os dados do PC de $IMPORT_DIR/data"
			cp -a "$IMPORT_DIR/data/." "$DATA_DIR/"
		fi
		cp "$DEPLOY_DIR/data.gitignore" "$DATA_DIR/.gitignore"
		git -C "$DATA_DIR" add -A
		git -C "$DATA_DIR" commit -q -m "backup: importação inicial"
		git -C "$DATA_DIR" push -q -u origin main
		echo "Primeiro backup enviado."
	fi
fi

# ─── 6. Chaves (auth.json) e arquivo de ambiente ─────────────────────────────
mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
if [ ! -f "$AUTH_FILE" ]; then
	if [ -f "$IMPORT_DIR/auth.json" ]; then
		echo "Importando as chaves de $IMPORT_DIR/auth.json"
		install -m 600 "$IMPORT_DIR/auth.json" "$AUTH_FILE"
	else
		echo "{}" >"$AUTH_FILE"
		chmod 600 "$AUTH_FILE"
	fi
fi
if [ -d "$IMPORT_DIR" ]; then
	mv "$IMPORT_DIR" "$IMPORT_DIR.done-$(date +%Y%m%d-%H%M%S)"
fi

sed -e "s|@HOME@|$HOME|g" -e "s|@CHROME_PATH@|$CHROME_PATH|g" \
	"$DEPLOY_DIR/learnharness.env.example" >"$ENV_FILE"
chmod 600 "$ENV_FILE"

# ─── 7. Build e serviços ─────────────────────────────────────────────────────
if [ ! -f "$HOME/learnharness-server/server.js" ]; then
	bash "$DEPLOY_DIR/update.sh" --no-pull
fi

say "Instalando os serviços do systemd"
for unit in learnharness.service learnharness-backup.service learnharness-backup.timer; do
	sed -e "s|@USER@|$(id -un)|g" -e "s|@HOME@|$HOME|g" -e "s|@REPO@|$REPO_DIR|g" "$DEPLOY_DIR/$unit" \
		| sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now learnharness.service learnharness-backup.timer
sudo systemctl restart learnharness.service

say "Publicando o app na sua rede Tailscale (HTTPS)"
port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n1)"
sudo tailscale serve --bg "${port:-3000}"

host="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
say "Tudo pronto"
echo "Abra em qualquer aparelho com o Tailscale ligado:  https://$host"
echo "Se ainda não fez login no Claude Code, rode 'claude' e siga o link (veja o guia)."
