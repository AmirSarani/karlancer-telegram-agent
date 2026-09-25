/**
 * Split long Telegram text into sequential messages (limit 4096; we use a safety margin).
 * Prefers paragraph → line → sentence → word boundaries. Never cuts inside a surrogate pair,
 * an HTML tag (`<...>`) or an HTML entity (`&...;`), and never leaves a ZWNJ dangling.
 */
export const TELEGRAM_SAFE_MAX = 3900;

function safeCutIndex(text, max) {
  let cut = Math.min(max, text.length);
  if (cut >= text.length) return text.length;
  const window = text.slice(0, cut);
  const minGood = Math.floor(max * 0.5);
  const tryAt = (idx, extra = 0) => (idx >= minGood ? idx + extra : -1);
  let idx = tryAt(window.lastIndexOf('\n\n'), 2);
  if (idx < 0) idx = tryAt(window.lastIndexOf('\n'), 1);
  if (idx < 0) {
    const m = [...window.matchAll(/[.!?؟。]\s/g)].pop();
    idx = m ? tryAt(m.index, 2) : -1;
  }
  if (idx < 0) idx = tryAt(window.lastIndexOf(' '), 1);
  if (idx > 0) cut = idx;
  // never split a surrogate pair
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  // never split an HTML tag / entity
  const head = text.slice(0, cut);
  const lt = head.lastIndexOf('<');
  if (lt > head.lastIndexOf('>')) cut = lt;
  const amp = head.lastIndexOf('&');
  if (amp >= 0 && amp > head.lastIndexOf(';') && cut - amp < 12 && /^&[#a-zA-Z0-9]*$/.test(head.slice(amp))) cut = amp;
  // do not start the next part with a ZWNJ
  while (cut > 1 && text[cut] === '\u200c') cut -= 1;
  return Math.max(1, cut);
}

/**
 * @param {string} text
 * @param {{ max?: number, numbered?: boolean }} [opts]
 * @returns {string[]}
 */
export function splitTelegramText(text, { max = TELEGRAM_SAFE_MAX, numbered = true } = {}) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const room = numbered ? max - 12 : max;
  const parts = [];
  let rest = s;
  while (rest.length > room) {
    const cut = safeCutIndex(rest, room);
    parts.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  if (!numbered || parts.length < 2) return parts;
  const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  return parts.map((p, i) => `${p}\n\n(${fa(i + 1)} از ${fa(parts.length)})`);
}

export default splitTelegramText;
