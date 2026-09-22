/**
 * Owner-only Karlancer session renewal via Telegram (ephemeral in-memory state).
 * Prefer one-time browser token paste (no password in chat).
 * Keep phone/password as warned fallback. Never persists phone/password; never logs secrets.
 */
import { InlineKeyboard } from 'grammy';
import { createAuthAdapter } from '../api/adapters/auth.js';
import { persistAccessToken } from '../security/persist-access-token.js';
import {
  encryptEphemeral,
  decryptEphemeral,
} from '../security/ephemeral-secrets.js';

/** @typedef {'await_choice'|'await_token'|'await_phone'|'await_password'} ReloginPhase */

/**
 * @typedef {object} ReloginState
 * @property {ReloginPhase} phase
 * @property {string} [phoneCipher] AES-256-GCM blob only — never plaintext phone
 * @property {number} [phoneMessageId]
 * @property {number} [passwordMessageId]
 * @property {number} [tokenMessageId]
 * @property {number} startedAt
 * @property {number} expiresAt
 */

export const RELOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const SESSION_EXPIRED_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

export const MSG = Object.freeze({
  ASK_CHOICE: [
    '🔐 تمدید نشست کارلنسر',
    '',
    'روش امن‌تر (پیشنهادی):',
    '📋 توکن یک‌بارمصرف از مرورگر',
    '۱) در مرورگر وارد کارلنسر شوید',
    '۲) DevTools → Application → Local Storage → کلید auth-token',
    '۳) مقدار access_token را کپی کنید',
    '۴) همین‌جا فقط همان توکن را بفرستید (نه رمز)',
    '',
    'پس از دریافت، پیام را پاک می‌کنیم. توکن را فوروارد نکنید.',
    '',
    '⚠️ ورود با رمز در تلگرام امن نیست (تاریخچه ممکن است کپی نگه دارد) — فقط اگر توکن ندارید.',
    'انصراف: /cancel',
  ].join('\n'),
  ASK_TOKEN: [
    '📋 توکن access_token را از مرورگر بفرستید.',
    '',
    'فقط خودِ توکن (معمولاً شبیه id|secret).',
    'رمز عبور را اینجا نفرستید.',
    'لغو: /cancel',
  ].join('\n'),
  ASK_PHONE: [
    '⚠️ هشدار: رمز در چت تلگرام E2E نیست.',
    '',
    'شماره موبایل حساب کارلنسر را بفرستید (مثلاً 09xxxxxxxxx).',
    'بعداً پیام‌ها را پاک کنید.',
    'انصراف: /cancel یا دکمه لغو.',
  ].join('\n'),
  ASK_PASSWORD:
    'رمز عبور کارلنسر را بفرستید.\n\nپس از دریافت، تلاش می‌کنیم پیام رمز را حذف کنیم.\nرمز را فوروارد نکنید.\nلغو: /cancel',
  SUCCESS: 'نشست تازه فعال شد',
  CANCELLED: 'تمدید نشست لغو شد.',
  TIMEOUT: 'زمان تمدید نشست تمام شد. از تنظیمات دوباره شروع کنید.',
  BAD_PHONE: 'شماره معتبر نیست. یک شماره موبایل ایرانی (09…) بفرستید یا لغو کنید.',
  BAD_PASSWORD: 'رمز عبور اشتباه است یا ورود رد شد. دوباره رمز را بفرستید یا لغو کنید.',
  BAD_TOKEN:
    'توکن معتبر به نظر نمی‌رسد. access_token را از localStorage کپی کنید (نه رمز، نه JSON کامل) یا روش رمز را امتحان کنید.',
  NETWORK: 'ارتباط با سرور کارلنسر برقرار نشد.',
  PERSIST_WARN:
    'ورود موفق بود ولی نوشتن .env ممکن است کامل نشده باشد — نشست در حافظه فعال است.',
  NOT_OWNER: 'فقط مالک می‌تواند نشست را تمدید کند.',
  SESSION_EXPIRED: [
    'نشست کارلنسر منقضی شده.',
    'از تنظیمات «🔐 تمدید نشست» → ترجیحاً چسباندن توکن مرورگر.',
    'رمز را در چت نگذارید مگر ناچار باشید.',
  ].join('\n'),
});

/** @type {Map<number, ReloginState>} */
const states = new Map();

/** @type {number} */
let lastSessionExpiredNotifyAt = 0;

export function reloginChoiceKeyboard() {
  return new InlineKeyboard()
    .text('📋 توکن مرورگر', 'set:relogin:token')
    .row()
    .text('⚠️ ورود با رمز', 'set:relogin:password')
    .row()
    .text('❌ لغو', 'set:relogin:cancel')
    .row()
    .text('⬅️ تنظیمات', 'nav:set');
}

export function reloginCancelKeyboard() {
  return new InlineKeyboard()
    .text('❌ لغو', 'set:relogin:cancel')
    .row()
    .text('⬅️ تنظیمات', 'nav:set');
}

export function reloginRetryKeyboard() {
  return new InlineKeyboard()
    .text('🔁 تلاش دوباره', 'set:relogin')
    .text('❌ لغو', 'set:relogin:cancel')
    .row()
    .text('⬅️ تنظیمات', 'nav:set');
}

/**
 * @param {number|string} chatId
 * @returns {ReloginState|null}
 */
export function getReloginState(chatId) {
  const id = Number(chatId);
  const st = states.get(id);
  if (!st) return null;
  if (Date.now() > st.expiresAt) {
    clearReloginState(id);
    return null;
  }
  return st;
}

/**
 * @param {number|string} chatId
 */
export function clearReloginState(chatId) {
  const id = Number(chatId);
  const st = states.get(id);
  if (st) {
    if (st.phoneCipher) st.phoneCipher = '';
    if (st.phone) st.phone = ''; // legacy field guard
    states.delete(id);
  }
}

/**
 * Start with method choice (token preferred).
 * @param {number|string} chatId
 * @param {number} [timeoutMs]
 * @returns {ReloginState}
 */
export function beginRelogin(chatId, timeoutMs = RELOGIN_TIMEOUT_MS) {
  const id = Number(chatId);
  clearReloginState(id);
  const now = Date.now();
  /** @type {ReloginState} */
  const st = {
    phase: 'await_choice',
    startedAt: now,
    expiresAt: now + timeoutMs,
  };
  states.set(id, st);
  return st;
}

/**
 * Jump to token-paste phase.
 * @param {number|string} chatId
 * @param {number} [timeoutMs]
 */
export function beginTokenPaste(chatId, timeoutMs = RELOGIN_TIMEOUT_MS) {
  const id = Number(chatId);
  clearReloginState(id);
  const now = Date.now();
  /** @type {ReloginState} */
  const st = {
    phase: 'await_token',
    startedAt: now,
    expiresAt: now + timeoutMs,
  };
  states.set(id, st);
  return st;
}

/**
 * Jump to phone/password fallback.
 * @param {number|string} chatId
 * @param {number} [timeoutMs]
 */
export function beginPasswordFallback(chatId, timeoutMs = RELOGIN_TIMEOUT_MS) {
  const id = Number(chatId);
  clearReloginState(id);
  const now = Date.now();
  /** @type {ReloginState} */
  const st = {
    phase: 'await_phone',
    startedAt: now,
    expiresAt: now + timeoutMs,
  };
  states.set(id, st);
  return st;
}

/** @returns {number} */
export function _reloginStateSizeForTests() {
  return states.size;
}

export function _resetReloginForTests() {
  states.clear();
  lastSessionExpiredNotifyAt = 0;
}

/**
 * Normalize Iranian mobile to digits (09…).
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizePhone(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  s = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  s = s.replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = `0${s.slice(3)}`;
  if (s.startsWith('0098')) s = `0${s.slice(4)}`;
  if (s.startsWith('98') && s.length === 12) s = `0${s.slice(2)}`;
  if (!/^09\d{9}$/.test(s)) return null;
  return s;
}

/**
 * Extract Sanctum-style access token from pasted text / JSON snippet.
 * Never returns password-looking short strings without `|` or long secret.
 * @param {string} raw
 * @returns {string|null}
 */
export function extractPastedAccessToken(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // Strip Bearer prefix
  s = s.replace(/^(Bearer|bearer)\s+/i, '').trim();
  // Try JSON blob
  if (s.startsWith('{') && s.includes('access_token')) {
    try {
      const j = JSON.parse(s);
      const t = j.access_token || j.accessToken || j?.data?.access_token;
      if (t) s = String(t).trim();
    } catch {
      const m = s.match(/"access_token"\s*:\s*"([^"]+)"/);
      if (m) s = m[1];
    }
  }
  s = s.replace(/\r/g, '').split('\n')[0].trim();
  if (!s || /\s/.test(s)) return null;
  // Sanctum: digits|secret — or long opaque token
  if (/^\d+\|.+$/.test(s) && s.length >= 20) return s;
  if (s.length >= 40 && !/\s/.test(s) && !/^09\d{9}$/.test(s)) return s;
  return null;
}

/**
 * @param {import('grammy').Context} ctx
 * @param {number} [messageId]
 */
async function tryDeleteMessage(ctx, messageId) {
  if (messageId == null || !ctx?.chat?.id) return;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, messageId);
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} opts
 * @param {import('grammy').Context} opts.ctx
 * @param {{ client: { setAccessToken?: Function } }} opts.api
 * @param {string} [opts.envFile]
 * @param {(msg: string, fields?: object) => void} [opts.logInfo]
 * @param {(msg: string, fields?: object) => void} [opts.logWarn]
 * @returns {Promise<boolean>} true if consumed
 */
export async function handleReloginText({
  ctx,
  api,
  envFile,
  logInfo = () => {},
  logWarn = () => {},
}) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;
  const st = getReloginState(chatId);
  if (!st) return false;

  const text = String(ctx.message?.text || '').trim();
  if (!text) return true;

  if (text === '/cancel' || text === 'لغو' || text === '❌ لغو') {
    clearReloginState(chatId);
    await ctx.reply(MSG.CANCELLED);
    return true;
  }

  if (st.phase === 'await_choice') {
    // If they paste a token directly at choice screen, accept it
    const maybe = extractPastedAccessToken(text);
    if (maybe) {
      st.phase = 'await_token';
      return handleTokenPaste({ ctx, api, envFile, logInfo, logWarn, st, token: maybe });
    }
    await ctx.reply(MSG.ASK_CHOICE, { reply_markup: reloginChoiceKeyboard() });
    return true;
  }

  if (st.phase === 'await_token') {
    const token = extractPastedAccessToken(text);
    st.tokenMessageId = ctx.message?.message_id;
    await tryDeleteMessage(ctx, st.tokenMessageId);
    if (!token) {
      await ctx.reply(MSG.BAD_TOKEN, { reply_markup: reloginChoiceKeyboard() });
      return true;
    }
    return handleTokenPaste({ ctx, api, envFile, logInfo, logWarn, st, token });
  }

  if (st.phase === 'await_phone') {
    const phone = normalizePhone(text);
    if (!phone) {
      await ctx.reply(MSG.BAD_PHONE, { reply_markup: reloginCancelKeyboard() });
      return true;
    }
    try {
      st.phoneCipher = encryptEphemeral(phone);
    } catch {
      logWarn('karlancer_relogin_encrypt_failed', { reason: 'phone' });
      clearReloginState(chatId);
      await ctx.reply(MSG.NETWORK, { reply_markup: reloginRetryKeyboard() });
      return true;
    }
    st.phone = undefined;
    st.phoneMessageId = ctx.message?.message_id;
    st.phase = 'await_password';
    st.expiresAt = Date.now() + RELOGIN_TIMEOUT_MS;
    await tryDeleteMessage(ctx, st.phoneMessageId);
    await ctx.reply(MSG.ASK_PASSWORD, { reply_markup: reloginCancelKeyboard() });
    return true;
  }

  if (st.phase === 'await_password') {
    const password = text;
    let phone = null;
    try {
      if (st.phoneCipher) phone = decryptEphemeral(st.phoneCipher);
      else if (st.phone) phone = st.phone; // legacy in-memory only
    } catch {
      phone = null;
    }
    st.passwordMessageId = ctx.message?.message_id;
    await tryDeleteMessage(ctx, st.passwordMessageId);
    await tryDeleteMessage(ctx, st.phoneMessageId);

    if (!phone) {
      clearReloginState(chatId);
      beginPasswordFallback(chatId);
      await ctx.reply(MSG.ASK_PHONE, { reply_markup: reloginCancelKeyboard() });
      return true;
    }

    try {
      const auth = createAuthAdapter(api.client);
      const result = await auth.loginWithPhone({ phone, password });
      const token = result.accessToken;
      phone = '';

      const persisted = persistAccessToken(token, {
        client: api.client,
        envFile,
      });

      clearReloginState(chatId);
      logInfo('karlancer_relogin_ok', {
        userId: result.userId || null,
        persisted: persisted.ok,
        method: 'password_fallback',
      });

      if (!persisted.ok) {
        logWarn('karlancer_relogin_persist_partial', { error: persisted.error });
        await ctx.reply(`${MSG.SUCCESS}\n\n⚠️ ${MSG.PERSIST_WARN}`);
      } else {
        await ctx.reply(MSG.SUCCESS);
      }
      return true;
    } catch (e) {
      const code = e?.code || '';
      const status = e?.status;
      logWarn('karlancer_relogin_failed', {
        code: code || 'error',
        status: status || null,
      });

      if (
        status === 401 ||
        status === 403 ||
        status === 422 ||
        code === 'unauthorized' ||
        code === 'validation'
      ) {
        st.phase = 'await_password';
        st.expiresAt = Date.now() + RELOGIN_TIMEOUT_MS;
        await ctx.reply(MSG.BAD_PASSWORD, { reply_markup: reloginCancelKeyboard() });
        return true;
      }

      if (
        code === 'network' ||
        code === 'timeout' ||
        code === 'circuit_open' ||
        /network|timeout|fetch|econn/i.test(String(e?.message || e))
      ) {
        await ctx.reply(MSG.NETWORK, { reply_markup: reloginRetryKeyboard() });
        return true;
      }

      await ctx.reply('ورود ناموفق بود. دوباره تلاش کنید.', {
        reply_markup: reloginRetryKeyboard(),
      });
      return true;
    }
  }

  return true;
}

async function handleTokenPaste({ ctx, api, envFile, logInfo, logWarn, st, token }) {
  const chatId = ctx.chat?.id;
  try {
    const persisted = persistAccessToken(token, {
      client: api.client,
      envFile,
    });
    // Best-effort validate without logging token
    let validated = false;
    try {
      if (typeof api?.client?.get === 'function') {
        await api.client.get('/api/profile', { retries: 0 });
        validated = true;
      } else if (typeof api?.user?.me === 'function') {
        const me = await api.user.me();
        validated = Boolean(me?.id || me?.status === 'ok');
      } else {
        validated = Boolean(api?.client?.hasAuth);
      }
    } catch (e) {
      if (e?.status === 401 || e?.code === 'unauthorized') {
        clearReloginState(chatId);
        await ctx.reply(MSG.BAD_TOKEN, { reply_markup: reloginChoiceKeyboard() });
        return true;
      }
      // Soft: token written; network flaky
      validated = persisted.ok;
    }

    clearReloginState(chatId);
    logInfo('karlancer_relogin_ok', {
      persisted: persisted.ok,
      validated,
      method: 'token_paste',
    });

    if (!persisted.ok) {
      logWarn('karlancer_relogin_persist_partial', { error: persisted.error });
      await ctx.reply(`${MSG.SUCCESS}\n\n⚠️ ${MSG.PERSIST_WARN}`);
    } else {
      await ctx.reply(MSG.SUCCESS);
    }
    return true;
  } catch (e) {
    logWarn('karlancer_relogin_token_failed', {
      code: e?.code || 'error',
      status: e?.status || null,
    });
    await ctx.reply(MSG.BAD_TOKEN, { reply_markup: reloginChoiceKeyboard() });
    return true;
  } finally {
    void st;
  }
}

/**
 * Rate-limited soft notify for session expiry (401 on reads).
 * @param {{ notify: (chatId: number, text: string) => Promise<unknown>, ownerChatIds: number[], now?: number, cooldownMs?: number }} opts
 * @returns {Promise<boolean>}
 */
export async function maybeNotifySessionExpired({
  notify,
  ownerChatIds,
  now = Date.now(),
  cooldownMs = SESSION_EXPIRED_NOTIFY_COOLDOWN_MS,
}) {
  if (!ownerChatIds?.length || typeof notify !== 'function') return false;
  if (lastSessionExpiredNotifyAt !== 0 && now - lastSessionExpiredNotifyAt < cooldownMs) return false;
  lastSessionExpiredNotifyAt = now;
  for (const id of ownerChatIds) {
    try {
      await notify(id, MSG.SESSION_EXPIRED);
    } catch {
      /* ignore */
    }
  }
  return true;
}

export default {
  beginRelogin,
  beginTokenPaste,
  beginPasswordFallback,
  clearReloginState,
  getReloginState,
  handleReloginText,
  normalizePhone,
  extractPastedAccessToken,
  maybeNotifySessionExpired,
  MSG,
};
