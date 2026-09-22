/**
 * Owner-only Telegram notify helper (no long-poll). Secrets never logged.
 */
import { Bot } from 'grammy';
import { redactString } from '../security/redaction.js';

/**
 * Send one message to the owner chat.
 * @param {object} opts
 * @param {string} opts.token
 * @param {number|string} opts.chatId
 * @param {string} opts.text
 * @param {object} [opts.reply_markup]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function notifyOwner({ token, chatId, text, reply_markup } = {}) {
  if (!token || chatId == null || chatId === '') {
    return { ok: false, error: 'missing_config' };
  }
  const safeText = redactString(String(text || '')).slice(0, 4000);
  if (!safeText.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  try {
    const bot = new Bot(String(token));
    const opts = {};
    if (reply_markup) opts.reply_markup = reply_markup;
    await bot.api.sendMessage(Number(chatId) || chatId, safeText, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redactString(String(e?.message || e)).slice(0, 200) };
  }
}


/**
 * Edit an existing owner message (for scan loading → result).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function editOwnerMessage({ token, chatId, messageId, text, reply_markup } = {}) {
  if (!token || chatId == null || chatId === '' || messageId == null) {
    return { ok: false, error: 'missing_config' };
  }
  const safeText = redactString(String(text || '')).slice(0, 4000);
  if (!safeText.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  try {
    const bot = new Bot(String(token));
    const opts = {};
    if (reply_markup) opts.reply_markup = reply_markup;
    await bot.api.editMessageText(Number(chatId) || chatId, Number(messageId), safeText, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redactString(String(e?.message || e)).slice(0, 200) };
  }
}

export default notifyOwner;

