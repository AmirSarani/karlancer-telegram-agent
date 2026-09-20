#!/usr/bin/env bash
set -euo pipefail
SRC="${1:?usage: restore-sqlite.sh <backup.sqlite>}"
DB_PATH="${DB_PATH:-./data/agent.sqlite}"
cp -a "$SRC" "$DB_PATH"
echo "restore_ok $DB_PATH — restart worker/mcp processes"
