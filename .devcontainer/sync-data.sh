#!/usr/bin/env bash
# Salva chats, grafo, settings e fontes no GitHub: commit de tudo que mudou
# no repo de dados, pull --rebase e push. Uso: bash .devcontainer/sync-data.sh
set -euo pipefail

DATA_DIR="${LH_DATA_DIR:-/workspaces/learnharness-data}"
cd "$DATA_DIR"

git add -A
if git diff --cached --quiet; then
	echo "Nada novo para commitar."
else
	git commit -q -m "backup: codespace $(date '+%Y-%m-%d %H:%M')"
	git show --stat --format='Commit %h: %s' HEAD
fi

git pull --rebase -q
git push -q
echo "Repo de dados sincronizado com o GitHub."
