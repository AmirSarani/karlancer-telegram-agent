#!/usr/bin/env bash
# Install/rotate KARLANCER_ACCESS_TOKEN on VPS .env via STDIN only.
# JWT-safe: do not pass token on argv; do not unquoted-source JWTs in bash.
# Usage:
#   printf '%s' "$KARLANCER_ACCESS_TOKEN" | ssh user@host 'bash -s' < deploy/scripts/install-karlancer-token.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/karlancer-telegram-agent}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
KEY_NAME="KARLANCER_ACCESS_TOKEN"

if [[ ! -d "$APP_DIR" ]]; then
  echo "error: APP_DIR missing: $APP_DIR" >&2
  exit 1
fi

TOKEN="$(head -n 1 | tr -d '\r')"
if [[ -z "${TOKEN}" ]]; then
  echo "error: empty token on stdin" >&2
  exit 1
fi
if [[ "$TOKEN" =~ [[:space:]] ]]; then
  echo "error: token contains whitespace (refusing)" >&2
  exit 1
fi

umask 077
TMP="$(mktemp "$APP_DIR/.env.tmp.XXXXXX")"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  grep -v -E "^${KEY_NAME}=" "$ENV_FILE" > "$TMP" || true
else
  : > "$TMP"
fi

printf '%s=%s\n' "$KEY_NAME" "$TOKEN" >> "$TMP"
unset TOKEN

mv -f "$TMP" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

if ! grep -q -E "^${KEY_NAME}=.+" "$ENV_FILE"; then
  echo "error: key not present after write" >&2
  exit 1
fi
echo "ok: updated ${KEY_NAME} in ${ENV_FILE} (chmod 600)"

RESTARTED=0
for u in karlancer-telegram-agent.service mcp-agent.service mcp-http.service; do
  if systemctl cat "$u" &>/dev/null; then
    if systemctl restart "$u"; then
      echo "ok: restarted $u"
      RESTARTED=1
    else
      echo "warn: failed to restart $u" >&2
    fi
  fi
done

if [[ "$RESTARTED" -eq 0 ]]; then
  echo "warn: no known unit restarted; systemctl list-units --all '*karlancer*' '*mcp*'"
fi

echo "ok: done (token never printed)"
