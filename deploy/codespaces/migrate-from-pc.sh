#!/usr/bin/env bash
# migrate-from-pc.sh — roda NO SEU PC (uma vez): envia os dados do app desktop
# para o repositório privado de dados, que o Codespace clona ao ser criado.
#
#   bash deploy/codespaces/migrate-from-pc.sh git@github.com:USUARIO/learnharness-data.git
#
# A pasta original (~/.config/LearnHarness/data) não é alterada: os dados são
# copiados para uma pasta temporária e enviados de lá. As chaves (auth.json)
# NÃO são enviadas; o script só lista os nomes delas para você cadastrar como
# segredos do Codespaces.
set -euo pipefail

if [ $# -ne 1 ]; then
	echo "uso: $0 <endereço do repositório learnharness-data>" >&2
	exit 2
fi
REMOTE="$1"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="${LH_DESKTOP_DIR:-$HOME/.config/LearnHarness}"
SRC="$DESKTOP_DIR/data"

if [ ! -d "$SRC" ]; then
	echo "Não achei os dados do app desktop em $SRC." >&2
	echo "Se estiverem em outro lugar: LH_DESKTOP_DIR=/caminho bash $0 $REMOTE" >&2
	exit 1
fi

read -r -p "O app desktop do LearnHarness está FECHADO? [s/N] " ok </dev/tty
case "$ok" in
	s | S | sim | Sim) ;;
	*) echo "Feche o app desktop e rode de novo." >&2; exit 1 ;;
esac

if [ -n "$(git ls-remote --heads "$REMOTE")" ]; then
	echo "O repositório $REMOTE já tem dados. Nada foi enviado (para não sobrescrever)." >&2
	exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -a "$SRC/." "$TMP/"
cp "$DEPLOY_DIR/../oracle/data.gitignore" "$TMP/.gitignore"

git -C "$TMP" init -q -b main
git -C "$TMP" add -A
git -C "$TMP" -c user.name="LearnHarness backup" -c user.email="learnharness-backup@pc" \
	commit -q -m "backup: importação do app desktop"
git -C "$TMP" remote add origin "$REMOTE"
git -C "$TMP" push -q -u origin main

echo "Pronto: $(git -C "$TMP" ls-files | wc -l | tr -d ' ') arquivos enviados para $REMOTE."

AUTH="$DESKTOP_DIR/auth.json"
if [ -f "$AUTH" ] && command -v python3 >/dev/null 2>&1; then
	names="$(python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1])))))' "$AUTH" 2>/dev/null || true)"
	if [ -n "$names" ]; then
		echo
		echo "Chaves no seu auth.json (cadastre cada uma como segredo do Codespaces, com o mesmo nome):"
		printf '%s\n' "$names" | sed 's/^/  - /'
		echo "Não cadastre ANTHROPIC_API_KEY: o Claude Code passaria a cobrar pela API em vez da assinatura."
	fi
fi
