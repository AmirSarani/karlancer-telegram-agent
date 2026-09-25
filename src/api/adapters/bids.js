/** Bid check (confirmed) + submit via VerifiedMutationContract only */
import crypto from 'node:crypto';
import { KarlancerApiError } from '../errors.js';
import {
  executeVerifiedMutation,
  getVerifiedMutation,
  bidIdempotencyKey,
} from '../contracts/verified-mutation.js';

export function createBidsAdapter(client) {
  return {
    async check(projectIds) {
      const ids = (Array.isArray(projectIds) ? projectIds : [projectIds]).filter(Boolean);
      if (!ids.length) throw new KarlancerApiError('invalid_input', 'projectIds required');
      const qs = ids.map((id, i) => `projectIds[${i}]=${encodeURIComponent(id)}`).join('&');
      const res = await client.get(`/api/check-bid?${qs}`);
      const map = res.data?.data?.has_submitted_bid || {};
      const pagination = extractPagination(res.data);
      return {
        hasSubmittedBid: map,
        weBidFor: (id) => Boolean(map[id] || map[String(id)]),
        pagination,
        raw: res.data,
        normalized: { projectIds: ids.map(String), hasSubmittedBid: map },
      };
    },

    /**
     * Submit bid — ONLY via VerifiedMutationContract.
     * Until contract evidence exists: NO POST, return blocked_by_missing_api.
     */
    async submit({ projectId, proposalText, price, days, operationId }) {
      if (!projectId) throw new KarlancerApiError('invalid_input', 'projectId required');
      if (!proposalText) throw new KarlancerApiError('invalid_input', 'proposalText required');
      const p = Number(price);
      const d = Number(days);
      if (!Number.isFinite(p) || p <= 0) throw new KarlancerApiError('invalid_input', 'price required');
      if (!Number.isFinite(d) || d <= 0) throw new KarlancerApiError('invalid_input', 'days required');

      const contract = getVerifiedMutation('bids.submit');
      const opId =
        operationId ||
        bidIdempotencyKey({
          projectId,
          proposalText,
          price: p,
          days: d,
          contractVersion: contract?.contractVersion || 'none',
        });

      if (!contract) {
        return {
          ok: false,
          status: 'blocked_by_missing_api',
          reason: 'definitive_bid_endpoint_unverified',
          posted: false,
          operationId: opId,
          hint: 'Capture authenticated HAR with 2xx bid POST; register VerifiedMutationContract. See docs/HAR_CAPTURE.md',
        };
      }

      return executeVerifiedMutation(client, 'bids.submit', {
        operationId: opId,
        pathParams: { projectId },
        payload: {
          project_id: Number(projectId) || projectId,
          bid_id: null,
          is_pin: false,
          is_highlight: false,
          is_multi: false,
          description: String(proposalText),
          edit_cart_id: null,
          milestones: [
            {
              description: '',
              duration: String(d),
              budget: String(p),
            },
          ],
        },
      });
    },

    /**
     * READ-ONLY: the owner's own bids (verified live: GET /api/bids?page=N, Laravel page of 10).
     * Amount = sum of milestone budgets (Toman), days = bid duration.
     */
    async listMine({ page = 1 } = {}) {
      const res = await client.get(`/api/bids?page=${Number(page) || 1}`);
      const root = res.data?.data || {};
      const list = Array.isArray(root.data) ? root.data : [];
      return {
        bids: list.map(normalizeMyBid).filter(Boolean),
        pagination: {
          currentPage: root.current_page ?? null,
          lastPage: root.last_page ?? null,
          perPage: root.per_page ?? null,
          total: root.total ?? null,
        },
      };
    },

    idempotencyKey(args) {
      return bidIdempotencyKey(args);
    },
  };
}

export function normalizeMyBid(b) {
  if (!b || typeof b !== 'object') return null;
  const ms = Array.isArray(b.milestones) ? b.milestones : [];
  const msSum = ms.reduce((a, m) => a + (Number(m?.budget) || 0), 0);
  const msDays = ms.reduce((a, m) => a + (Number(m?.duration) || 0), 0);
  const p = b.project || {};
  return {
    id: b.id != null ? String(b.id) : null,
    projectId: b.project_id != null ? String(b.project_id) : p.id != null ? String(p.id) : null,
    amount: msSum > 0 ? msSum : Number(b.budget) || null,
    days: Number(b.duration) || msDays || null,
    status: b.status || null,
    createdAt: b.created_at || null,
    project: {
      id: p.id != null ? String(p.id) : null,
      title: p.title || null,
      description: p.description || null,
      status: p.status || null,
      minBudget: p.min_budget ?? null,
      maxBudget: p.max_budget ?? null,
      jobDuration: p.job_duration ?? null,
      slug: p.url || null,
      skills: (Array.isArray(p.skills) ? p.skills : [])
        .map((x) => (x && typeof x === 'object' ? x.display || x.name || null : x))
        .filter(Boolean)
        .map(String),
    },
  };
}

function extractPagination(payload) {
  const meta = payload?.data?.meta || payload?.meta || payload?.data || {};
  return {
    currentPage: meta.current_page ?? meta.page ?? null,
    lastPage: meta.last_page ?? meta.total_pages ?? null,
    perPage: meta.per_page ?? null,
    total: meta.total ?? null,
  };
}
