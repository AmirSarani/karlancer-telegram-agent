/**
 * Optional Bale messenger parallel notify (stub + real send when token present).
 * Bale Bot API is Telegram-compatible at https://tapi.bale.ai
 * Never breaks Telegram path; secrets never logged.
 */
import { redactString } from '../security/redaction.js';

export const BALE_API_ROOT = 'https://tapi.bale.ai';

/**
 * @param {object} opts
 * @param {string} [opts.token] BALE_BOT_TOKEN
 * @param {Array<number|string>} [opts.chatIds] BALE_OWNER_CHAT_IDS or reuse telegram ids if same
 * @param {string} opts.text
 * @param {string} [opts.apiRoot]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, sent?: number, error?: string }>}
 */
export async function notifyBaleOwners({
  token,
  chatIds = [],
  text,
  apiRoot = BALE_API_ROOT,
} = {}) {
  if (!token || String(token).trim() === '') {
    return { ok: false, skipped: true, error: 'bale_token_absent' };
  }
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).filter((id) => id != null && id !== ''))];
  if (!ids.length) {
    return { ok: false, skipped: true, error: 'bale_chat_ids_absent' };
  }
  const safeText = redactString(String(text || '')).slice(0, 4000);
  if (!safeText.trim()) {
    return { ok: false, error: 'empty_text' };
  }

  const root = String(apiRoot || BALE_API_ROOT).replace(/\/$/, '');
  let sent = 0;
  /** @type {string|undefined} */
  let lastErr;
  for (const chatId of ids) {
    try {
      const url = `${root}/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          chat_id: Number(chatId) || chatId,
          text: safeText,
        }),
      });
      if (res.ok) sent += 1;
      else {
        lastErr = `http_${res.status}`;
      }
    } catch (e) {
      lastErr = redactString(String(e?.message || e)).slice(0, 200);
    }
  }
  return {
    ok: sent > 0,
    sent,
    error: sent > 0 ? undefined : lastErr || 'bale_send_failed',
  };
}

/**
 * Fan-out: Telegram all owners + Bale if configured.
 * @param {object} opts
 * @param {Function} opts.notifyTelegramAll — async ({ text, reply_markup }) => result
 * @param {object} [opts.bale] { token, chatIds, apiRoot }
 * @param {string} opts.text
 * @param {object} [opts.reply_markup]
 */
export async function notifyOwnersMultiChannel({
  notifyTelegramAll,
  bale = {},
  text,
  reply_markup,
} = {}) {
  const tg =
    typeof notifyTelegramAll === 'function'
      ? await notifyTelegramAll({ text, reply_markup })
      : { ok: false, skipped: true };
  const baleRes = await notifyBaleOwners({
    token: bale.token,
    chatIds: bale.chatIds,
    text,
    apiRoot: bale.apiRoot,
  });
  return { telegram: tg, bale: baleRes };
}

export default notifyBaleOwners;
