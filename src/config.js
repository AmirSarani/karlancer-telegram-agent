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
 * Load and validate runtime config from environment.
 * TELEGRAM_BOT_TOKEN is always required to start the bot.
 * TELEGRAM_OWNER_CHAT_ID is required for owner-only commands (set after first DM).
 */
export function loadConfig({ requireOwner = true } = {}) {
  const telegramBotToken = required('TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN);
  const ownerRaw = optional('TELEGRAM_OWNER_CHAT_ID');
  const telegramOwnerChatId = ownerRaw ? Number(ownerRaw) : null;

  if (requireOwner && (telegramOwnerChatId == null || Number.isNaN(telegramOwnerChatId))) {
    throw new Error(
      'TELEGRAM_OWNER_CHAT_ID is required. Message the bot once, copy your chat id, set it in .env, then run npm start again.'
    );
  }

  return {
    telegramBotToken,
    telegramOwnerChatId,
    openaiApiKey: optional('OPENAI_API_KEY'),
    openaiBaseUrl: optional('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: optional('OPENAI_MODEL', 'gpt-4o-mini'),
    karlancerStorageStatePath: path.resolve(
      root,
      optional('KARLANCER_STORAGE_STATE_PATH', './storage/karlancer-storage-state.json')
    ),
    memoryDir: path.resolve(root, optional('MEMORY_DIR', './data/memory')),
    headless: optional('HEADLESS', 'true').toLowerCase() !== 'false',
    root,
  };
}

export default loadConfig;
