/** Bid check (confirmed) + submit try-list (unverified) */
import { KarlancerApiError } from '../errors.js';

export function createBidsAdapter(client) {
  return {
    async check(projectIds) {
      const ids = (Array.isArray(projectIds) ? projectIds : [projectIds]).filter(Boolean);
      if (!ids.length) throw new KarlancerApiError('invalid_input', 'projectIds required');
      const qs = ids.map((id, i) => `projectIds[${i}]=${encodeURIComponent(id)}`).join('&');
      const res = await client.get(`/api/check-bid?${qs}`);
      const map = res.data?.data?.has_submitted_bid || {};
      return {
        hasSubmittedBid: map,
        weBidFor: (id) => Boolean(map[id] || map[String(id)]),
        raw: res.data,
      };
    },

    /**
     * Unverified bid submit — extension try-list only.
     * MUST be gated by approval. Returns blocked_by_missing_api if no 2xx.
     */
    async submit({ projectId, proposalText, price, days }) {
      if (!projectId) throw new KarlancerApiError('invalid_input', 'projectId required');
      if (!proposalText) throw new KarlancerApiError('invalid_input', 'proposalText required');
      const p = Number(price);
      const d = Number(days);
      const description = String(proposalText);
      const bodies = [
        { project_id: Number(projectId), bid_price: p, bid_duration: d, bid_description: description },
        { project_id: Number(projectId), price: p, duration: d, description },
        { project_id: Number(projectId), amount: p, days: d, message: description },
      ];
      const paths = ['/api/bids', '/api/projects/bid', `/api/projects/${projectId}/bids`];
      const candidates = [];
      for (const path of paths) {
        for (const body of bodies) {
          candidates.push({ path, body, shape: Object.keys(body).join(',') });
        }
      }
      const result = await client.tryPost(candidates, { label: 'submit_bid' });
      if (result.ok) {
        return { ok: true, endpoint: result.path, shape: result.shape, attempts: result.attempts, data: result.data };
      }
      return {
        ok: false,
        status: 'blocked_by_missing_api',
        reason: 'definitive_bid_endpoint_unverified',
        attempts: result.attempts,
        error: result.error?.message || 'bid submit failed',
      };
    },
  };
}
