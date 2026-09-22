/**
 * Deterministic outbound reply skeleton from structured API fields.
 * LLM must NOT be used here — only template assembly + human cleaning.
 */
import { stripHtml } from './message-normalize.js';
import { cleanHumanReply } from './reply-clean.js';

/**
 * Build a Persian reply draft from room / project / last messages.
 * Sounds like a real freelancer: greeting → understanding → help → approach → invite.
 * Never dumps project titles in quotes, never auto-prices, never exposes IDs.
 *
 * @param {object} ctx
 * @param {string|number} [ctx.roomId]
 * @param {string} [ctx.guestName]
 * @param {object|null} [ctx.project]
 * @param {Array<{text?: string, isOwn?: boolean|null}>} [ctx.messages]
 * @param {string} [ctx.ownerNote]
 * @param {{ price?: number, days?: number }} [ctx.proposal]
 * @param {boolean} [ctx.includePrice=false] only when employer asked / owner forced
 */
export function buildDraftReply(ctx = {}) {
  const guest = sanitizeName(ctx.guestName) || 'کارفرما';
  const project = ctx.project || {};
  const title = project.title || ctx.projectTitle || null;
  const includePrice = Boolean(ctx.includePrice);
  const proposal = ctx.proposal || {};

  const lastEmployer = [...(ctx.messages || [])]
    .reverse()
    .find((m) => m && m.isOwn !== true && String(m.text || '').trim());
  const employerSnippet = lastEmployer
    ? stripHtml(lastEmployer.text).replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';

  const askedPrice =
    includePrice ||
    /قیمت|هزینه|بودجه|چقدر|نرخ|پیشنهاد\s*مالی/i.test(employerSnippet);

  const lines = [];
  lines.push(`سلام ${guest}، وقت بخیر.`);

  if (employerSnippet && employerSnippet.length > 8) {
    lines.push('پیامتان را خواندم و متوجه نیازتان شدم.');
  } else if (title) {
    lines.push('شرح پروژه را مرور کردم و تصویر کلی کار دستم آمد.');
  } else {
    lines.push('پیامتان را خواندم.');
  }

  lines.push(
    'می‌توانم روی همین موضوع کمک کنم و کار را شفاف و مرحله‌به‌مرحله جلو ببرم.'
  );

  lines.push(
    'رویکرد من این است که اول خروجی و فرضیات را جمع‌بندی کنیم، بعد روی زمان و جزئیات اجرا توافق کنیم.'
  );

  if (askedPrice) {
    if (proposal.price != null && Number(proposal.price) > 0) {
      lines.push(`از نظر هزینه، پیشنهاد اولیه حدود ${formatToman(proposal.price)} است.`);
    } else if (proposal.days != null && Number(proposal.days) > 0) {
      lines.push(`از نظر زمان، حدود ${Number(proposal.days)} روز کاری تخمین می‌زنم.`);
    }
  }

  lines.push(
    'اگر موافقید بفرمایید تا جزئیات را با هم مرور کنیم و بهترین مسیر را انتخاب کنیم.'
  );

  if (ctx.ownerNote && String(ctx.ownerNote).trim()) {
    const note = String(ctx.ownerNote).trim().slice(0, 280);
    if (note && !/^(لطفاً?\s*)?پیش‌نویس را/i.test(note)) {
      lines.push(note);
    }
  }

  const raw = lines.filter(Boolean).join('\n');
  const text = cleanHumanReply(raw);

  return {
    text,
    source: 'template',
    meta: {
      roomId: ctx.roomId != null ? String(ctx.roomId) : null,
      projectId: project.id != null ? String(project.id) : null,
      hasNote: Boolean(ctx.ownerNote && String(ctx.ownerNote).trim()),
      cleaned: true,
    },
  };
}

function sanitizeName(name) {
  const s = String(name || '')
    .replace(/[<>{}[\]«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (!s || /^[-—_]+$/.test(s)) return '';
  return s;
}

function formatToman(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return `${num.toLocaleString('fa-IR')} تومان`;
}

export default { buildDraftReply };
