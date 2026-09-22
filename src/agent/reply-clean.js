/**
 * Post-process AI / template reply drafts into natural Persian freelancer text.
 * Pure helpers — no network, no secrets.
 */

/** Phrases / patterns that sound robotic when auto-injected into drafts. */
const ROBOTIC_LINE_RE =
  /^(پروژه\s*[«"'].*[»"']\s*را\s*دیدم\.?|با\s*توجه\s*به\s*درخواستتان.*|آماده‌?ام\s*همکاری\s*کنم\.?|آماده\s*همکاری\s*هستم\s*و\s*می‌توانم.*|نکته\s*تکمیلی\s*:.*)$/i;

const TECH_LEAK_RE =
  /\b(blocked_by_missing_api|roomId|projectId|project_slug|verifiedmutation|messages\.send)\b/gi;

/**
 * Clean a draft reply so it reads like a real freelancer wrote it.
 * @param {string} text
 * @returns {string}
 */
export function cleanHumanReply(text) {
  let s = String(text || '');
  if (!s.trim()) return '';

  // Normalize newlines / NBSP
  s = s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');

  // Preserve redaction markers; never leak raw Bearer tokens
  s = s.replace(/Bearer\s+\[REDACTED\]/gi, '[REDACTED]');
  s = s.replace(/Bearer\s+\S+/gi, '[REDACTED]');

  // Drop obvious tech / API leaks early
  s = s.replace(TECH_LEAK_RE, '');

  // Remove unfinished ellipsis-only / placeholder lines
  s = s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return true; // keep blank for paragraph structure (collapsed later)
      if (/^[.…\-_]+$/.test(line)) return false;
      if (/^(TODO|FIXME|null|undefined|N\/A)$/i.test(line)) return false;
      if (ROBOTIC_LINE_RE.test(line)) return false;
      return true;
    })
    .join('\n');

  // Soften classic robotic wrappers: پروژه «X» را دیدم → drop whole clause if alone
  s = s.replace(/پروژه\s*[«"']([^»"']{0,80})[»"']\s*را\s*دیدم\.?/gi, '');
  s = s.replace(/با\s*توجه\s*به\s*درخواستتان\s*[(\[«"']([^)\]»"']{0,200})[)\]»"']\s*/gi, '');
  s = s.replace(/در\s*مورد\s*درخواستتان\s*[(\[«"']([^)\]»"']{0,200})[)\]»"']\s*/gi, '');
  s = s.replace(/آماده‌?ام\s*همکاری\s*کنم\.?/gi, '');
  s = s.replace(/می‌باشد\.?/g, 'است.');

  // Strip decorative wrapping quotes/parens that dump project titles mid-sentence
  // Keep meaningful punctuation: ؟ ! . ، :
  // Protect redaction markers from wrapper stripping
  s = s.replace(/\[REDACTED\]/g, '§REDACTED§');
  s = stripUnneededWrappers(s);
  s = s.replace(/§REDACTED§/g, '[REDACTED]');

  // Collapse whitespace (preserve paragraph breaks)
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');

  // Fix broken punctuation: double marks, space before ، ؟ !
  s = s
    .replace(/\s+([،.؟!…])/g, '$1')
    .replace(/([،]){2,}/g, '،')
    .replace(/([.؟!]){3,}/g, '$1$1')
    .replace(/([.؟!]){2}(?![.؟!])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/«\s*»/g, '')
    .replace(/"\s*"/g, '')
    .replace(/'\s*'/g, '');

  // Remove empty paren leftovers after cleaning
  s = s.replace(/\(\s*[،.]?\s*\)/g, '');

  // Collapse spaces again after removals
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Soft length cap for Telegram draft display
  if (s.length > 3500) s = s.slice(0, 3490).trimEnd() + '…';

  return s;
}

/**
 * Remove (), [], {}, <>, «», "", '' when they wrap non-essential dumped titles
 * or appear as orphaned decorative wrappers — keep content when the wrapper
 * looks intentional (short clarifying asides under ~40 chars without IDs).
 * @param {string} s
 */
function stripUnneededWrappers(s) {
  // Angle / curly braces almost never belong in freelancer chat
  let out = s.replace(/[<>{}]/g, '');

  // Strip wrappers that clearly dump long project / request dumps
  out = out.replace(/[(\[«"']([^)\]»"'\n]{40,})[)\]»"']/g, (_, inner) => {
    const t = String(inner).trim();
    // If it looks like a pasted brief, drop the wrapper+content from the reply
    if (/بودجه|پروژه|اسلاگ|slug|id\s*[:=]|room/i.test(t) || t.length > 80) {
      return '';
    }
    return t; // keep short aside without wrappers
  });

  // Remaining paired wrappers with short content → unwrap to plain text
  out = out.replace(/[(\[«"']([^)\]»"'\n]{1,39})[)\]»"']/g, (_, inner) => {
    const t = String(inner).trim();
    if (!t) return '';
    // Keep if it looks like a natural short clarification (no digits-only IDs)
    if (/^\d{4,}$/.test(t)) return '';
    return t;
  });

  return out;
}

/**
 * Detect message sender label for User View.
 * @param {{ isOwn?: boolean|null, fromSelf?: boolean|null, sender?: string, role?: string }} m
 * @returns {'you'|'employer'|'unknown'}
 */
export function detectMessageSender(m = {}) {
  if (m.isOwn === true || m.fromSelf === true) return 'you';
  if (m.isOwn === false || m.fromSelf === false) return 'employer';
  const role = String(m.sender || m.role || m.from || '').toLowerCase();
  if (/own|self|me|freelancer|you|من|شما/.test(role)) return 'you';
  if (/guest|employer|client|کارفرما|employer/.test(role)) return 'employer';
  return 'unknown';
}

export default { cleanHumanReply, detectMessageSender };
