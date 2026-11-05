#!/usr/bin/env bash
# Выкатить Panic Station на сервер платформы Zarya Boardgames.
# Обёртка над deploy/game.sh из проекта платформы: обновляет только игру panic,
# платформу и остальные игры не трогает.
#
#   bash deploy.sh               — обновить (спросит, если на сервере есть открытые столы)
#   bash deploy.sh --yes         — не спрашивать про открытые столы
#   bash deploy.sh --rollback    — вернуть предыдущую версию
#
# Переменные: HOST (по умолчанию root@201.24.61.26), PLATFORM_DIR (по умолчанию ../zarya-boardgames-platform).
# Важно: партии Panic Station хранятся в памяти и пропадают при перезапуске.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${HOST:-root@201.24.61.26}"
PLATFORM="${PLATFORM_DIR:-$HERE/../zarya-boardgames-platform}"

[ -f "$PLATFORM/deploy/game.sh" ] || { echo "Не найден $PLATFORM/deploy/game.sh — укажите PLATFORM_DIR" >&2; exit 1; }

# На сервер уходит архив последнего коммита — незакоммиченные правки не уедут.
if [ -n "$(git -C "$HERE" status --porcelain)" ]; then
  echo "Есть незакоммиченные изменения — они не попадут на сервер:" >&2
  git -C "$HERE" status --short >&2
  exit 1
fi

cd "$PLATFORM"
exec bash deploy/game.sh "$HOST" panic "$@"
