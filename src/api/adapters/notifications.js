/** Notifications — HAR GET /api/notifications/; mark-read is mutation-gated */
import { normalizeNotification } from '../models/notification.js';
import {
  executeVerifiedMutation,
  getVerifiedMutation,
} from '../contracts/verified-mutation.js';
import { extractLaravelPage } from '../util/pagination.js';

export function createNotificationsAdapter(client) {
  return {
    async list({ page = 1 } = {}) {
      const res = await client.get(`/api/notifications/?page=${Number(page) || 1}`);
      const { items, pagination } = extractLaravelPage(res.data, ['notifications', 'data']);
      // Some envelopes nest under data.notifications
      let list = items;
      if (!list.length) {
        const nested = res.data?.data?.notifications || res.data?.data?.data;
        if (Array.isArray(nested)) list = nested;
      }
      return {
        page: Number(page) || 1,
        notifications: list.map(normalizeNotification).filter(Boolean),
        pagination,
        raw: res.data,
      };
    },

    /**
     * Mark notifications read — ONLY via VerifiedMutationContract.
     * HAR evidence: POST /api/notifications/read { notifications: string[] } → 200
     * Not auto-enabled (auth headers stripped from HAR export).
     */
    async markRead(notificationIds, { operationId } = {}) {
      const ids = (Array.isArray(notificationIds) ? notificationIds : [notificationIds])
        .filter(Boolean)
        .map(String);
      const contract = getVerifiedMutation('notifications.mark_read');
      const opId = operationId || `notif-read:${ids.slice(0, 5).join(',')}:${Date.now()}`;
      if (!contract) {
        return {
          ok: false,
          status: 'blocked_by_missing_api',
          reason: 'notifications_mark_read_unverified',
          posted: false,
          operationId: opId,
          hint: 'HAR shows POST /api/notifications/read but Authorization headers were stripped; register VerifiedMutationContract locally after confirming Bearer auth.',
        };
      }
      return executeVerifiedMutation(client, 'notifications.mark_read', {
        operationId: opId,
        pathParams: {},
        payload: { notifications: ids },
      });
    },
  };
}
