/**
 * Owner Telegram (+ optional Bale) notify helpers. Secrets never logged.
 */
import { Bot } from 'grammy';
import { redactString } from '../security/redaction.js';
import { splitTelegramText } from './split-text.js';

/**
 * Send one message to a single chat.
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
  const safeText = redactString(String(text || ''));
  if (!safeText.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  try {
    const bot = new Bot(String(token));
    // Long text → sequential messages; buttons only on the last part.
    const parts = splitTelegramText(safeText);
    for (let i = 0; i < parts.length; i++) {
      const opts = {};
      if (reply_markup && i === parts.length - 1) opts.reply_markup = reply_markup;
      await bot.api.sendMessage(Number(chatId) || chatId, parts[i], opts);
    }
    return { ok: true, parts: parts.length };
  } catch (e) {
    return { ok: false, error: redactString(String(e?.message || e)).slice(0, 200) };
  }
}

/**
 * Notify every owner chat id (deduped). Partial failures reported.
 * @param {object} opts
 * @param {string} opts.token
 * @param {Array<number|string>} opts.chatIds
 * @param {string} opts.text
 * @param {object} [opts.reply_markup]
 * @returns {Promise<{ ok: boolean, sent: number, failed: number, errors: string[] }>}
 */
export async function notifyAllOwners({ token, chatIds, text, reply_markup } = {}) {
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).filter((id) => id != null && id !== ''))];
  if (!token || !ids.length) {
    return { ok: false, sent: 0, failed: 0, errors: ['missing_config'] };
  }
  let sent = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  for (const chatId of ids) {
    const res = await notifyOwner({ token, chatId, text, reply_markup });
    if (res.ok) sent += 1;
    else {
      failed += 1;
      if (res.error) errors.push(res.error);
    }
  }
  return { ok: sent > 0, sent, failed, errors };
}

/**
 * Edit an existing owner message (for scan loading → result).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function editOwnerMessage({ token, chatId, messageId, text, reply_markup } = {}) {
  if (!token || chatId == null || chatId === '' || messageId == null) {
    return { ok: false, error: 'missing_config' };
  }
  const safeText = redactString(String(text || ''));
  if (!safeText.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  try {
    const bot = new Bot(String(token));
    const parts = splitTelegramText(safeText);
    const firstOpts = {};
    if (reply_markup && parts.length === 1) firstOpts.reply_markup = reply_markup;
    await bot.api.editMessageText(Number(chatId) || chatId, Number(messageId), parts[0], firstOpts);
    for (let i = 1; i < parts.length; i++) {
      const opts = {};
      if (reply_markup && i === parts.length - 1) opts.reply_markup = reply_markup;
      await bot.api.sendMessage(Number(chatId) || chatId, parts[i], opts);
    }
    return { ok: true, parts: parts.length };
  } catch (e) {
    return { ok: false, error: redactString(String(e?.message || e)).slice(0, 200) };
  }
}

export default notifyOwner;
