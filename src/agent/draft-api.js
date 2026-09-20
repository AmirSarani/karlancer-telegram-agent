/**
 * Deterministic outbound reply skeleton from structured API fields.
 * LLM must NOT be used here — only template assembly.
 */
import { stripHtml } from './message-normalize.js';

/**
 * Build a Persian reply draft from room / project / last messages.
 * @param {object} ctx
 * @param {string|number} [ctx.roomId]
 * @param {string} [ctx.guestName]
 * @param {object|null} [ctx.project]
 * @param {Array<{text?: string, isOwn?: boolean|null}>} [ctx.messages]
 * @param {string} [ctx.ownerNote]
 * @param {{ price?: number, days?: number }} [ctx.proposal]
 */
export function buildDraftReply(ctx = {}) {
  const guest = ctx.guestName || 'کارفرما';
  const project = ctx.project || {};
  const title = project.title || ctx.projectTitle || null;
  const minB = project.minBudget ?? project.min_budget ?? null;
  const maxB = project.maxBudget ?? project.max_budget ?? null;
  const duration = project.jobDuration ?? project.job_duration ?? project.duration ?? null;
  const fulltime = project.isFulltime ?? project.is_fulltime ?? null;
  const proposal = ctx.proposal || {};

  const lastEmployer = [...(ctx.messages || [])]
    .reverse()
    .find((m) => m && m.isOwn !== true && String(m.text || '').trim());
  const employerSnippet = lastEmployer
    ? stripHtml(lastEmployer.text).replace(/\s+/g, ' ').trim().slice(0, 180)
    : '';

  const lines = [];
  lines.push(`سلام ${guest}، وقت بخیر.`);
  if (title) {
    lines.push(`پروژه «${title}» را دیدم.`);
  } else {
    lines.push('پیامتان را خواندم.');
  }

  if (employerSnippet) {
    lines.push(`در مورد درخواستتان («${employerSnippet}${employerSnippet.length >= 180 ? '…' : ''}») آماده‌ام همکاری کنم.`);
  } else {
    lines.push('آماده همکاری هستم و می‌توانم طبق توضیحات پیش بروم.');
  }

  const bits = [];
  if (proposal.price != null && Number(proposal.price) > 0) {
    bits.push(`پیشنهاد هزینه: ${formatToman(proposal.price)}`);
  } else if (minB != null || maxB != null) {
    bits.push(`بودجه اعلام‌شده: ${formatBudgetRange(minB, maxB)}`);
  }
  if (proposal.days != null && Number(proposal.days) > 0) {
    bits.push(`مدت پیشنهادی: ${Number(proposal.days)} روز`);
  } else if (duration != null) {
    bits.push(`مدت پروژه (اعلامی): ${duration} روز`);
  }
  if (fulltime === true || fulltime === 1) {
    bits.push('پروژه تمام‌وقت است — ظرفیت و هماهنگی را در نظر می‌گیرم.');
  }
  if (bits.length) {
    lines.push(bits.join(' · '));
  }

  lines.push('اگر موافقید بفرمایید تا جزئیات تحویل و زمان‌بندی را دقیق‌تر هماهنگ کنیم.');

  if (ctx.ownerNote && String(ctx.ownerNote).trim()) {
    // Deterministic note merge (not LLM) — keep short
    lines.push('');
    lines.push(`نکته تکمیلی: ${String(ctx.ownerNote).trim().slice(0, 400)}`);
  }

  const text = lines.filter(Boolean).join('\n');
  return {
    text,
    source: 'template',
    meta: {
      roomId: ctx.roomId != null ? String(ctx.roomId) : null,
      projectId: project.id != null ? String(project.id) : null,
      hasNote: Boolean(ctx.ownerNote && String(ctx.ownerNote).trim()),
    },
  };
}

function formatToman(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return `${num.toLocaleString('fa-IR')} تومان`;
}

function formatBudgetRange(minB, maxB) {
  if (minB != null && maxB != null) return `${formatToman(minB)} – ${formatToman(maxB)}`;
  if (minB != null) return `از ${formatToman(minB)}`;
  if (maxB != null) return `تا ${formatToman(maxB)}`;
  return '—';
}

export default { buildDraftReply };
