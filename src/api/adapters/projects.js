/** Public project APIs — extension-confirmed */
import { KarlancerApiError } from '../errors.js';

export function createProjectsAdapter(client) {
  return {
    async resolveSlug(projectId) {
      if (!projectId) throw new KarlancerApiError('invalid_input', 'projectId required');
      let res;
      try {
        res = await client.get(`/api/publics/projects/${projectId}`, { auth: false });
      } catch (e) {
        // Karlancer answers a numeric id with HTTP 400 {status:'redirect', data:'<slug>'} (verified live).
        const body = e?.body;
        if (e?.status === 400 && body && body.status === 'redirect' && typeof body.data === 'string' && body.data) {
          return { projectId: String(projectId), slug: body.data, raw: body, redirected: true };
        }
        throw e;
      }
      const d = res.data?.data;
      const slug = typeof d === 'string' ? d : d && typeof d === 'object' ? d.url || d.slug || null : null;
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
    async search(params = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        qs.set(k, String(v));
      }
      const q = qs.toString();
      const res = await client.get(`/api/publics/search/projects${q ? `?${q}` : ''}`, { auth: false });
      const root = res.data?.data ?? res.data ?? {};
      const list = Array.isArray(root.data) ? root.data : Array.isArray(root) ? root : [];
      return {
        projects: list.map(normalizeProject).filter(Boolean),
        pagination: {
          currentPage: root.current_page ?? null,
          lastPage: root.last_page ?? null,
          perPage: root.per_page ?? null,
          total: root.total ?? list.length,
        },
        raw: res.data,
      };
    },

    async suggest(projectId) {
      const res = await client.get(`/api/publics/suggest/project/${projectId}`, { auth: false });
      const data = res.data?.data ?? res.data ?? {};
      const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
      return { projectId: String(projectId), suggestions: list.map(normalizeProject).filter(Boolean), raw: res.data };
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
    skills: (Array.isArray(proj.skills) ? proj.skills : Array.isArray(proj.tags) ? proj.tags : [])
      .map((x) => (x && typeof x === 'object' ? x.display || x.title || x.name || null : x))
      .filter(Boolean)
      .map(String),
    category:
      (proj.category && typeof proj.category === 'object' ? proj.category.title || proj.category.name : proj.category) ||
      proj.category_title ||
      (Array.isArray(proj.breadcrumbs) && proj.breadcrumbs.length ? proj.breadcrumbs[proj.breadcrumbs.length - 1]?.name : null) ||
      null,
    usersBid: proj.users_bid && typeof proj.users_bid === 'object' ? { id: proj.users_bid.id ?? null, status: proj.users_bid.status ?? null } : null,
    freelancerId: proj.freelancer_id ?? proj.worker_id ?? proj.assigned_freelancer_id ?? null,
    files: proj.files || proj.attachments || [],
    raw: proj,
  };
}
