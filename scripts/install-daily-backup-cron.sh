#!/usr/bin/env bash
# Install crontab line for daily backup (Tehran ~03:15 wall clock if TZ set).
set -euo pipefail
ROOT="${1:-/opt/karlancer-telegram-agent}"
LINE="15 3 * * * cd $ROOT && /bin/bash deploy/scripts/daily-backup.sh >> data/backups/cron.log 2>&1"
(crontab -l 2>/dev/null | grep -v 'daily-backup.sh'; echo "$LINE") | crontab -
echo "cron_installed: $LINE"
crontab -l | grep daily-backup || true
