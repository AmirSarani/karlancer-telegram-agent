/**
 * Plan 2 lite — post-win scaffold (HITL only).
 * Detect win signals from notifications / room hints; draft first client message.
 * No full delivery agent; no auto-send.
 */

export const WIN_STATE = 'WON';

/** Persian / English phrases that often mean the freelancers was selected */
export const WIN_PATTERNS = Object.freeze([
  /انتخاب\s*شد/i,
  /پروژه\s*به\s*شما/i,
  /برنده/i,
  /پذیرفته\s*شد/i,
  /قبول\s*شد/i,
  /شما\s*انتخاب/i,
  /پیشنهاد\s*شما\s*پذیرفته/i,
  /\bawarded\b/i,
  /\bhired\b/i,
  /\bselected\s+you\b/i,
  /\byou\s+won\b/i,
  /\bcongratulations\b/i,
  /تبریک/i,
]);

/**
 * @param {{ title?: string|null, body?: string|null, type?: string|null, text?: string|null }} n
 * @returns {{ isWin: boolean, reason: string|null }}
 */
export function detectWinSignal(n) {
  if (!n || typeof n !== 'object') return { isWin: false, reason: null };
  const hay = [n.title, n.body, n.text, n.type]
    .filter(Boolean)
    .map(String)
    .join('\n');
  if (!hay.trim()) return { isWin: false, reason: null };
  for (const re of WIN_PATTERNS) {
    if (re.test(hay)) {
      return { isWin: true, reason: `pattern:${re.source.slice(0, 40)}` };
    }
  }
  return { isWin: false, reason: null };
}

/**
 * @typedef {'DETECTED'|'DRAFT_READY'|'AWAITING_OWNER'|'SENT'|'CLOSED'} PostWinPhase
 */

/**
 * Scaffold state machine — in-memory / serializable snapshot only.
 * @param {object} [seed]
 * @returns {{
 *   phase: PostWinPhase,
 *   projectId: string|null,
 *   roomId: string|null,
 *   draftText: string|null,
 *   detectedAt: string|null,
 *   reasons: string[],
 * }}
 */
export function createPostWinState(seed = {}) {
  return {
    phase: seed.phase || 'DETECTED',
    projectId: seed.projectId != null ? String(seed.projectId) : null,
    roomId: seed.roomId != null ? String(seed.roomId) : null,
    draftText: seed.draftText || null,
    detectedAt: seed.detectedAt || new Date().toISOString(),
    reasons: Array.isArray(seed.reasons) ? seed.reasons : [],
  };
}

/**
 * Advance: DETECTED → DRAFT_READY (builds first client message) → AWAITING_OWNER.
 * Never auto-sends.
 * @param {object} state
 * @param {{ guestName?: string, projectTitle?: string }} [ctx]
 */
export function advancePostWin(state, ctx = {}) {
  const s = createPostWinState(state);
  if (s.phase === 'DETECTED' || s.phase === 'DRAFT_READY') {
    s.draftText = buildFirstClientMessageDraft({
      guestName: ctx.guestName,
      projectTitle: ctx.projectTitle,
      projectId: s.projectId,
    });
    s.phase = 'AWAITING_OWNER';
    s.reasons = [...s.reasons, 'پیش‌نویس پیام اول آماده — فقط با تأیید مالک ارسال می‌شود'];
  }
  return s;
}

/**
 * Persian first-message draft after win (HITL).
 */
export function buildFirstClientMessageDraft({ guestName, projectTitle, projectId } = {}) {
  const name = guestName ? String(guestName).slice(0, 40) : 'کارفرمای گرامی';
  const title = projectTitle ? `«${String(projectTitle).slice(0, 60)}»` : 'پروژه';
  const lines = [
    `سلام ${name} 👋`,
    '',
    `از انتخابم برای ${title} سپاسگزارم.`,
    'برای شروع، لطفاً این موارد را بفرستید:',
    '۱) خلاصهٔ نیاز و اولویت‌ها',
    '۲) فایل‌ها / لینک‌های مرتبط',
    '۳) مهلت یا نقطهٔ عطف اول',
    '',
    'به‌محض دریافت، برنامهٔ کار و اولین تحویل را پیشنهاد می‌دهم.',
  ];
  if (projectId) {
    /* keep human — no raw ids in client message */
  }
  return lines.join('\n');
}

/**
 * Scan notification list → win candidates (no side effects).
 * @param {object[]} notifications
 * @returns {{ wins: object[], skipped: number }}
 */
export function scanNotificationsForWins(notifications = []) {
  const wins = [];
  let skipped = 0;
  for (const n of notifications) {
    const det = detectWinSignal(n);
    if (!det.isWin) {
      skipped += 1;
      continue;
    }
    wins.push({
      notification: n,
      signal: det,
      state: createPostWinState({
        phase: 'DETECTED',
        projectId: n.raw?.project_id || n.raw?.projectId || null,
        roomId: n.raw?.room_id || n.raw?.roomId || null,
        reasons: [det.reason],
      }),
    });
  }
  return { wins, skipped };
}

/**
 * Persian Telegram section for «پس از برد».
 */
export function formatPostWinSectionFa(state) {
  if (!state) {
    return [
      '🏆 پس از برد',
      '————————',
      'هنوز سیگنال بردی شناسایی نشده.',
      'پس از تشخیص، پیش‌نویس پیام اول برای تأیید شما ساخته می‌شود (ارسال خودکار نیست).',
    ].join('\n');
  }
  const s = createPostWinState(state);
  return [
    '🏆 پس از برد',
    '————————',
    `فاز: ${phaseFa(s.phase)}`,
    s.projectId ? `پروژه: ${s.projectId}` : null,
    s.draftText ? `\nپیش‌نویس پیام اول:\n${s.draftText}` : null,
    '',
    '⚠️ ارسال فقط با تأیید دستی (HITL). ایجنت تحویل کامل فعلاً فعال نیست.',
  ]
    .filter((l) => l != null)
    .join('\n');
}

function phaseFa(p) {
  switch (p) {
    case 'DETECTED':
      return 'تشخیص داده شد';
    case 'DRAFT_READY':
      return 'پیش‌نویس آماده';
    case 'AWAITING_OWNER':
      return 'در انتظار تأیید شما';
    case 'SENT':
      return 'ارسال شد';
    case 'CLOSED':
      return 'بسته';
    default:
      return String(p || '—');
  }
}

export default {
  detectWinSignal,
  createPostWinState,
  advancePostWin,
  buildFirstClientMessageDraft,
  scanNotificationsForWins,
  formatPostWinSectionFa,
  WIN_STATE,
};
