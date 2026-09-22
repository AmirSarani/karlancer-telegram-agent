# Rotate secrets (manual — agent cannot rotate for you)

The agent **cannot** rotate your Karlancer password, Telegram bot token, or VPS root password.
Do this yourself on a secure channel (SSH / password manager), never paste secrets in chat.

## 1) Karlancer Sanctum access token

1. Log in at https://www.karlancer.com in a private browser window.
2. DevTools → Application → Local Storage → copy `auth-token.access_token` (or capture via documented HAR flow).
3. On VPS:
   ```bash
   sudo systemctl stop karlancer-telegram-agent
   # edit /opt/karlancer-telegram-agent/.env — set KARLANCER_ACCESS_TOKEN=...
   chmod 600 /opt/karlancer-telegram-agent/.env
   sudo systemctl start karlancer-telegram-agent
   ```
4. Or use Telegram «🔐 تمدید نشست» (phone+password once) — then **delete** those messages; do not leave password in chat history.

## 2) Telegram bot token

1. @BotFather → /revoke or new token.
2. Update `TELEGRAM_BOT_TOKEN` in `.env` on VPS; restart service.

## 3) VPS root / deploy user password

```bash
passwd
# or create a key-only user and disable password auth
```

## 4) TELEGRAM_SECRETS_KEY (ephemeral re-login AES key)

```bash
openssl rand -hex 32
# set TELEGRAM_SECRETS_KEY=... in .env; restart
```

## Warnings the bot shows

- On 401 / auth false → Persian warning + «تمدید نشست»
- If `.env` mtime older than 14 days → soft age warning in Settings
