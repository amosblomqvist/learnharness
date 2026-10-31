#!/usr/bin/env bash
# backup.sh — salva a pasta de dados do LearnHarness no repositório privado.
#
# Roda pelo timer (a cada 15 min) e quando o serviço para. Só faz commit
# quando algo mudou, e sempre tenta empurrar commits pendentes (um push que
# falhou por falta de rede sai no próximo ciclo).
set -euo pipefail

DATA_DIR="${LH_DATA_DIR:-$HOME/learnharness-data}"
BRANCH=main

cd "$DATA_DIR"
if [ ! -d .git ]; then
	echo "backup: $DATA_DIR não é um repositório git — rode install.sh primeiro." >&2
	exit 1
fi

# Um backup por vez (o timer e o ExecStopPost podem coincidir).
exec 9>.git/lh-backup.lock
if ! flock -n 9; then
	echo "backup: outro backup já está rodando; pulando."
	exit 0
fi

git add -A
if ! git diff --cached --quiet; then
	git commit -q -m "backup: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "backup: commit criado."
fi

# Empurra quando o remoto não tem a branch ainda ou está atrás.
if ! git rev-parse -q --verify "refs/remotes/origin/$BRANCH" >/dev/null \
	|| [ "$(git rev-list --count "origin/$BRANCH..HEAD")" -gt 0 ]; then
	git push -q origin "HEAD:$BRANCH"
	echo "backup: enviado ao GitHub."
fi
