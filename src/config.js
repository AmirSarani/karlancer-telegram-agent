import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function required(name, value) {
  if (!value || String(value).trim() === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(value).trim();
}

function optional(name, fallback = '') {
  const v = process.env[name];
  return v != null && String(v).trim() !== '' ? String(v).trim() : fallback;
}


/**
 * Parse TELEGRAM_OWNER_CHAT_ID as one id or comma-separated allowlist.
 * Invalid tokens are skipped. Order preserved; duplicates removed.
 * @param {string} [raw]
 * @returns {number[]}
 */
export function parseTelegramOwnerChatIds(raw = '') {
  if (raw == null || String(raw).trim() === '') return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isFinite(n) || Number.isNaN(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Application config for API-first agent.
 * @param {{ requireTelegram?: boolean, requireOwner?: boolean }} [opts]
 */
export function loadAppConfig(opts = {}) {
  const enableTelegram = optional('ENABLE_TELEGRAM', 'true').toLowerCase() !== 'false';
  const requireTelegram = opts.requireTelegram !== false && enableTelegram;
  const requireOwner = opts.requireOwner !== false && enableTelegram;

  const telegramBotToken = requireTelegram
    ? required('TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN)
    : optional('TELEGRAM_BOT_TOKEN');
  const ownerRaw = optional('TELEGRAM_OWNER_CHAT_ID');
  const telegramOwnerChatIds = parseTelegramOwnerChatIds(ownerRaw);
  /** Primary owner (first id) — used for outbound notifications. */
  const telegramOwnerChatId = telegramOwnerChatIds[0] ?? null;

  if (requireTelegram && requireOwner && telegramOwnerChatIds.length === 0) {
    throw new Error(
      'TELEGRAM_OWNER_CHAT_ID is required (one id or comma-separated list). Message the bot once, copy your chat id, set it in .env, then run npm start again.'
    );
  }

  return {
    root,
    telegramBotToken,
    telegramOwnerChatId,
    telegramOwnerChatIds,
    openaiApiKey: optional('OPENAI_API_KEY'),
    openaiBaseUrl: optional('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: optional('OPENAI_MODEL', 'gpt-4o-mini'),
    openaiLargeModel: optional('OPENAI_LARGE_MODEL', optional('OPENAI_MODEL', 'gpt-4o-mini')),
    karlancerBaseUrl: optional('KARLANCER_BASE_URL', 'https://www.karlancer.com').replace(/\/$/, ''),
    karlancerAccessToken: optional('KARLANCER_ACCESS_TOKEN'),
    karlancerCookie: optional('KARLANCER_COOKIE'),
    karlancerTimeoutMs: Number(optional('KARLANCER_TIMEOUT_MS', '30000')) || 30000,
    memoryDir: path.resolve(root, optional('MEMORY_DIR', './data/memory')),
    dbPath: path.resolve(root, optional('DB_PATH', './data/agent.sqlite')),
    stateDir: path.resolve(root, optional('STATE_DIR', './state')),
    mcpHttpHost: optional('MCP_HTTP_HOST', '127.0.0.1'),
    mcpHttpPort: Number(optional('MCP_HTTP_PORT', '8787')) || 8787,
    mcpApiKey: optional('MCP_API_KEY'),
    enableTelegram,
    enableWorker: optional('ENABLE_WORKER', 'true').toLowerCase() !== 'false',
    dailyTokenLimit: Number(optional('DAILY_TOKEN_LIMIT', '200000')) || 200000,
  };
}

/** @deprecated use loadAppConfig */
export function loadConfig(opts = {}) {
  return loadAppConfig({ requireTelegram: true, requireOwner: opts.requireOwner !== false });
}

export default loadAppConfig;
