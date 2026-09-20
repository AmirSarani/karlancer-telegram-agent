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
 * Application config for API-first agent.
 * @param {{ requireTelegram?: boolean, requireOwner?: boolean }} [opts]
 */
export function loadAppConfig(opts = {}) {
  const requireTelegram = opts.requireTelegram !== false;
  const requireOwner = opts.requireOwner !== false;

  const telegramBotToken = requireTelegram
    ? required('TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN)
    : optional('TELEGRAM_BOT_TOKEN');
  const ownerRaw = optional('TELEGRAM_OWNER_CHAT_ID');
  const telegramOwnerChatId = ownerRaw ? Number(ownerRaw) : null;

  if (requireTelegram && requireOwner && (telegramOwnerChatId == null || Number.isNaN(telegramOwnerChatId))) {
    throw new Error(
      'TELEGRAM_OWNER_CHAT_ID is required. Message the bot once, copy your chat id, set it in .env, then run npm start again.'
    );
  }

  return {
    root,
    telegramBotToken,
    telegramOwnerChatId,
    openaiApiKey: optional('OPENAI_API_KEY'),
    openaiBaseUrl: optional('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: optional('OPENAI_MODEL', 'gpt-4o-mini'),
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
    enableTelegram: optional('ENABLE_TELEGRAM', 'true').toLowerCase() !== 'false',
    enableWorker: optional('ENABLE_WORKER', 'true').toLowerCase() !== 'false',
    dailyTokenLimit: Number(optional('DAILY_TOKEN_LIMIT', '200000')) || 200000,
  };
}

/** @deprecated use loadAppConfig */
export function loadConfig(opts = {}) {
  return loadAppConfig({ requireTelegram: true, requireOwner: opts.requireOwner !== false });
}

export default loadAppConfig;
