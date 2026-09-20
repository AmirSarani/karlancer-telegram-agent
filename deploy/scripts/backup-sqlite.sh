#!/usr/bin/env bash
# Safe SQLite backup using Online Backup API via sqlite3 .backup (WAL-aware).
set -euo pipefail
DB_PATH="${DB_PATH:-./data/agent.sqlite}"
OUT_DIR="${BACKUP_DIR:-./data/backups}"
TS="$(date +%Y%m%dT%H%M%S)"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/agent-$TS.sqlite"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$OUT'"
else
  # fallback: copy main + wal/shm if present (quiesce writers first in prod)
  cp -a "$DB_PATH" "$OUT"
  [[ -f "${DB_PATH}-wal" ]] && cp -a "${DB_PATH}-wal" "${OUT}-wal"
  [[ -f "${DB_PATH}-shm" ]] && cp -a "${DB_PATH}-shm" "${OUT}-shm"
fi
echo "backup_ok $OUT"
