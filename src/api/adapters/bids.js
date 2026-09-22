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

    idempotencyKey(args) {
      return bidIdempotencyKey(args);
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
