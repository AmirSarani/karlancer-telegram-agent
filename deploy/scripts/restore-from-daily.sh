#!/usr/bin/env bash
# Restore from a daily backup directory created by daily-backup.sh
# Usage: bash deploy/scripts/restore-from-daily.sh data/backups/daily-YYYYMMDDTHHMMSS
# Stop the agent first: systemctl stop karlancer-telegram-agent
set -euo pipefail
SRC="${1:?usage: restore-from-daily.sh <daily-dir>}"
ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"
DB_PATH="${DB_PATH:-./data/agent.sqlite}"
ENV_PATH="${ENV_PATH:-./.env}"

[[ -d "$SRC" ]] || { echo "not a directory: $SRC" >&2; exit 1; }
[[ -f "$SRC/agent.sqlite" ]] || { echo "missing agent.sqlite in $SRC" >&2; exit 1; }

mkdir -p "$(dirname "$DB_PATH")"
cp -a "$DB_PATH" "${DB_PATH}.pre-restore.$(date +%Y%m%dT%H%M%S)" 2>/dev/null || true
cp -a "$SRC/agent.sqlite" "$DB_PATH"
[[ -f "$SRC/agent.sqlite-wal" ]] && cp -a "$SRC/agent.sqlite-wal" "${DB_PATH}-wal"
[[ -f "$SRC/agent.sqlite-shm" ]] && cp -a "$SRC/agent.sqlite-shm" "${DB_PATH}-shm"

if [[ -f "$SRC/env.gpg" ]]; then
  echo "Encrypted env present. Decrypt manually:"
  echo "  gpg -d $SRC/env.gpg > $ENV_PATH && chmod 600 $ENV_PATH"
elif [[ -f "$SRC/env.copy" ]]; then
  cp -a "$ENV_PATH" "${ENV_PATH}.pre-restore.$(date +%Y%m%dT%H%M%S)" 2>/dev/null || true
  cp -a "$SRC/env.copy" "$ENV_PATH"
  chmod 600 "$ENV_PATH"
fi

echo "restore_ok from $SRC — restart: systemctl start karlancer-telegram-agent"
