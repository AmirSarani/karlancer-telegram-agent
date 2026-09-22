/**
 * Message normalizer — strip HTML, extract project slugs / attachments.
 * Pure helpers; no network.
 */

/**
 * Strip HTML tags and decode a few common entities. Keep readable text.
 * @param {string} html
 */
export function stripHtml(html) {
  if (html == null) return '';
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*p\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&zwnj;/gi, '\u200c');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract Karlancer project slug from message HTML or plain text.
 * Prefers /projects/{slug} path segments.
 * @param {string} textOrHtml
 * @returns {string|null}
 */
export function extractProjectSlug(textOrHtml) {
  if (!textOrHtml) return null;
  const s = String(textOrHtml);
  // Allow percent-encoded segments (Persian slugs in hrefs)
  const m =
    s.match(/\/projects\/([A-Za-z0-9%\u0600-\u06FF._\-]+)/i) ||
    s.match(/karlancer\.com\/projects\/([A-Za-z0-9%\u0600-\u06FF._\-]+)/i);
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep raw */
  }
  slug = slug.replace(/\/+$/, '').split(/[?#]/)[0];
  return slug || null;
}

/**
 * Detect attachment / file / photo URLs if the API exposes them on the raw message.
 * Never invents URLs.
 * @param {object} raw
 * @returns {{ kind: string, url: string, name?: string }[]}
 */
export function extractAttachments(raw) {
  if (!raw || typeof raw !== 'object') return [];
  /** @type {{ kind: string, url: string, name?: string }[]} */
  const out = [];
  const seen = new Set();

  function push(kind, url, name) {
    if (!url || typeof url !== 'string') return;
    const u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://') && !u.startsWith('/')) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push({ kind, url: u, name: name || undefined });
  }

  const lists = [
    raw.files,
    raw.attachments,
    raw.media,
    raw.images,
    raw.photos,
    raw.file,
  ];
  for (const list of lists) {
    if (!list) continue;
    const arr = Array.isArray(list) ? list : [list];
    for (const item of arr) {
      if (!item) continue;
      if (typeof item === 'string') {
        push(guessKind(item), item);
        continue;
      }
      if (typeof item === 'object') {
        const url =
          item.url ||
          item.src ||
          item.path ||
          item.file_url ||
          item.download_url ||
          item.href ||
          null;
        const name = item.name || item.filename || item.title || undefined;
        const kind =
          item.kind ||
          item.type ||
          (item.mime && String(item.mime).startsWith('image/') ? 'photo' : null) ||
          guessKind(url || name || '');
        push(kind, url, name);
      }
    }
  }

  // Sometimes a single file_* field
  for (const key of ['file_url', 'image_url', 'photo_url', 'attachment_url']) {
    if (raw[key]) push(guessKind(String(raw[key])), String(raw[key]));
  }

  return out;
}

function guessKind(s) {
  const t = String(s || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(t) || t.includes('image')) return 'photo';
  if (/\.(pdf|docx?|xlsx?|zip|rar)(\?|$)/i.test(t)) return 'file';
  return 'file';
}

/**
 * Normalize a raw Karlancer message into a stable shape.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeInboundMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.message_id ?? raw.uuid ?? null;
  const rawText = String(
    raw.message ?? raw.text ?? raw.body ?? raw.content ?? raw.last_message ?? ''
  );
  const text = stripHtml(rawText);
  let isOwn = null;
  if (typeof raw.is_me === 'boolean') isOwn = raw.is_me;
  else if (typeof raw.is_mine === 'boolean') isOwn = raw.is_mine;
  else if (typeof raw.from_me === 'boolean') isOwn = raw.from_me;

  const projectId =
    raw.project_id != null
      ? String(raw.project_id)
      : raw.projectId != null
        ? String(raw.projectId)
        : null;
  const slug = extractProjectSlug(rawText) || extractProjectSlug(text);
  const attachments = extractAttachments(raw);

  return {
    id: id != null ? String(id) : null,
    text,
    textHtml: rawText !== text ? rawText : null,
    createdAt: raw.created_at || raw.createdAt || raw.date || null,
    projectId,
    projectSlug: slug,
    userId:
      raw.user_id != null ? String(raw.user_id) : raw.userId != null ? String(raw.userId) : null,
    isOwn,
    attachments,
    raw,
  };
}

/**
 * Dedupe helper: filter messages whose id is already in seenIds.
 * @param {Array<{id?: string|null}>} messages
 * @param {Set<string>|string[]} seenIds
 * @returns {{ fresh: object[], seen: Set<string> }}
 */
export function dedupeMessages(messages, seenIds) {
  const seen = seenIds instanceof Set ? new Set(seenIds) : new Set(seenIds || []);
  const fresh = [];
  for (const m of messages || []) {
    if (!m?.id) {
      // No id — treat as fresh once (caller should still persist carefully)
      fresh.push(m);
      continue;
    }
    if (seen.has(String(m.id))) continue;
    seen.add(String(m.id));
    fresh.push(m);
  }
  return { fresh, seen };
}

/**
 * Compare room updated_at / unread against cursor to decide if refetch needed.
 * @param {{ unread?: number|null, updatedAt?: string|null, id?: string|null }} room
 * @param {{ lastUpdatedAt?: string|null, lastMessageId?: string|null }|null} cursor
 */
export function roomNeedsFetch(room, cursor) {
  if (!room) return false;
  if (Number(room.unread) > 0) return true;
  if (!cursor?.lastUpdatedAt) return true;
  const roomTs = Date.parse(room.updatedAt || '') || 0;
  const curTs = Date.parse(cursor.lastUpdatedAt || '') || 0;
  return roomTs > curTs;
}

export default {
  stripHtml,
  extractProjectSlug,
  extractAttachments,
  normalizeInboundMessage,
  dedupeMessages,
  roomNeedsFetch,
};
