/**
 * Public search & suggestions — HAR:
 * GET /api/publics/search/projects
 * GET /api/publics/suggest/project/{id}
 * GET /api/publics/category-page
 */
import { normalizeProject } from '../models/project.js';
import { extractLaravelPage } from '../util/pagination.js';

export function createSearchAdapter(client) {
  return {
    async projects(params = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        qs.set(k, String(v));
      }
      const q = qs.toString();
      const res = await client.get(`/api/publics/search/projects${q ? `?${q}` : ''}`, {
        auth: false,
      });
      const { items, pagination } = extractLaravelPage(res.data);
      return {
        projects: items.map(normalizeProject).filter(Boolean),
        pagination,
        raw: res.data,
      };
    },

    async suggestForProject(projectId) {
      const res = await client.get(`/api/publics/suggest/project/${projectId}`, { auth: false });
      const data = res.data?.data ?? res.data ?? {};
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data.projects)
          ? data.projects
          : Array.isArray(data.data)
            ? data.data
            : [];
      return {
        projectId: String(projectId),
        suggestions: list.map(normalizeProject).filter(Boolean),
        raw: res.data,
      };
    },

    async categoryPage(params = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') continue;
        qs.set(k, String(v));
      }
      const q = qs.toString();
      const res = await client.get(`/api/publics/category-page${q ? `?${q}` : ''}`, { auth: false });
      return { data: res.data?.data ?? res.data, raw: res.data };
    },
  };
}
