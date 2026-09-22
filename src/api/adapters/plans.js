/** Plans — HAR GET /api/plans and GET /api/plans/{id}/skills */
export function createPlansAdapter(client) {
  return {
    async list() {
      const res = await client.get('/api/plans');
      const data = res.data?.data ?? res.data ?? [];
      return { plans: Array.isArray(data) ? data : data.plans || [], raw: res.data };
    },
    async skills(planId, { ids, projectId } = {}) {
      const qs = new URLSearchParams();
      if (ids) qs.set('ids', Array.isArray(ids) ? ids.join(',') : String(ids));
      if (projectId != null) qs.set('project_id', String(projectId));
      const q = qs.toString();
      const res = await client.get(`/api/plans/${planId}/skills${q ? `?${q}` : ''}`);
      return { planId: String(planId), skills: res.data?.data ?? res.data, raw: res.data };
    },
  };
}
