#!/usr/bin/env bash
# Daily backup: agent.sqlite + copy of .env → permission-locked (or gpg) dated dir.
# Cron example (Asia/Tehran ~03:15):
#   15 3 * * * cd /opt/karlancer-telegram-agent && bash deploy/scripts/daily-backup.sh >> data/backups/cron.log 2>&1
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"
DB_PATH="${DB_PATH:-./data/agent.sqlite}"
ENV_PATH="${ENV_PATH:-./.env}"
OUT_ROOT="${BACKUP_DIR:-./data/backups}"
TS="$(date +%Y%m%dT%H%M%S)"
DAY_DIR="$OUT_ROOT/daily-$TS"
mkdir -p "$DAY_DIR"
chmod 700 "$OUT_ROOT" 2>/dev/null || true
chmod 700 "$DAY_DIR"

# SQLite online backup
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$DB_PATH" ]]; then
  sqlite3 "$DB_PATH" ".backup '$DAY_DIR/agent.sqlite'"
elif [[ -f "$DB_PATH" ]]; then
  cp -a "$DB_PATH" "$DAY_DIR/agent.sqlite"
  [[ -f "${DB_PATH}-wal" ]] && cp -a "${DB_PATH}-wal" "$DAY_DIR/agent.sqlite-wal"
  [[ -f "${DB_PATH}-shm" ]] && cp -a "${DB_PATH}-shm" "$DAY_DIR/agent.sqlite-shm"
else
  echo "warn: no sqlite at $DB_PATH" >&2
fi

# .env copy — never world-readable
if [[ -f "$ENV_PATH" ]]; then
  if command -v gpg >/dev/null 2>&1 && [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    gpg --batch --yes -o "$DAY_DIR/env.gpg" -e -r "$BACKUP_GPG_RECIPIENT" "$ENV_PATH"
    chmod 600 "$DAY_DIR/env.gpg"
  else
    cp -a "$ENV_PATH" "$DAY_DIR/env.copy"
    chmod 600 "$DAY_DIR/env.copy"
  fi
fi

# Manifest (no secrets)
{
  echo "backup_at=$TS"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
  echo "db=$(basename "$DB_PATH")"
  echo "git=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "$DAY_DIR/MANIFEST.txt"
chmod 600 "$DAY_DIR"/* 2>/dev/null || true
chmod 700 "$DAY_DIR"

# Retention: keep last 14 daily dirs
ls -1dt "$OUT_ROOT"/daily-* 2>/dev/null | tail -n +15 | xargs -r rm -rf

echo "daily_backup_ok $DAY_DIR"
