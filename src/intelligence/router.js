/**
 * Deterministic command / intent router — avoids LLM for simple ops.
 */
const PATTERNS = [
  { intent: 'health', re: /^(health|ping|سلامت)/i },
  { intent: 'job_status', re: /^(status|وضعیت|job)\b/i },
  { intent: 'list_rooms', re: /(scan|اسکن|rooms|دعوت)/i },
  { intent: 'get_project', re: /(project|پروژه)\s*(\d+)/i },
  { intent: 'check_bid', re: /(bid|پیشنهاد).*check|چک.*bid/i },
  { intent: 'approve', re: /^\/?approve/i },
  { intent: 'reject', re: /^\/?reject/i },
  { intent: 'pause', re: /^\/?pause/i },
  { intent: 'resume', re: /^\/?resume/i },
  { intent: 'analyze_project', re: /(تحلیل|analyze)/i },
  { intent: 'write_proposal', re: /(پیشنهاد بنویس|write proposal|draft)/i },
  { intent: 'pricing', re: /(قیمت|pricing|budget)/i },
  { intent: 'memory_search', re: /(memory|حافظه|جستجو)/i },
];

export function routeIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'unknown', ambiguity: 1, slots: {} };
  for (const p of PATTERNS) {
    const m = t.match(p.re);
    if (m) {
      const slots = {};
      if (p.intent === 'get_project' && m[2]) slots.projectId = m[2];
      return { intent: p.intent, ambiguity: 0.1, slots, raw: t };
    }
  }
  return { intent: 'unknown', ambiguity: 0.9, slots: {}, raw: t };
}

export default routeIntent;
