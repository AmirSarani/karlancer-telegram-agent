/** @param {object} proj */
export function normalizeProject(proj) {
  if (!proj || typeof proj !== 'object') return null;
  return {
    id: proj.id != null ? String(proj.id) : null,
    title: proj.title || null,
    description: proj.description || proj.desc || proj.body || null,
    budget: proj.budget ?? proj.price ?? proj.price_range ?? null,
    minBudget: proj.min_budget ?? proj.minBudget ?? null,
    maxBudget: proj.max_budget ?? proj.maxBudget ?? null,
    jobDuration: proj.job_duration ?? proj.jobDuration ?? null,
    hireDeadline: proj.hire_deadline ?? proj.hireDeadline ?? null,
    isFulltime: proj.is_fulltime ?? proj.isFulltime ?? null,
    isUrgent: proj.is_urgent ?? proj.isUrgent ?? null,
    isExpired: proj.is_expired ?? proj.isExpired ?? null,
    slug: proj.url || proj.slug || null,
    state: proj.state || proj.status || null,
    freelancerId: proj.freelancer_id ?? proj.worker_id ?? proj.assigned_freelancer_id ?? null,
    skills: proj.skills || proj.skill_list || [],
    files: Array.isArray(proj.files || proj.attachments)
      ? (proj.files || proj.attachments).map(normalizeFileMeta).filter(Boolean)
      : [],
    raw: proj,
  };
}

/** Safe file metadata — never expose naked private download URLs as "ready to fetch". */
export function normalizeFileMeta(f) {
  if (!f || typeof f !== 'object') return null;
  const name = f.name || f.filename || f.title || null;
  const mime = f.mime || f.mime_type || f.type || null;
  const size = f.size ?? f.filesize ?? null;
  const id = f.id != null ? String(f.id) : null;
  // Public CDN/seo paths are ok to echo as path hints; private storage URLs are redacted.
  const url = typeof f.url === 'string' ? f.url : null;
  const safeUrl =
    url && /\/api\/file\/seoContents\//i.test(url)
      ? url
      : url
        ? '[redacted_private_or_unknown_url]'
        : null;
  return { id, name, mime, size, url: safeUrl };
}
