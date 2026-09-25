/**
 * Owner notices after the worker actually sends (or fails to send) a message / bid.
 * Plain Persian, no technical jargon. Pure formatters (tested).
 */

const BLOCK_REASON_FA = Object.freeze({
  superseded_by_newer_send: 'برای این گفتگو پیام تازه‌تری قبلاً رفته بود؛ این پیش‌نویس ارسال نشد تا تکراری نشود.',
  approval_not_approved: 'تأیید این پیام ثبت نشده بود.',
  approval_expired: 'مهلت تأیید این پیام تمام شده بود.',
  missing_approval: 'تأیید این پیام پیدا نشد.',
  payload_mismatch: 'متن پیام بعد از تأیید تغییر کرده بود؛ برای امنیت ارسال نشد.',
  payload_hash_mismatch: 'متن پیام بعد از تأیید تغییر کرده بود؛ برای امنیت ارسال نشد.',
  target_ref_mismatch: 'مقصد پیام با تأیید یکی نبود؛ ارسال نشد.',
  unknown_side_effect: 'وضعیت ارسال نامشخص است؛ پیش از ارسال دوباره، گفتگو را در کارلنسر ببینید.',
  unexpected_status: 'کارلنسر پاسخ غیرمنتظره داد؛ گفتگو را در کارلنسر بررسی کنید.',
  unauthorized: 'ورود به کارلنسر منقضی شده؛ از «امنیت» دوباره وارد شوید.',
  blocked_by_missing_api: 'مسیر ارسال هنوز آماده نیست.',
  bid_not_visible_yet: 'پیشنهاد ثبت شد ولی هنوز در کارلنسر دیده نمی‌شود؛ چند دقیقهٔ دیگر بررسی کنید.',
});

export function blockReasonFa(code) {
  return BLOCK_REASON_FA[String(code || '')] || 'ارسال انجام نشد.';
}

function who(guestName) {
  const g = String(guestName || '').replace(/[<>{}]/g, '').trim().slice(0, 40);
  return g || 'کارفرما';
}

/**
 * @param {{ guestName?: string, auto?: boolean, followUp?: boolean, textPreview?: string }} p
 */
export function formatMessageSentNotice(p = {}) {
  const head = p.followUp
    ? `🔁 پیام پیگیری برای ${who(p.guestName)} در کارلنسر ارسال شد.`
    : p.auto
      ? `🤖 پاسخ خودکار برای ${who(p.guestName)} در کارلنسر ارسال شد.`
      : `✅ پیام شما برای ${who(p.guestName)} در کارلنسر ارسال شد.`;
  const lines = [head];
  const prev = String(p.textPreview || '').trim();
  if (prev) lines.push('', `«${prev.slice(0, 160)}${prev.length > 160 ? '…' : ''}»`);
  lines.push('', 'گفتگو به بخش «جواب‌داده‌شده‌ها» رفت.');
  return lines.join('\n');
}

/**
 * @param {{ guestName?: string, code?: string, auto?: boolean }} p
 */
export function formatMessageBlockedNotice(p = {}) {
  return [
    `⚠️ پیام برای ${who(p.guestName)} ارسال نشد.`,
    blockReasonFa(p.code),
    '',
    'از «گفتگوها» پیش‌نویس را ببینید و در صورت نیاز دوباره تأیید کنید.',
  ].join('\n');
}

/**
 * @param {{ code?: string, projectTitle?: string }} p
 */
export function formatBidBlockedNotice(p = {}) {
  return [
    '⚠️ ثبت پیشنهاد کامل نشد.',
    blockReasonFa(p.code),
    '',
    'از «فرصت‌ها» یا «تأییدها» وضعیت را بررسی کنید.',
  ].join('\n');
}

export default { formatMessageSentNotice, formatMessageBlockedNotice, formatBidBlockedNotice, blockReasonFa };
