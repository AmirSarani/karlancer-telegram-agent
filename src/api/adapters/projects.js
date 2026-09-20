/** Public project APIs — extension-confirmed */
import { KarlancerApiError } from '../errors.js';

export function createProjectsAdapter(client) {
  return {
    async resolveSlug(projectId) {
      if (!projectId) throw new KarlancerApiError('invalid_input', 'projectId required');
      const res = await client.get(`/api/publics/projects/${projectId}`, { auth: false });
      const slug = res.data?.data;
      return { projectId: String(projectId), slug: slug != null ? String(slug) : null, raw: res.data };
    },

    async getBySlug(slug) {
      if (!slug) throw new KarlancerApiError('invalid_input', 'slug required');
      const res = await client.get(`/api/publics/projects/${encodeURIComponent(slug)}`, { auth: false });
      const proj = res.data?.data || null;
      return { slug: String(slug), project: proj ? normalizeProject(proj) : null, raw: res.data };
    },

    async get(projectId, { slug } = {}) {
      let resolvedSlug = slug;
      if (!resolvedSlug) {
        const r = await this.resolveSlug(projectId);
        resolvedSlug = r.slug;
      }
      if (!resolvedSlug) {
        return { projectId: String(projectId), slug: null, project: null, status: 'unknown' };
      }
      const detail = await this.getBySlug(resolvedSlug);
      return { projectId: String(projectId), ...detail };
    },
  };
}

function normalizeProject(proj) {
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
    files: proj.files || proj.attachments || [],
    raw: proj,
  };
}
